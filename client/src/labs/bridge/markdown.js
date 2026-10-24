/**
 * Block-level Markdown <-> Tiptap node JSON, following the server's block
 * text conventions exactly (see server/labs/tools.js + the Phase 1 report):
 *
 *   paragraph     inline markdown
 *   heading       text WITHOUT the "# " prefix (level in attrs)
 *   blockquote    text WITHOUT the "> " prefix (multi-paragraph: blank line)
 *   bulletList    "- item" per line
 *   orderedList   "1. item" (renumbered from 1)
 *   taskList      "- [ ] item" / "- [x] item"
 *   codeBlock     raw code (language in attrs)
 *   table         full pipe table incl. separator row, pipes escaped as \|
 *   horizontalRule empty text
 *
 * Lists support one nesting level via 2-space indentation (the server only
 * produces flat lists, but user-edited documents can contain nesting).
 */

import { parseInlineMarkdown, serializeInlineNodes } from "./inlineMarkdown.js";
import { BLOCK_STYLE_KEYS, resolveSpacerHeight } from "../styles.js";

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function splitCellLine(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));
}

function isSeparatorRow(line) {
  return /^[\s|:-]+$/.test(line) && line.includes("-");
}

function cellParagraph(cellText) {
  const content = parseInlineMarkdown(cellText);
  // Empty cells/items: a content-less paragraph (valid Tiptap JSON).
  if (content.length === 0) return { type: "paragraph" };
  return { type: "paragraph", content };
}

/* ── Parsing: block markdown -> Tiptap node content ──────────────────────── */

const LIST_ITEM_RES = {
  bulletList: /^[-*+][ \t]+/,
  orderedList: /^\d+[.)][ \t]+/,
  taskList: /^[-*+][ \t]*\[([ xX])\][ \t]+/
};

/**
 * Parse list block text into listItem/taskItem content arrays. Supports one
 * level of nesting (2-space indented child lines under an item).
 */
function parseListContent(type, text, depth = 0) {
  const lines = text.split("\n");
  const items = [];
  let i = 0;

  const itemMatcher = (line) => {
    const re = LIST_ITEM_RES[type];
    const m = line.match(re);
    return m ? m[0].length : -1;
  };

  while (i < lines.length) {
    const raw = lines[i];
    if (raw.trim() === "") {
      i += 1;
      continue;
    }
    const indent = raw.length - raw.trimStart().length;

    // Indented lines after an item belong to a nested list under that item.
    if (indent > 0 && items.length > 0) {
      const nestedLines = [];
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === "") {
          const next = lines[i + 1];
          const nextIndent = next !== undefined ? next.length - next.trimStart().length : 0;
          if (next !== undefined && nextIndent > 0) {
            nestedLines.push("");
            i += 1;
            continue;
          }
          break;
        }
        if (l.length - l.trimStart().length === 0) break;
        nestedLines.push(l.replace(/^ {2}/, ""));
        i += 1;
      }
      const nestedType = type === "taskList" ? "bulletList" : type;
      if (nestedLines.length > 0) {
        items[items.length - 1].content.push({
          type: nestedType,
          content: parseListContent(nestedType, nestedLines.join("\n"), depth + 1)
        });
      }
      continue;
    }

    const trimmed = raw.trimStart();
    const markerLen = itemMatcher(trimmed);
    if (markerLen === -1) {
      // Not a recognized item line — treat as continuation text of previous item.
      if (items.length > 0) {
        const prevPara = items[items.length - 1].content[0];
        if (prevPara && prevPara.type === "paragraph") {
          prevPara.content.push({ type: "hardBreak" });
          prevPara.content.push(...parseInlineMarkdown(trimmed));
        }
      }
      i += 1;
      continue;
    }

    let itemText;
    let checked = false;
    if (type === "taskList") {
      const m = trimmed.match(LIST_ITEM_RES.taskList);
      checked = m[1] !== " ";
      itemText = trimmed.slice(m[0].length);
    } else {
      itemText = trimmed.slice(markerLen);
    }

    const content = [cellParagraph(itemText)];
    if (type === "taskList") {
      items.push({ type: "taskItem", attrs: { checked }, content });
    } else {
      items.push({ type: "listItem", content });
    }
    i += 1;
  }
  return items;
}

