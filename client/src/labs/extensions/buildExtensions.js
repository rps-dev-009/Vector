/**
 * Extension set for the Labs editor. Kept in one factory so the test harness
 * and the editor pane always build the identical schema.
 *
 * StarterKit v3 already bundles: bold, italic, underline, strike, inline code,
 * link, codeBlock, headings, blockquote, bullet/ordered lists (via
 * @tiptap/extension-list), hardBreak, horizontalRule, undo/redo (UndoRedo),
 * dropcursor, gapcursor, trailingNode.
 */

import StarterKit from "@tiptap/starter-kit";
import { TextStyle, Color, BackgroundColor } from "@tiptap/extension-text-style";
import Highlight from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import { TableKit } from "@tiptap/extension-table";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import { BLOCK_NODE_TYPES } from "../constants/palette.js";
import { LabsBlockId } from "./blockId.js";
import { LabsBlockAttrs } from "./blockAttrs.js";
import { LabsReviewDecorations } from "./reviewDecorations.js";

export function buildLabsExtensions() {
  return [
    StarterKit,
    // Inline character styling (user-applied; not representable in block
    // markdown — documented lossy case).
    TextStyle,
    Color,
    BackgroundColor,
    Highlight.configure({ multicolor: true }),
    // Block-level alignment (server attr `align` maps to `textAlign`).
    TextAlign.configure({ types: BLOCK_NODE_TYPES }),
    TableKit.configure({ resizable: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({
      placeholder: "Start writing, or ask the assistant to draft something…"
    }),
    // Official markdown support: used for migration (old project.document ->
    // content) and the derived markdown snapshot (editor.getMarkdown()).
    Markdown,
    LabsBlockId,
    LabsBlockAttrs,
    LabsReviewDecorations
  ];
}
