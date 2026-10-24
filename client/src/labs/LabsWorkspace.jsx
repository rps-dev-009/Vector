/**
 * LabsWorkspace — document canvas + assistant, split by a real resizer.
 *
 * Owns the Tiptap editor (one per project — the component is keyed by project
 * id), the agent client, the edit applier, the review store and the review
 * decorations. Persistence flows up through props (useLabsProjects).
 *
 * Layout contract:
 *   root    flex h-full min-h-0 flex-col
 *   split   flex min-h-0 flex-1
 *   editor  flex-1 min-w-0  (its own min-h-0 chain inside EditorPane)
 *   handle  .labs-resizer (pointer events, container-rect based)
 *   panel   shrink-0 min-w-0 flex (a real flex box, so the pane can bound
 *           its scroll container — this is why the chat scrolls)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "@tiptap/react";
import { closeHistory } from "@tiptap/pm/history";
import { NodeSelection } from "@tiptap/pm/state";
import { AlertTriangle, PanelLeftClose, Sparkles, X } from "lucide-react";
import { cn } from "../utils/cn.js";
import { buildLabsExtensions } from "./extensions/buildExtensions.js";
import { ensureBlockIds } from "./extensions/blockId.js";
import { updateReviewDecorations } from "./extensions/reviewDecorations.js";
import { editorToBlocks } from "./bridge/markdown.js";
import { generateClientBlockId } from "./constants/palette.js";
import { applyEditEvents, createApplyContext, restoreEntries } from "./applyEdit.js";
import { createReviewStore } from "./reviewStore.js";
import { useLabsAgent } from "./hooks/useLabsAgent.js";
import EditorPane from "./EditorPane.jsx";
import AssistantPane from "./AssistantPane.jsx";
import { DOCUMENT_STYLE_ID } from "./styles.js";
import { useLabsImages } from "./hooks/useLabsImages.js";
import { IMAGE_ONLY_INSTRUCTION, imageForRequest, imageMetadata, imageHistory, rememberImages } from "./imageAttachments.js";
import ThinkingSelector from "../components/ThinkingSelector.jsx";

const ASSISTANT_MIN = 320;
const ASSISTANT_MAX = 720;
const ASSISTANT_DEFAULT = 400;
// The document pane never goes below this; the assistant's max width is
// whichever is smaller, ASSISTANT_MAX or (container - EDITOR_MIN).
const EDITOR_MIN = 360;
const WIDTH_KEY = "labs_assistant_width";

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/** Largest assistant width this container can host without squeezing. */
function maxAssistantWidth(containerWidth) {
  if (!containerWidth) return ASSISTANT_MAX;
  return Math.max(ASSISTANT_MIN, Math.min(ASSISTANT_MAX, containerWidth - EDITOR_MIN));
}

function emptyRun() {
  return {
    status: "idle",
    steps: [],
    liveText: "",
    error: null,
    done: null,
    review: [],
    skipped: [],
    usage: {},
    ops: { inserts: 0, replaces: 0, deletes: 0, attrs: 0 }
  };
}

/** Blocks touched by a user transaction (typing = usually one step). */
function changedBlockIds(tr) {
  const ids = new Set();
  if (!tr.docChanged) return ids;
  let min = Infinity;
  let max = -Infinity;
  for (const step of tr.steps) {
    if (typeof step.from === "number") min = Math.min(min, step.from);
    if (typeof step.to === "number") max = Math.max(max, step.to);
  }
  if (min === Infinity || max === -1) return ids;
  tr.doc.nodesBetween(min, Math.min(max, tr.doc.content.size), (node) => {
    if (node.attrs?.blockId) ids.add(node.attrs.blockId);
  });
  return ids;
}

/** Separate AI edits from manual editing; streamed batches may span undo groups. */
function closeHistoryGroup(editor) {
  editor.view.dispatch(closeHistory(editor.state.tr).setMeta("addToHistory", false));
}