function parseTableContent(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length === 0) return [];
  const rows = [];
  for (const line of lines) {
    if (isSeparatorRow(line)) continue;
    rows.push(splitCellLine(line));
  }
  const content = rows.map((cells, r) => ({
    type: "tableRow",
    content: cells.map((cell) => ({
      type: r === 0 ? "tableHeader" : "tableCell",
      content: [cellParagraph(cell)]
    }))
  }));
  return content;
}

/**
 * Build a full top-level Tiptap node JSON from a server block.
 * Maps server block attrs -> node attrs:
 *   level          -> level (headings)
 *   language       -> language (codeBlock)
 *   textColor      -> textColor
 *   backgroundColor -> backgroundColor
 *   align          -> textAlign (owned by the official TextAlign extension)
 * @param {{id,type,text,attrs}} block
 */
export function blockToNodeJSON(block) {
  const { id, type, text, attrs = {} } = block;
  if (type === "spacer") {
    return { type, attrs: { blockId: id, heightPt: resolveSpacerHeight(attrs.heightPt) } };
  }
  const base = { blockId: id };
  if (attrs.textColor) base.textColor = attrs.textColor;
  if (attrs.backgroundColor) base.backgroundColor = attrs.backgroundColor;
  if (attrs.align) base.textAlign = attrs.align;
  for (const key of BLOCK_STYLE_KEYS) if (attrs[key] != null) base[key] = attrs[key];

  switch (type) {
    case "paragraph":
      return {
        type: "paragraph",
        attrs: base,
        content: parseInlineMarkdown(text)
      };
    case "heading":
      return {
        type: "heading",
        attrs: { ...base, level: attrs.level ?? 3 },
        content: parseInlineMarkdown(text)
      };
    case "blockquote": {
      // Multiple paragraphs inside one quote are separated by blank lines.
      const paras = text.split(/\n{2,}/).map((p) => ({
        type: "paragraph",
        content: parseInlineMarkdown(p)
      }));
      return { type: "blockquote", attrs: base, content: paras };
    }
    case "codeBlock":
      return {
        type: "codeBlock",
        attrs: { ...base, ...(attrs.language ? { language: attrs.language } : {}) },
        content: [{ type: "text", text }]
      };
    case "bulletList":
    case "orderedList":
    case "taskList":
      return { type, attrs: base, content: parseListContent(type, text) };
    case "table":
      return { type: "table", attrs: base, content: parseTableContent(text) };
    case "horizontalRule":
      return { type: "horizontalRule", attrs: base };
    default:
      return {
        type: "paragraph",
        attrs: base,
        content: parseInlineMarkdown(text)
      };
  }
}

/* ── Serialization: Tiptap node -> block ──────────────────────────────────── */

function serializeInline(node) {
  return serializeInlineNodes(node.content);
}

function serializeList(node) {
  const type = node.type;
  const lines = [];
  for (const item of node.content || []) {
    const paras = (item.content || []).filter((c) => c.type === "paragraph");
    const nested = (item.content || []).filter(
      (c) => c.type === "bulletList" || c.type === "orderedList" || c.type === "taskList"
    );
    let text = paras.length > 0 ? serializeInline(paras[0]) : "";
    for (const p of paras.slice(1)) {
      text += "\n" + serializeInline(p);
    }
    for (const nestedList of nested) {
      for (const nl of serializeList(nestedList).split("\n")) {
        text += "\n  " + nl;
      }
    }
    if (type === "bulletList") lines.push("- " + text);
    else if (type === "orderedList") lines.push(`${lines.length + 1}. ${text}`);
    else lines.push(`- [${item.attrs?.checked ? "x" : " "}] ${text}`);
  }
  return lines.join("\n");
}

function serializeTable(node) {
  const esc = (s) => s.replace(/\|/g, "\\|");
  const lines = [];
  (node.content || []).forEach((row, r) => {
    const cells = (row.content || []).map((cell) => esc(serializeInline((cell.content || [])[0] || { content: [] })));
    lines.push(`| ${cells.join(" | ")} |`);
    if (r === 0) {
      lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
    }
  });
  return lines.join("\n");
}

