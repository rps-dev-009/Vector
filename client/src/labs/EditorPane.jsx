/**
 * EditorPane — the document canvas.
 *
 * The page is centred and typographic; review lives ON the blocks (tinted
 * decorations + a small Keep/Reject control that follows the hovered block),
 * not in a list somewhere else.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { EditorContent, useEditorState } from "@tiptap/react";
import { Check, Undo2 } from "lucide-react";
import Toolbar from "./Toolbar.jsx";
import SelectionMenu from "./SelectionMenu.jsx";
import DocumentDesign from "./DocumentDesign.jsx";
import { documentCssVariables, resolveDocumentStyle, DOCUMENT_STYLE_ID } from "./styles.js";
import "./labs-editor.css";

/**
 * Floating Keep/Reject for the hovered pending block.
 * Positioned against the page element, so it travels with the block while
 * the canvas scrolls.
 */
function BlockReviewActions({ pending, hostRef, onKeep, onReject, disabled }) {
  const [target, setTarget] = useState(null);
  const lastIdRef = useRef(null);

  const measure = useCallback(
    (el, id) => {
      const host = hostRef.current;
      if (!host || !el) return null;
      const r = el.getBoundingClientRect();
      const hr = host.getBoundingClientRect();
      return { id, top: r.top - hr.top, kind: pending.get(id) };
    },
    [hostRef, pending]
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host || pending.size === 0 || disabled) {
      lastIdRef.current = null;
      setTarget(null);
      return;
    }

    const onMove = (ev) => {
      const node = ev.target;
      if (!(node instanceof Element)) return;
      // Stay visible while the pointer is on the control itself.
      if (node.closest("[data-labs-review-actions]")) return;
      const blockEl = node.closest("[data-block-id]");
      const id = blockEl?.getAttribute("data-block-id") || null;
      if (!id || !pending.has(id)) {
        if (lastIdRef.current !== null) {
          lastIdRef.current = null;
          setTarget(null);
        }
        return;
      }
      if (lastIdRef.current === id) return;
      lastIdRef.current = id;
      setTarget(measure(blockEl, id));
    };

    const onLeave = () => {
      lastIdRef.current = null;
      setTarget(null);
    };

    host.addEventListener("mousemove", onMove);
    host.addEventListener("mouseleave", onLeave);
    return () => {
      host.removeEventListener("mousemove", onMove);
      host.removeEventListener("mouseleave", onLeave);
    };
  }, [hostRef, pending, measure, disabled]);

  // A block that stops being pending (or a document change) invalidates it.
  useEffect(() => {
    if (target && !pending.has(target.id)) {
      lastIdRef.current = null;
      setTarget(null);
    }
  }, [pending, target]);

  if (!target || disabled) return null;
  const isNew = target.kind === "added";

  return (
    <div
      data-labs-review-actions
      className="labs-block-actions"
      style={{ top: Math.max(0, target.top - 4), right: 0 }}
      onMouseLeave={() => {
        lastIdRef.current = null;
        setTarget(null);
      }}
    >
      <button
        type="button"
        className="labs-keep"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (onKeep(target.id)) {
            lastIdRef.current = null;
            setTarget(null);
          }
        }}
      >
        <Check size={11} /> Keep
      </button>
      <button
        type="button"
        className="labs-reject"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (onReject(target.id)) {
            lastIdRef.current = null;
            setTarget(null);
          }
        }}
      >
        <Undo2 size={11} /> {isNew ? "Remove" : "Revert"}
      </button>
    </div>
  );
}

export default function EditorPane({
  editor,
  aiActive,
  pending,
  onQuickAction,
  onAskAI,
  onKeepBlock,
  onRejectBlock,
  onManualStyle
}) {
  const pageRef = useRef(null);
  const scrollRef = useRef(null);
  const documentStyle = useEditorState({ editor, selector: ({ editor: ed }) => ed?.state.doc.attrs.documentStyle });
  const theme = resolveDocumentStyle(documentStyle);

  if (!editor) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-background text-sm text-muted-foreground">
        Loading editor…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <DocumentDesign editor={editor} disabled={aiActive} onManualStyle={onManualStyle}
        pendingDocument={pending.has(DOCUMENT_STYLE_ID)} onKeepDocument={() => onKeepBlock(DOCUMENT_STYLE_ID)} onRejectDocument={() => onRejectBlock(DOCUMENT_STYLE_ID)} />
      <Toolbar editor={editor} aiActive={aiActive} />

      <div ref={scrollRef} className="labs-canvas labs-scroll custom-scrollbar min-h-0 flex-1 overflow-y-auto">
        <div ref={pageRef} className="labs-page labs-prose" data-document-theme={theme.preset}
          data-table-variant={theme.tableVariant} style={documentCssVariables(documentStyle)}>
          <div className="labs-paper-label" contentEditable={false}><span>{theme.name}</span><span title="Continuous editing canvas. Use Print / Save PDF to preview page breaks.">Continuous document</span></div>
          <EditorContent editor={editor} />
          <BlockReviewActions
            disabled={aiActive}
            pending={pending}
            hostRef={pageRef}
            onKeep={onKeepBlock}
            onReject={onRejectBlock}
          />
        </div>
      </div>

      <SelectionMenu editor={editor} onQuickAction={onQuickAction} onAskAI={onAskAI} />
    </div>
  );
}