function captureSelection(editor) {
  const selected = editor.state.selection;
  if (selected instanceof NodeSelection && selected.node.type.name === "spacer") {
    const id = selected.node.attrs.blockId;
    return id ? { blockIds: [id], text: "", label: "Blank space" } : null;
  }
  const { from, to, empty } = selected;
  if (empty || to - from < 3) return null;
  const text = editor.state.doc.textBetween(from, to, "\n");
  const blockIds = [];
  editor.state.doc.forEach((node, pos) => {
    if (pos < to && pos + node.nodeSize > from && node.attrs?.blockId) {
      blockIds.push(node.attrs.blockId);
    }
  });
  if (blockIds.length === 0 || !text.trim()) return null;
  return { blockIds, text };
}

export default function LabsWorkspace({
  activeProject,
  models = [],
  modelsError,
  selectedModel,
  thinkingLevel,
  onSelectModel,
  onThinkingLevelChange,
  onUpdateContent,
  onAppendChat,
  storageStatus,
  onSaveStatusChange,
  assistantOpen,
  onToggleAssistant,
  isMobile,
  mobileTab,
  onReviewCountChange,
  onEditorReady
}) {
  const needsMigration =
    activeProject?.content == null && (activeProject?.document || "").trim() !== "";

  const [instruction, setInstruction] = useState("");
  const [selection, setSelection] = useState(null);
  const imageDraft = useLabsImages();
  const [imageCache, setImageCache] = useState(() => new Map());
  const lastRequestRef = useRef(null);
  // Continue retains the original task, independently of attachment recovery.
  const taskRef = useRef(null);
  const [assistantWidth, setAssistantWidth] = useState(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    return saved ? clamp(saved, ASSISTANT_MIN, ASSISTANT_MAX) : ASSISTANT_DEFAULT;
  });
  const [dragging, setDragging] = useState(false);
  const [storageBannerDismissed, setStorageBannerDismissed] = useState(false);
  const [reviewError, setReviewError] = useState("");

  const splitRef = useRef(null);
  const reviewStoreRef = useRef(createReviewStore());
  const applyCtxRef = useRef(createApplyContext());
  const saveTimerRef = useRef(null);
  const savePendingRef = useRef(false);
  const runRef = useRef(emptyRun());
  const [, setRunTick] = useState(0);
  const updateRun = useCallback((mutate) => {
    mutate(runRef.current);
    setRunTick((t) => t + 1);
  }, []);

  /* Pending review map (blockId -> "added" | "modified") for decorations and
     the on-block Keep/Reject control. */
  const [pending, setPending] = useState(() => new Map());

  /* ── Editor (recreated per project via the key prop from LabsArea) ── */
  const extensions = useMemo(() => buildLabsExtensions(), []);
  const initialContent = useMemo(() => {
    if (needsMigration) return activeProject.document;
    return activeProject?.content || { type: "doc", content: [{ type: "paragraph" }] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const migrateRef = useRef(needsMigration);
  const sourceDocRef = useRef(activeProject?.document);
  const pendingSnapshot = useRef(null);

  const editor = useEditor({
    extensions,
    content: initialContent,
    ...(migrateRef.current ? { contentType: "markdown" } : {}),
    editorProps: { attributes: { spellcheck: "true" } },
    onCreate: ({ editor }) => {
      ensureBlockIds(editor);
      if (migrateRef.current) {
        // One-time Markdown -> content migration; the original string is
        // preserved untouched (stored as documentSource).
        onUpdateContent(editor.getJSON(), editor.getMarkdown(), {
          documentSource: sourceDocRef.current
        });
      }
    },
    onUpdate: ({ editor, transaction }) => {
      handleEditorUpdate(editor, transaction);
    }
  });

  /* ── Saving (debounced, honest status) ── */
  const handleEditorUpdate = (ed, transaction) => {
    pendingSnapshot.current = { content: ed.getJSON(), markdown: ed.getMarkdown() };
    const isLabsEdit = transaction.getMeta("labsEdit");

    if (!isLabsEdit) {
      // A manual edit inside a highlighted block counts as Keep for it.
      const touched = changedBlockIds(transaction);
      const stillPending = new Set(reviewStoreRef.current.pendingEntries().map(entry => entry.blockId));
      let keptAny = false;
      for (const id of touched) {
        if (stillPending.has(id)) {
          reviewStoreRef.current.keep(id);
          keptAny = true;
        }
      }
      if (keptAny) refreshReview(ed);
    }

    // ANY doc change (user typing or agent edits) schedules the save.
    onSaveStatusChange("unsaved");
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      if (!ed || ed.isDestroyed) return;
      onSaveStatusChange("saving");
      savePendingRef.current = true;
      onUpdateContent(ed.getJSON(), ed.getMarkdown());
      pendingSnapshot.current = null;
    }, 500);
  };

  // Turn "saving" into "saved"/"error" once the write lands.
  useEffect(() => {
    if (savePendingRef.current) {
      savePendingRef.current = false;
      onSaveStatusChange(storageStatus === "full" ? "error" : "saved");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.updatedAt, storageStatus]);

  useEffect(() => {
    onEditorReady?.(editor);
    return () => onEditorReady?.(null);
  }, [editor, onEditorReady]);

  useEffect(() => () => {
    clearTimeout(saveTimerRef.current);
    const snapshot = pendingSnapshot.current;
    if (snapshot) onUpdateContent(snapshot.content, snapshot.markdown);
  }, []);

  /* ── Review helpers ── */
  const refreshReview = (ed) => {
    if (!ed || ed.isDestroyed) return;
    const entries = reviewStoreRef.current.pendingEntries();
    const map = new Map(
      entries.map((e) => [e.blockId, e.before == null ? "added" : "modified"])
    );
    setPending(map);
    updateRun((r) => {
      r.review = entries;
      r.skipped = [...applyCtxRef.current.skipped];
      r.usage = { ...applyCtxRef.current.usage };
    });
    onReviewCountChange?.(entries.length);
    updateReviewDecorations(ed, new Map(entries.map((e) => [e.blockId, { before: e.before }])));
  };

  /* ── Agent run ── */
  const finalizeRun = () => {
    if (editor && !editor.isDestroyed) {
      closeHistoryGroup(editor);
      editor.setEditable(true);
      refreshReview(editor);
    }
  };

  const agent = useLabsAgent({
    onImageReceipt: ({ count }) => updateRun(r => { r.imageCount = count; }),
    onActivity: (data) => {
      reviewStoreRef.current.addActivity(data);
      updateRun((r) => {
        r.steps = [...r.steps, { ...data, at: Date.now() }];
      });
    },
    onEditBatch: (batch) => {
      if (!editor || editor.isDestroyed) return;
      applyEditEvents(editor, batch, applyCtxRef.current, {
        onBeforeEdit: (event, info) => reviewStoreRef.current.captureBeforeEdit(event, info)
      });
      for (const event of batch) reviewStoreRef.current.recordEdit(editor, event);
      updateRun((r) => {
        for (const e of batch) {
          if (e.op === "insert") r.ops.inserts += 1;
          else if (e.op === "delete") r.ops.deletes += 1;
          else if (e.op === "set_attrs" || e.op === "set_document_style") r.ops.attrs += 1;
          else r.ops.replaces += 1;
        }
      });
      refreshReview(editor);
    },
    onToken: (data) => {
      updateRun((r) => {
        r.liveText = (r.liveText || "") + (data.text || "");
      });
    },
    onError: (err) => {
      if (lastRequestRef.current?.images.length) {
        imageDraft.restore(lastRequestRef.current.images);
        setInstruction(lastRequestRef.current.text);
      }
      reviewStoreRef.current.finishRun(editor, null, "error");
      updateRun((r) => {
        r.status = "error";
        r.error = err;
        r.liveText = "";
      });
      finalizeRun();
    },
    onDone: (done) => {
      reviewStoreRef.current.finishRun(editor, done, "done");
      const summary = (done?.summary || "").trim();
      updateRun((r) => {
        r.status = done?.ok === false ? "error" : "done";
        r.done = done;
        // The summary becomes a chat message; don't show it twice.
        r.liveText = "";
      });
      if (done?.ok !== false) lastRequestRef.current = null;
      if (summary) {
        onAppendChat([
          {
            id: crypto.randomUUID(),
            role: "assistant",
            text: summary,
            run: {
              status: "done",
              editCount: done.editCount,
              steps: done.steps,
              warnings: done.warnings || []
            }
          }
        ]);
      }
      finalizeRun();
    },
    onAbort: () => {
      if (lastRequestRef.current?.images.length) {
        imageDraft.restore(lastRequestRef.current.images);
        setInstruction(lastRequestRef.current.text);
      }
      reviewStoreRef.current.finishRun(editor, null, "aborted");
      updateRun((r) => {
        r.status = "aborted";
        r.liveText = "";
      });
      // Edits applied before the Stop stay reviewable.
      finalizeRun();
    }
  });

  const send = useCallback(
    (text, selectionOverride, attachedImages = [], continuation) => {
      if (!editor || editor.isDestroyed || agent.isRunning || imageDraft.preparing || (!text.trim() && !attachedImages.length)) return;
      const requestText = text.trim() ? text : IMAGE_ONLY_INSTRUCTION;
      const history = imageHistory(activeProject.chat || [], imageCache, attachedImages);
      lastRequestRef.current = { text, images: attachedImages };
      const sel = selectionOverride === undefined ? captureSelection(editor) : selectionOverride;
      const requestSelection = sel ? { blockIds: [...sel.blockIds], text: sel.text } : null;
      if (continuation === undefined) {
        // Pin the original image context even after its chat messages age out.
        taskRef.current = { instruction: requestText, selection: requestSelection, images: [
          ...attachedImages,
          ...history.flatMap(message => message.images || []).map(image => imageCache.get(image.id))
        ] };
      }
      applyCtxRef.current = createApplyContext();
      ensureBlockIds(editor);
      reviewStoreRef.current.startRun(editor);
      closeHistoryGroup(editor);
      editor.setEditable(false);

      runRef.current = { ...emptyRun(), status: "active" };
      setReviewError("");
      refreshReview(editor);
      setRunTick((t) => t + 1);
      setInstruction("");
      setSelection(null);
      if (attachedImages.length) {
        setImageCache(previous => rememberImages(previous, attachedImages));
        imageDraft.clear();
      }

      onAppendChat([{ id: crypto.randomUUID(), role: "user", text: requestText,
        ...(attachedImages.length ? { images: attachedImages.map(imageMetadata) } : {}) }]);

      agent.start(() => ({
        projectId: activeProject.id,
        modelId: selectedModel?.id,
        thinkingLevel: thinkingLevel || undefined,
        blocks: editorToBlocks(editor.getJSON(), (used) => generateClientBlockId(used)),
        documentStyle: editor.state.doc.attrs.documentStyle,
        instruction: requestText,
        images: attachedImages.map(imageForRequest),
        messages: history,
        selection: requestSelection,
        ...(continuation === undefined ? {} : { continuation })
      }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, agent, activeProject, onAppendChat, imageCache, imageDraft, selectedModel, thinkingLevel]
  );

  /* ── Review actions ── */
  const canReview = () => editor && !editor.isDestroyed && !agent.isRunning && runRef.current.status !== "active";
  const keepBlock = (blockId) => {
    if (!canReview()) return false;
    if (!reviewStoreRef.current.pendingEntries().some(entry => entry.blockId === blockId)) return false;
    reviewStoreRef.current.keep(blockId);
    updateRun(r => { r.reviewFeedback = "Accepted this change"; });
    setReviewError("");
    refreshReview(editor);
    return true;
  };

  const reject = (entries) => {
    if (!canReview() || !entries.length) return false;
    if (!restoreEntries(editor, entries)) {
      updateRun(r => { r.reviewFeedback = ""; });
      setReviewError("Could not restore the original content. These changes are still pending; nothing has been accepted. Try Reject again or keep the changes explicitly.");
      return false;
    }
    for (const entry of entries) reviewStoreRef.current.keep(entry.blockId);
    updateRun(r => { r.reviewFeedback = `Rejected ${entries.length} change${entries.length === 1 ? "" : "s"}`; });
    setReviewError("");
    refreshReview(editor);
    return true;
  };

  const rejectBlock = (blockId) => {
    return reject(reviewStoreRef.current.pendingEntries().filter(e => e.blockId === blockId));
  };

  const keepAll = () => {
    if (!canReview()) return;
    const entries = reviewStoreRef.current.pendingEntries();
    for (const entry of entries) {
      reviewStoreRef.current.keep(entry.blockId);
    }
    updateRun(r => { r.reviewFeedback = `Accepted ${entries.length} change${entries.length === 1 ? "" : "s"}`; });
    setReviewError("");
    refreshReview(editor);
  };

  const rejectAll = () => {
    return reject(reviewStoreRef.current.pendingEntries());
  };

  const jumpToFirstChange = () => {
    const first = runRef.current.review?.[0];
    if (!first || !editor) return;
    if (first.blockId === DOCUMENT_STYLE_ID) {
      editor.view.dom.closest(".labs-canvas")?.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    const el = editor.view?.dom?.querySelector(`[data-block-id="${first.blockId}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  /* ── Selection actions (bubble menu) ── */
  const handleQuickAction = (chipInstruction) => {
    const sel = captureSelection(editor);
    if (!sel) return;
    send(chipInstruction, sel);
  };

  const handleAskAI = () => {
    const sel = captureSelection(editor);
    if (sel) setSelection(sel);
  };

  /* ── Resizer: container-rect based, pointer events, clamped, persisted ── */
  const widthFromPointer = useCallback((clientX) => {
    const host = splitRef.current;
    if (!host) return ASSISTANT_DEFAULT;
    const rect = host.getBoundingClientRect();
    return clamp(rect.right - clientX, ASSISTANT_MIN, maxAssistantWidth(host.clientWidth));
  }, []);

  const onHandleDown = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDragging(true);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  };

  const onHandleMove = (e) => {
    if (!dragging) return;
    setAssistantWidth(widthFromPointer(e.clientX));
  };

  const endDrag = (e) => {
    if (!dragging) return;
    e?.currentTarget?.releasePointerCapture?.(e.pointerId);
    setDragging(false);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  };

  useEffect(() => {
    const t = setTimeout(() => localStorage.setItem(WIDTH_KEY, String(Math.round(assistantWidth))), 250);
    return () => clearTimeout(t);
  }, [assistantWidth]);

  // Re-clamp whenever the CONTAINER changes size — opening the app sidebar
  // animates the container width without firing a window resize, which used
  // to leave the assistant too wide and clip the document pane.
  useEffect(() => {
    const host = splitRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[entries.length - 1]?.contentRect?.width;
      if (!width) return;
      setAssistantWidth((w) => clamp(w, ASSISTANT_MIN, maxAssistantWidth(width)));
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [assistantOpen]);

  const run = runRef.current;
  const isRunning = run.status === "active" || agent.isRunning;

  const assistant = (
    <AssistantPane
      modelControls={models.length > 0 ? (
        <div className="grid min-w-0 grid-cols-2 gap-2 border-b border-border px-3 py-2">
          <label className="flex min-w-0 flex-col gap-1 text-[11px] text-muted-foreground">
            <span className="font-semibold uppercase tracking-wider">Model</span>
            <select aria-label="Labs model" value={selectedModel?.id || ""}
              onChange={event => onSelectModel(event.target.value)} disabled={isRunning}
              className="w-full min-w-0 rounded-lg border border-border bg-popover px-2 py-2 text-xs text-foreground disabled:opacity-60">
              {models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
          </label>
          <ThinkingSelector thinking={selectedModel?.thinking} value={thinkingLevel}
            onChange={onThinkingLevelChange} disabled={isRunning} />
        </div>
      ) : modelsError ? <p className="border-b border-border px-3 py-2 text-xs text-destructive">{modelsError}</p> : null}
      chat={activeProject?.chat || []}
      run={run}
      instruction={instruction}
      setInstruction={setInstruction}
      selection={selection}
      clearSelection={() => setSelection(null)}
      onSend={() => send(instruction, selection, imageDraft.images)}
      attachments={imageDraft.images}
      imageCache={imageCache}
      onAddImages={imageDraft.add}
      onRemoveImage={imageDraft.remove}
      imagesPreparing={imageDraft.preparing}
      attachmentError={imageDraft.error}
      onStop={agent.stop}
      onKeepAll={keepAll}
      reviewDisabled={isRunning}
      onRejectAll={rejectAll}
      onJumpToFirstChange={jumpToFirstChange}
      onDismissError={() => updateRun((r) => { r.status = "idle"; r.error = null; })}
      onContinue={() => {
        const task = taskRef.current;
        if (!task) return;
        send(task.instruction, task.selection, task.images, {
          targetWords: run.done?.targetWords ?? null,
          failedOperations: run.done?.failedOperations ?? []
        });
      }}
    />
  );

  const documentPane = (
    <EditorPane
      editor={editor}
      aiActive={isRunning}
      pending={pending}
      onQuickAction={handleQuickAction}
      onAskAI={handleAskAI}
      onKeepBlock={keepBlock}
      onRejectBlock={rejectBlock}
      onManualStyle={ids => {
        for (const id of ids) reviewStoreRef.current.keep(id);
        refreshReview(editor);
      }}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {reviewError && <div role="alert" className="shrink-0 border-b border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive">{reviewError}</div>}
      {storageStatus === "full" && !storageBannerDismissed && (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-400/25 bg-amber-400/10 px-3 py-2 text-xs text-amber-300">
          <AlertTriangle size={13} className="shrink-0" />
          <span className="min-w-0 flex-1">
            Storage is full — your latest changes may not be saved. Export your work now.
          </span>
          <button
            type="button"
            onClick={() => setStorageBannerDismissed(true)}
            className="shrink-0 rounded p-1 hover:bg-amber-400/15"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {isMobile ? (
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className={cn("min-h-0 w-full min-w-0", mobileTab === "document" ? "block" : "hidden")}>
            {documentPane}
          </div>
          <div className={cn("min-h-0 w-full min-w-0", mobileTab === "assistant" ? "block" : "hidden")}>
            {assistant}
          </div>
        </div>
      ) : (
        <div ref={splitRef} className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">{documentPane}</div>

          {assistantOpen ? (
            <>
              <div
                className="labs-resizer"
                data-dragging={dragging ? "true" : "false"}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize assistant"
                onPointerDown={onHandleDown}
                onPointerMove={onHandleMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onDoubleClick={() => setAssistantWidth(ASSISTANT_DEFAULT)}
                onKeyDown={(e) => {
                  const max = maxAssistantWidth(splitRef.current?.clientWidth);
                  if (e.key === "ArrowLeft") setAssistantWidth((w) => clamp(w + 24, ASSISTANT_MIN, max));
                  if (e.key === "ArrowRight") setAssistantWidth((w) => clamp(w - 24, ASSISTANT_MIN, max));
                }}
                tabIndex={0}
                title="Drag to resize · double-click to reset"
              />
              <div
                className="flex min-h-0 min-w-0 shrink-0 overflow-hidden border-l border-border"
                style={{
                  width: Math.round(assistantWidth),
                  // Hard CSS stop: even with stale JS state the pane can never
                  // push the document pane out of the container.
                  maxWidth: `calc(100% - ${EDITOR_MIN}px)`
                }}
              >
                {assistant}
              </div>
            </>
          ) : (
            <div className="flex w-11 shrink-0 flex-col items-center gap-2 border-l border-border bg-card py-2.5">
              <button
                type="button"
                onClick={onToggleAssistant}
                title="Show assistant"
                className="relative rounded-lg p-2 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              >
                <PanelLeftClose size={16} />
              </button>
              <button
                type="button"
                onClick={onToggleAssistant}
                title="Ask the assistant"
                className="relative rounded-lg p-2 text-primary transition-colors hover:bg-primary/10"
              >
                <Sparkles size={16} />
                {(run.review?.length || 0) > 0 && (
                  <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />
                )}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
