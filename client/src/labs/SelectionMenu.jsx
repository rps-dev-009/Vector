/**
 * SelectionMenu — bubble menu on a text selection: "Ask AI" (attaches the
 * selection to the composer) plus quick actions that send immediately.
 */

import { BubbleMenu } from "@tiptap/react/menus";
import { Sparkles, X } from "lucide-react";

const QUICK_CHIPS = [
  { label: "Fix grammar", instruction: "Fix the grammar and spelling in this selection" },
  { label: "Shorter", instruction: "Make this selection shorter while keeping the key meaning" },
  { label: "Longer", instruction: "Expand this selection with more detail" },
  { label: "Rewrite", instruction: "Rewrite this selection in a clearer, more professional tone" }
];

export default function SelectionMenu({ editor, onQuickAction, onAskAI }) {
  if (!editor) return null;
  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: "top", offset: 10 }}
      className="z-40"
      shouldShow={({ editor, from, to }) =>
        !editor.view.state.selection.empty && to - from >= 3 && editor.isEditable
      }
    >
      <div className="labs-bubble flex items-center gap-0.5 p-1">
        <button
          type="button"
          onClick={() => onAskAI()}
          className="flex items-center gap-1.5 rounded-lg bg-primary/15 px-2.5 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/25"
        >
          <Sparkles size={13} /> Ask AI
        </button>
        <span className="mx-0.5 h-4 w-px bg-border" />
        {QUICK_CHIPS.map((chip) => (
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
      <span className="min-w-0 flex-1 truncate italic">“{preview}”</span>
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
