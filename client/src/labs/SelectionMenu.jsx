/**
 * SelectionMenu — bubble menu on a text selection: "Ask AI" (attaches the
 * selection to the composer) plus quick actions that send immediately.
 */

import { BubbleMenu } from "@tiptap/react/menus";
import { useEditorState } from "@tiptap/react";
import { Sparkles, X } from "lucide-react";
import { resolveSpacerHeight, STYLE_SPEC } from "./styles.js";

const QUICK_CHIPS = [
  { label: "Fix grammar", instruction: "Fix the grammar and spelling in this selection" },
  { label: "Shorter", instruction: "Make this selection shorter while keeping the key meaning" },
  { label: "Longer", instruction: "Expand this selection with more detail" },
  { label: "Rewrite", instruction: "Rewrite this selection in a clearer, more professional tone" }
];

export default function SelectionMenu({ editor, onQuickAction, onAskAI }) {
  const spacer = useEditorState({ editor, selector: ({ editor: ed }) => {
    const selection = ed?.state.selection;
    return selection?.node?.type.name === "spacer"
      ? { from: selection.from, heightPt: resolveSpacerHeight(selection.node.attrs.heightPt) } : null;
  } });
  if (!editor) return null;
  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: "top", offset: 10 }}
      className="z-40"
      shouldShow={({ editor, from, to }) =>
        !editor.view.state.selection.empty && editor.isEditable &&
        (editor.view.state.selection.node?.type.name === "spacer" || to - from >= 3)
      }
    >
      <div className="labs-bubble flex max-w-[calc(100vw-24px)] flex-wrap items-center gap-0.5 p-1">
        <button
          type="button"
          onClick={() => onAskAI()}
          className="flex items-center gap-1.5 rounded-lg bg-primary/15 px-2.5 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/25"
        >
          <Sparkles size={13} /> Ask AI
        </button>
        <span className="mx-0.5 h-4 w-px bg-border" />
        {spacer ? <>
          <label className="flex items-center gap-1 px-1 text-xs text-muted-foreground">
            Blank space
            <input
              key={`${spacer.from}:${spacer.heightPt}`}
              type="number"
              aria-label="Blank space height in points"
              min={STYLE_SPEC.spacer.minHeightPt}
              max={STYLE_SPEC.spacer.maxHeightPt}
              step="any"
              defaultValue={spacer.heightPt}
              className="w-16 rounded border border-border bg-background px-1 py-1 text-foreground"
              onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }}
              onBlur={event => {
                const heightPt = resolveSpacerHeight(event.currentTarget.valueAsNumber);
                event.currentTarget.value = String(heightPt);
                if (heightPt !== spacer.heightPt) editor.chain().focus().updateAttributes("spacer", { heightPt }).run();
              }}
            />
            pt
          </label>
          <button type="button" className="rounded-lg px-2 py-1.5 text-xs hover:bg-foreground/10"
            onClick={() => editor.chain().focus().updateAttributes("spacer", { heightPt: STYLE_SPEC.spacer.defaultHeightPt }).run()}>
            Reset
          </button>
          <button type="button" className="rounded-lg px-2 py-1.5 text-xs hover:bg-foreground/10"
            onClick={() => editor.chain().focus().deleteSelection().run()}>
            Delete
          </button>
        </> : QUICK_CHIPS.map((chip) => (
          <button
            key={chip.label}
            type="button"
            onClick={() => onQuickAction(chip.instruction)}
            className="whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            {chip.label}
          </button>
        ))}
      </div>
    </BubbleMenu>
  );
}

/**
 * Selection chip rendered above the composer.
 */
export function SelectionChip({ selection, onRemove }) {
  if (!selection) return null;
  const words = (selection.text || "").trim().split(/\s+/);
  const preview = words.slice(0, 7).join(" ") + (words.length > 7 ? "…" : "");
  return (
    <div className="mb-2 flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/10 px-2.5 py-1.5 text-xs text-primary">
      <span className="shrink-0 font-medium">Selection</span>
      <span className="min-w-0 flex-1 truncate italic">{selection.label || (preview ? `“${preview}”` : "Blank space")}</span>
      <button
        type="button"
        onClick={onRemove}
        title="Clear selection"
        className="shrink-0 rounded p-0.5 hover:bg-primary/20"
      >
        <X size={12} />
      </button>
    </div>
  );
}