/**
 * Convert a top-level Tiptap node into a server block.
 * Accepts either node JSON or a live ProseMirror node (normalized via
 * toJSON — live nodes carry NodeType objects and Fragments, not plain data).
 * Maps node attrs back to server block attrs (align <- textAlign).
 * @returns {{id,type,text,attrs}} or null for unknown nodes.
 */
export function nodeToBlock(nodeOrJSON) {
  const node = typeof nodeOrJSON?.toJSON === "function" ? nodeOrJSON.toJSON() : nodeOrJSON;
  if (!node) return null;
  const blockId = node.attrs?.blockId ?? null;
  if (node.type === "spacer") {
    return { id: blockId, type: "spacer", text: "", attrs: { heightPt: resolveSpacerHeight(node.attrs?.heightPt) } };
  }
  const attrs = {};
  if (node.attrs?.level != null) attrs.level = node.attrs.level;
  if (node.attrs?.language) attrs.language = node.attrs.language;
  if (node.attrs?.textColor) attrs.textColor = node.attrs.textColor;
  if (node.attrs?.backgroundColor) attrs.backgroundColor = node.attrs.backgroundColor;
  if (node.attrs?.textAlign) attrs.align = node.attrs.textAlign;
  for (const key of BLOCK_STYLE_KEYS) if (node.attrs?.[key] != null) attrs[key] = node.attrs[key];

  switch (node.type) {
    case "paragraph":
      return { id: blockId, type: "paragraph", text: serializeInline(node), attrs };
    case "heading":
      return { id: blockId, type: "heading", text: serializeInline(node), attrs };
    case "blockquote":
      return {
        id: blockId,
        type: "blockquote",
        text: (node.content || []).map((p) => serializeInline(p)).join("\n\n"),
        attrs
      };
    case "codeBlock":
      return {
        id: blockId,
        type: "codeBlock",
        text: (node.content || []).map((n) => n.text || "").join(""),
        attrs
      };
    case "bulletList":
    case "orderedList":
    case "taskList":
      return { id: blockId, type: node.type, text: serializeList(node), attrs };
    case "table":
      return { id: blockId, type: "table", text: serializeTable(node), attrs };
    case "horizontalRule":
      return { id: blockId, type: "horizontalRule", text: "", attrs };
    default:
      return null;
  }
}

/* ── Document-level helpers ──────────────────────────────────────────────── */

/**
 * Serialize blocks into a full-document Markdown string (standard dialect —
 * used for the derived project.document of imported content; the live editor
 * path uses editor.getMarkdown() from @tiptap/markdown instead).
 */
export function blocksToMarkdownDocument(blocks) {
  const parts = [];
  for (const block of blocks) {
    const { type, text, attrs = {} } = block;
    if (type === "spacer") continue; // Plain Markdown cannot retain measured blank space.
    if (type === "heading") {
      parts.push("#".repeat(Math.min(6, Math.max(1, attrs.level || 1))) + " " + text);
    } else if (type === "blockquote") {
      parts.push(text.split("\n").map((l) => (l.trim() ? "> " + l.trim() : ">")).join("\n"));
    } else if (type === "codeBlock") {
      parts.push("```" + (attrs.language || "") + "\n" + text + "\n```");
    } else if (type === "horizontalRule") {
      parts.push("---");
    } else {
      // paragraph, lists, tables: block text is already valid markdown
      parts.push(text);
    }
  }
  return parts.join("\n\n");
}

/**
 * Convert a Tiptap document JSON into server blocks. Nodes without a blockId
 * get a generated id (the blockId extension should prevent this; pure
 * function stays defensive). Unknown node types are skipped.
 */
export function editorToBlocks(docJSON, generateId) {
  const blocks = [];
  const seen = new Set(blocks.map(() => ""));
  const content = docJSON?.content || [];
  const used = new Set(content.map((n) => n.attrs?.blockId).filter(Boolean));
  for (const node of content) {
    const block = nodeToBlock(node);
    if (!block) continue;
    if (!block.id || seen.has(block.id)) {
      block.id = generateId ? generateId(used) : `b_missing_${blocks.length}`;
    }
    seen.add(block.id);
    blocks.push(block);
  }
  return blocks;
}
