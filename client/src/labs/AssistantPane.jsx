/**
 * AssistantPane — chat is the primary control surface.
 *
 * Layout contract (this is what makes it scroll):
 *   root            flex h-full min-h-0 flex-col
 *   messages        flex-1 min-h-0 overflow-y-auto overscroll-contain
 *   review bar      shrink-0
 *   composer        shrink-0 (sticky at the bottom of the pane)
 *
 * The run is ONE status line ("Writing document… 8 blocks") with an
 * expandable step list — never one row per tool call.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Sparkles, Send, Square, Check, RotateCcw, AlertTriangle, ChevronDown,
  Loader2, ArrowDown, FileWarning, Wrench, PauseCircle, PlayCircle, Paperclip, Image as ImageIcon, X
} from "lucide-react";
import { cn } from "../utils/cn.js";
import { SelectionChip } from "./SelectionMenu.jsx";
import { IMAGE_LIMITS } from "./imageAttachments.js";

const EMPTY_IMAGES = [];
const EMPTY_IMAGE_CACHE = new Map();

/* ── One-line run status ──────────────────────────────────────────────────── */

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Collapse a whole tool trace into one honest sentence.
 * Reads the applied-op counters first (what actually happened to the
 * document) and falls back to the latest activity label.
 */
function statusLabel(run, isRunning) {
  const ops = run.ops || {};
  const inserts = ops.inserts || 0;
  const changes = (ops.replaces || 0) + (ops.deletes || 0) + (ops.attrs || 0);
  const total = inserts + changes;
  const last = run.steps?.length ? run.steps[run.steps.length - 1].label : null;

  if (isRunning) {
    if (total === 0) return last || "Thinking…";
    if (inserts > 0 && changes === 0) return `Writing document… ${plural(inserts, "block")}`;
    if (inserts > 0) return `Editing document… ${plural(total, "change")}`;
    return `Editing document… ${plural(changes, "change")}`;
  }
  if (run.reviewFeedback) return run.reviewFeedback;
  if (run.status === "aborted") return total > 0 ? `Stopped after ${plural(total, "change")}` : "Stopped";
  if (run.status === "error") return total > 0 ? `Failed after ${plural(total, "change")}` : "Failed";
  if (run.done?.truncated) {
    return total > 0
      ? `Paused after ${plural(total, "change")} — more work left`
      : "Paused before finishing";
  }
  if (total === 0) return "No changes";
  if (inserts > 0 && changes === 0) return `Wrote ${plural(inserts, "block")}`;
  return `Applied ${plural(total, "change")}`;
}

