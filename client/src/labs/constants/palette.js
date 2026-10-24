/**
 * Shared client-side Labs constants.
 *
 * IMPORTANT: NAMED_COLORS must stay in sync with the server's palette in
 * server/labs/blocks.js (NAMED_COLORS). The server accepts these names and
 * hex colors for textColor / backgroundColor; the values sent to the server
 * are the names below, never the display hexes.
 */

// Mirror of NAMED_COLORS in server/labs/blocks.js
export const NAMED_COLORS = [
  "black",
  "white",
  "gray",
  "grey",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "brown"
];

// Display hexes for the toolbar swatches (UI only — never sent anywhere).
export const COLOR_SWATCHES = [
  { name: "black", hex: "#111827" },
  { name: "white", hex: "#f9fafb" },
  { name: "gray", hex: "#9ca3af" },
  { name: "red", hex: "#ef4444" },
  { name: "orange", hex: "#f97316" },
  { name: "yellow", hex: "#eab308" },
  { name: "green", hex: "#22c55e" },
  { name: "blue", hex: "#3b82f6" },
  { name: "purple", hex: "#a855f7" },
  { name: "pink", hex: "#ec4899" },
  { name: "brown", hex: "#92400e" }
];

export const HIGHLIGHT_SWATCHES = [
  { name: "yellow", hex: "#fef08a" },
  { name: "green", hex: "#bbf7d0" },
  { name: "blue", hex: "#bfdbfe" },
  { name: "pink", hex: "#fbcfe8" },
  { name: "purple", hex: "#e9d5ff" },
  { name: "orange", hex: "#fed7aa" }
];

// Mirror of BLOCK_TYPES in server/labs/blocks.js
export const BLOCK_TYPES = [
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "taskList",
  "blockquote",
  "codeBlock",
  "table",
  "horizontalRule",
  "spacer"
];

// Top-level Tiptap node types that carry a blockId (mirrors BLOCK_TYPES).
export const BLOCK_NODE_TYPES = [
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "taskList",
  "blockquote",
  "codeBlock",
  "table",
  "horizontalRule",
  "spacer"
];

/**
 * Generate a client-side block id in the same format as the server
 * (server/labs/blocks.js generateBlockId). Only used for nodes that somehow
 * lack an id; server-provided ids are always used as-is.
 */
export function generateClientBlockId(existingIds) {
  let id;
  do {
    const bytes = new Uint8Array(4);
    if (globalThis.crypto?.getRandomValues) {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < 4; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    id = "b_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  } while (existingIds && existingIds.has(id));
  if (existingIds) existingIds.add(id);
  return id;
}