function RunStatus({ run, isRunning }) {
  const [open, setOpen] = useState(false);
  const steps = run.steps || [];
  const hasDetails = steps.length > 0;
  const done = run.done;

  return (
    <div className="labs-status overflow-hidden" data-live={isRunning ? "true" : "false"}>
      {isRunning && <div className="labs-sweep" />}
      <button
        type="button"
        onClick={() => hasDetails && setOpen((o) => !o)}
        disabled={!hasDetails}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-2 text-left",
          hasDetails && "hover:bg-foreground/10"
        )}
      >
        {isRunning ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-primary" />
        ) : run.status === "error" ? (
          <AlertTriangle size={12} className="shrink-0 text-destructive" />
        ) : done?.truncated ? (
          <PauseCircle size={12} className="shrink-0 text-amber-400" />
        ) : (
          <Check size={12} className="shrink-0 text-emerald-500" />
        )}
        <span className={cn("min-w-0 flex-1 truncate text-xs", isRunning ? "text-primary" : "text-muted-foreground")}>
          {statusLabel(run, isRunning)}
        </span>
        {run.imageCount > 0 && <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground" title="Image attachments confirmed by the server for Gemini">
          <ImageIcon size={11} /> {plural(run.imageCount, "image")}
        </span>}
        {!isRunning && done?.steps > 0 && (
          <span className="shrink-0 text-[10px] text-muted-foreground/60">{plural(done.steps, "step")}</span>
        )}
        {hasDetails && (
          <ChevronDown
            size={12}
            className={cn("shrink-0 text-muted-foreground/60 transition-transform", open && "rotate-180")}
          />
        )}
      </button>

      <AnimatePresence initial={false}>
        {open && hasDetails && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.16 }}
            className="labs-status-steps overflow-hidden"
          >
            <ol className="max-h-56 space-y-0.5 overflow-y-auto custom-scrollbar px-2.5 py-2">
              {steps.map((step, i) => (
                <li key={`${step.at || 0}-${i}`} className="flex items-center gap-2">
                  <span className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground/50" />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{step.label}</span>
                  {step.tool && (
                    <span className="shrink-0 rounded bg-foreground/5 px-1 py-0.5 font-mono text-[9px] text-muted-foreground/70">
                      {step.tool}
                    </span>
                  )}
                </li>
              ))}
            </ol>
            {done && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/60 px-2.5 py-1.5 text-[10px] text-muted-foreground/70">
                <span>{plural(done.editCount || 0, "edit")}</span>
                <span className="text-border">·</span>
                <span>{done.toolCalls || 0} tool calls</span>
                {done.usage && (
                  <>
                    <span className="text-border">·</span>
                    <span title="input/output tokens">
                      {done.usage.inputTokens ?? 0}/{done.usage.outputTokens ?? 0} tok
                    </span>
                  </>
                )}
                {done.repairs && Object.values(done.repairs).some((n) => n > 0) && (
                  <>
                    <span className="text-border">·</span>
                    <span className="flex items-center gap-1" title="auto-repairs applied by the server">
                      <Wrench size={9} />
                      {Object.entries(done.repairs).filter(([, n]) => n > 0).map(([k, n]) => `${n}× ${k}`).join(", ")}
                    </span>
                  </>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── Errors ───────────────────────────────────────────────────────────────── */

function ErrorCard({ error, onRetry }) {
  const [countdown, setCountdown] = useState(null);

  useEffect(() => {
    if (error?.code !== "rate_limit" || !error.retryAfterSeconds) {
      setCountdown(null);
      return;
    }
    setCountdown(error.retryAfterSeconds);
    const timer = setInterval(() => setCountdown((c) => (c && c > 1 ? c - 1 : null)), 1000);
    return () => clearInterval(timer);
  }, [error]);

  if (!error) return null;
  const isRate = error.code === "rate_limit";
  return (
    <div
      className={cn(
        "shrink-0 border-t px-3 py-2.5 text-xs",
        isRate
          ? "border-amber-400/25 bg-amber-400/10 text-amber-300"
          : "border-destructive/25 bg-destructive/10 text-destructive"
      )}
    >
      <div className="flex items-center gap-2">
        <AlertTriangle size={13} className="shrink-0" />
        <span className="min-w-0 flex-1">
          {isRate
            ? `The AI is busy right now.${countdown ? ` Try again in ${countdown}s.` : " Try again in a few seconds."}`
            : error.code === "auth"
            ? "AI is not configured — set GEMINI_API_KEY on the server."
            : error.message}
        </span>
        {(error.recoverable || isRate) && (
          <button
            type="button"
            onClick={onRetry}
            className="flex shrink-0 items-center gap-1 rounded-lg bg-foreground/10 px-2 py-1 text-foreground hover:bg-foreground/15"
          >
            <RotateCcw size={11} /> Dismiss
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Pane ─────────────────────────────────────────────────────────────────── */

export default function AssistantPane({
  modelControls,
  chat,
  run,
  instruction,
  setInstruction,
  selection,
  clearSelection,
  onSend,
  onStop,
  onKeepAll,
  onRejectAll,
  onJumpToFirstChange,
  onDismissError,
  onContinue,
  attachments = EMPTY_IMAGES,
  imageCache = EMPTY_IMAGE_CACHE,
  onAddImages,
  onRemoveImage,
  imagesPreparing = false,
  attachmentError = "",
  reviewDisabled = false
}) {
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const nearBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const isRunning = run.status === "active";
  const canSend = !isRunning && !imagesPreparing && (instruction.trim() || attachments.length > 0);
  const reviewCount = run.review?.length || 0;
  const showStatus = isRunning || (run.steps?.length || 0) > 0 || run.status === "error" || !!run.reviewFeedback;

  /* Auto-scroll ONLY when the user is already near the bottom. */
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    nearBottomRef.current = distance < 120;
    setShowJump(distance > 240);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !nearBottomRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [chat.length, run.steps?.length, run.liveText, reviewCount, run.status]);

  useEffect(() => {
    if (selection) inputRef.current?.focus();
  }, [selection]);

  /* Grow the composer with its content, up to a cap. */
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [instruction]);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent?.isComposing) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  const handlePaste = e => {
    const files = Array.from(e.clipboardData?.items || [])
      .filter(item => item.kind === "file").map(item => item.getAsFile()).filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    if (!isRunning && !imagesPreparing) onAddImages?.(files);
  };

  return (
    <div className="labs-assistant relative flex h-full min-h-0 w-full flex-col">
      <div className="shrink-0">{modelControls}</div>
      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="labs-assistant-messages labs-scroll custom-scrollbar min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3"
      >
        {chat.length === 0 && !isRunning && (
          <div className="flex h-full flex-col items-center justify-center px-5 text-center">
            <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15">
              <Sparkles size={18} className="text-primary" />
            </span>
            <p className="text-sm font-medium text-foreground">Edit by asking</p>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              Describe what you want and the document changes while you watch.
            </p>
            <div className="mt-4 flex w-full flex-col gap-1.5">
              {[
                "Write a one-page project brief",
                "Make the introduction shorter",
                "Fix the grammar throughout"
              ].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setInstruction(s)}
                  className="rounded-lg border border-border px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:border-primary/35 hover:bg-primary/10 hover:text-foreground"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {chat.map((m) => (
          <div key={m.id} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "max-w-[88%] whitespace-pre-wrap break-words px-3 py-2 text-[13px] leading-relaxed",
                m.role === "user"
                  ? "rounded-2xl rounded-br-md bg-primary/15 text-foreground"
                  : "rounded-2xl rounded-bl-md bg-foreground/10 text-foreground/90"
              )}
            >
              {m.images?.length > 0 && <div className="mb-2 flex flex-wrap gap-2">
                {m.images.map(image => {
                  const cached = imageCache.get(image.id);
                  return <div key={image.id} className="max-w-full rounded-lg border border-border p-1" title={cached ? image.name : `${image.name} - reattach this image to inspect it again`}>
                    {cached ? <img src={cached.preview} alt={image.name} className="h-20 max-w-[160px] rounded object-contain" onLoad={() => {
                      const el = scrollRef.current;
                      if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
                    }} /> : <ImageIcon size={20} className="m-2 text-muted-foreground" />}
                    <span className="block max-w-[160px] truncate px-1 text-[10px] text-muted-foreground">{image.name}</span>
                    {!cached && <span className="block px-1 text-[9px] text-muted-foreground">Reattach to inspect again</span>}
                  </div>;
                })}
              </div>}
              {m.text}
            </div>
          </div>
        ))}

        {/* Streaming assistant text (arrives at the end of the run) */}
        {isRunning && run.liveText && (
          <div className="flex justify-start">
            <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md bg-foreground/10 px-3 py-2 text-[13px] leading-relaxed text-foreground/90">
              {run.liveText}
            </div>
          </div>
        )}

        {/* ONE status line for the whole run */}
        {showStatus && <RunStatus run={run} isRunning={isRunning} />}

        {/* The agent ran out of step budget mid-task: offer to finish it. */}
        {!isRunning && run.done?.truncated && (
          <div className="rounded-xl border border-amber-400/25 bg-amber-400/10 px-2.5 py-2 text-[11px] text-amber-300">
            <p className="leading-relaxed">
              The assistant used all {run.done.maxSteps || "its"} steps before finishing, so part of
              the work is still missing.
            </p>
            <button
              type="button"
              onClick={onContinue}
              className="mt-1.5 flex items-center gap-1.5 rounded-lg bg-amber-400/15 px-2 py-1 font-medium text-amber-200 transition-colors hover:bg-amber-400/25"
            >
              <PlayCircle size={12} /> Continue the work
            </button>
          </div>
        )}

        {/* Edits the client could not apply */}
        {run.skipped?.length > 0 && (
          <div className="rounded-xl border border-amber-400/25 bg-amber-400/10 px-2.5 py-2 text-[11px] text-amber-300">
            <div className="flex items-center gap-1.5 font-medium">
              <FileWarning size={11} /> {plural(run.skipped.length, "edit")} could not be applied
            </div>
          </div>
        )}
      </div>

      {/* Jump to latest */}
      <AnimatePresence>
        {showJump && (
          <motion.button
            type="button"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            onClick={() => {
              const el = scrollRef.current;
              nearBottomRef.current = true;
              el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
            }}
            className="pointer-events-auto absolute bottom-24 left-1/2 z-20 -translate-x-1/2 rounded-full border border-border bg-popover p-1.5 text-muted-foreground shadow-lg hover:text-foreground"
            title="Jump to latest"
          >
            <ArrowDown size={14} />
          </motion.button>
        )}
      </AnimatePresence>

      {/* Review bar — the only review chrome in the pane */}
      <AnimatePresence initial={false}>
        {reviewCount > 0 && !isRunning && !reviewDisabled && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.16 }}
            className="shrink-0 overflow-hidden border-t border-primary/20 bg-primary/10"
          >
            <div className="flex items-center gap-2 px-3 py-2">
              <button
                type="button"
                onClick={onJumpToFirstChange}
                className="min-w-0 flex-1 truncate text-left text-xs font-medium text-primary hover:underline"
                title="Jump to the first change"
              >
                {plural(reviewCount, "change")} to review
              </button>
              <button
                type="button"
                onClick={onKeepAll}
                title="Keep the AI changes and clear their highlights"
                className="flex shrink-0 items-center gap-1 rounded-lg bg-foreground/10 px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-emerald-500/20 hover:text-emerald-400"
              >
                <Check size={11} /> Accept all
              </button>
              <button
                type="button"
                onClick={onRejectAll}
                title="Restore the original content and remove AI additions"
                className="flex shrink-0 items-center gap-1 rounded-lg bg-foreground/10 px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-red-500/20 hover:text-red-400"
              >
                <RotateCcw size={11} /> Reject all
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <ErrorCard error={run.status === "error" ? run.error : null} onRetry={onDismissError} />

      {/* Composer */}
      <div className="shrink-0 border-t border-border p-2.5"
        onDragOver={e => { if (Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault(); }}
        onDrop={e => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          if (!isRunning && !imagesPreparing) onAddImages?.(e.dataTransfer.files);
        }}>
        <SelectionChip selection={selection} onRemove={clearSelection} />
        <input ref={fileInputRef} type="file" accept={IMAGE_LIMITS.mediaTypes.join(",")} multiple hidden
          aria-label="Choose images to attach" disabled={isRunning || imagesPreparing}
          onChange={e => { onAddImages?.(e.target.files); e.target.value = ""; }} />
        {attachments.length > 0 && <div className="mb-2 flex gap-2 overflow-x-auto" aria-label="Attached images">
          {attachments.map(image => <div key={image.id} className="relative w-20 shrink-0 rounded-lg border border-border bg-background p-1">
            <img src={image.preview} alt={image.name} className="h-16 w-full rounded object-contain" />
            <span className="block truncate text-[10px] text-muted-foreground" title={image.name}>{image.name}</span>
            <button type="button" aria-label={`Remove ${image.name}`} disabled={isRunning || imagesPreparing} onClick={() => onRemoveImage?.(image.id)} className="absolute right-0.5 top-0.5 rounded-full border border-border bg-background p-1 text-foreground hover:bg-secondary disabled:opacity-50"><X size={11} /></button>
          </div>)}
        </div>}
        {attachmentError && <p role="alert" className="mb-2 text-xs text-destructive">{attachmentError}</p>}
        {imagesPreparing && <p role="status" className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 size={12} className="animate-spin" /> Preparing images...</p>}
        <div className="rounded-xl border border-[var(--input-border)] bg-[var(--input-surface)] transition-colors focus-within:border-[var(--input-border-focus)]">
          <div className="flex items-end gap-2 px-2.5 py-2">
            <button type="button" onClick={() => fileInputRef.current?.click()}
              disabled={isRunning || imagesPreparing || attachments.length >= IMAGE_LIMITS.maxCount}
              title="Attach images (PNG, JPEG, WebP). You can also paste or drop them here."
              aria-label="Attach images" className="shrink-0 rounded-lg p-2 text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-40"><Paperclip size={15} /></button>
            <textarea
              ref={inputRef}
              rows={1}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={isRunning ? "Working on your document…" : attachments.length ? "Ask about these images..." : "Ask for an edit…"}
              disabled={isRunning}
              className="labs-scroll custom-scrollbar max-h-[150px] min-h-[24px] flex-1 resize-none bg-transparent py-0.5 text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
            />
            {isRunning ? (
              <button
                type="button"
                onClick={onStop}
                title="Stop — edits already applied stay"
                className="shrink-0 rounded-lg bg-destructive/15 p-2 text-destructive transition-colors hover:bg-destructive/25"
              >
                <Square size={13} />
              </button>
            ) : (
              <button
                type="button"
                onClick={onSend}
                disabled={!canSend}
                title="Send (Enter)"
                className={cn(
                  "shrink-0 rounded-lg p-2 transition-colors",
                  canSend
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "cursor-not-allowed bg-foreground/10 text-muted-foreground/50"
                )}
              >
                <Send size={13} />
              </button>
            )}
          </div>
        </div>
        {(attachments.length > 0 || imageCache.size > 0) && <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">Images are sent to Gemini, optimized to 2048 px. They aren't saved with the project; reattach after reopening. Up to 4 images in context.</p>}
      </div>
    </div>
  );
}
