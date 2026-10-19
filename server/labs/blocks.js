/**
 * Labs block model helpers: allowed types, attrs validation, id generation,
 * outline/preview computation, and size guards.
 *
 * Block shape: { id: string, type: string, text: string, attrs: object }
 * `text` is the Markdown of the block's content only (no block-level syntax
 * noise beyond what the block needs, e.g. list item markers for a list).
 */

const crypto = require("crypto");
const STYLE_SPEC = require("../../shared/labsStyles.json");
const DOCUMENT_NUMBER_ATTRS = {
  fontSizePt: STYLE_SPEC.numberAttrs.fontSizePt,
  lineHeight: STYLE_SPEC.numberAttrs.lineHeight,
  spaceAfterPt: STYLE_SPEC.numberAttrs.spaceAfterPt,
  marginMm: STYLE_SPEC.documentNumberAttrs.marginMm
};
const TABLE_ATTRS = ["tableVariant", "tableCellPaddingPt", ...STYLE_SPEC.tableColorAttrs];
const STYLE_ATTRS = ["fontFamily", ...Object.keys(STYLE_SPEC.numberAttrs), "tableVariant", ...STYLE_SPEC.tableColorAttrs];

const BLOCK_TYPES = [
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "taskList",
  "blockquote",
  "codeBlock",
  "table",
  "horizontalRule"
];

// Size guards (characters, not bytes)
const MAX_TOTAL_BLOCK_CHARS = 200000; // request-level limit across all blocks
const MAX_BLOCK_CHARS = 20000;       // per-block write limit for tools

// Small named palette accepted for textColor / backgroundColor
const NAMED_COLORS = [
  "black", "white", "gray", "grey", "red", "orange", "yellow",
  "green", "blue", "purple", "pink", "brown"
];

const ALLOWED_ALIGN = ["left", "center", "right", "justify"];

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function isColorValue(value) {
  return typeof value === "string" &&
    (NAMED_COLORS.includes(value) || HEX_COLOR_RE.test(value));
}

function previewText(text, max = 80) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

function blockLabel(block) {
  const p = previewText(block?.text, 24);
  return p || block?.type || "block";
}

/**
 * Generate a short random block id, collision-checked against existing ids.
 * The id is added to the set on success so it is never handed out twice.
 */
function generateBlockId(existingIds) {
  let id;
  do {
    id = "b_" + crypto.randomBytes(4).toString("hex");
  } while (existingIds.has(id));
  existingIds.add(id);
  return id;
}

function cloneBlocks(blocks) {
  return blocks.map((b) => ({
    id: b.id,
    type: b.type,
    text: b.text,
    attrs: { ...(b.attrs || {}) }
  }));
}

function totalBlockChars(blocks) {
  return blocks.reduce(
    (sum, b) => sum + (typeof b.text === "string" ? b.text.length : 0),
    0
  );
}

function outlineOf(blocks) {
  return blocks.map((b) => ({
    id: b.id,
    type: b.type,
    attrs: { ...(b.attrs || {}) },
    ...(b.type === "heading" && b.attrs && b.attrs.level
      ? { level: b.attrs.level }
      : {}),
    preview: previewText(b.text)
  }));
}

/**
 * Validate attrs for a block type. Returns { ok:true, attrs } with only the
 * allowlisted keys, or { ok:false, error } with a message the model can act on.
 * Used by tools so validation failures become tool results, not exceptions.
 */
function validateAttrs(type, attrs) {
  if (attrs == null) return { ok: true, attrs: {} };
  if (typeof attrs !== "object" || Array.isArray(attrs)) {
    return { ok: false, error: "attrs must be an object." };
  }
  const cleaned = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (TABLE_ATTRS.includes(key) && type !== "table") {
      return { ok: false, error: `${key} is only allowed on table blocks. Style a table block or omit this attr.` };
    }
    if (key === "textColor" || key === "backgroundColor" || STYLE_SPEC.tableColorAttrs.includes(key)) {
      if (value == null) continue; // null clears the attr (handled by the caller)
      if (!isColorValue(value)) {
        return {
          ok: false,
          error: `${key} must be a hex color like #1a2b3c, one of the named colors: ${NAMED_COLORS.join(", ")}, or null to clear it.`
        };
      }
      cleaned[key] = value;
    } else if (key === "align") {
      if (value == null) continue; // null clears the attr (handled by the caller)
      if (!ALLOWED_ALIGN.includes(value)) {
        return { ok: false, error: `align must be one of: ${ALLOWED_ALIGN.join(" | ")}, or null to clear it.` };
      }
      cleaned.align = value;
    } else if (key === "level") {
      if (value == null) continue; // null clears the attr (handled by the caller)
      const level = Number(value);
      if (!Number.isInteger(level) || level < 1 || level > 6) {
        return { ok: false, error: "level must be an integer between 1 and 6." };
      }
      cleaned.level = level;
    } else if (key === "language") {
      if (value == null) continue; // null clears the attr (handled by the caller)
      if (typeof value !== "string" || value.length === 0 || value.length > 40) {
        return { ok: false, error: 'language must be a short string, e.g. "bash".' };
      }
      cleaned.language = value;
    } else if (key === "fontFamily") {
      if (value == null) continue;
      if (!STYLE_SPEC.fonts.includes(value)) {
        return { ok: false, error: `fontFamily must be one of: ${STYLE_SPEC.fonts.join(" | ")}, or null to inherit.` };
      }
      cleaned[key] = value;
    } else if (Object.hasOwn(STYLE_SPEC.numberAttrs, key)) {
      if (value == null) continue;
      const [min, max] = STYLE_SPEC.numberAttrs[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
        return { ok: false, error: `${key} must be a finite number between ${min} and ${max}, or null to inherit. Do not send numeric strings.` };
      }
      cleaned[key] = value;
    } else if (key === "tableVariant") {
      if (value == null) continue;
      if (!STYLE_SPEC.tableVariants.includes(value)) {
        return { ok: false, error: `tableVariant must be one of: ${STYLE_SPEC.tableVariants.join(" | ")}, or null to inherit.` };
      }
      cleaned[key] = value;
    } else {
      return {
        ok: false,
        error: `Unknown attr "${key}". Allowed attrs: textColor, backgroundColor (hex or named color), align (left|center|right|justify), level (1-6 for headings), language (for code blocks), ${STYLE_ATTRS.join(", ")}. Table attrs are only allowed on table blocks. Use null to clear an attr.`
      };
    }
  }
  return { ok: true, attrs: cleaned };
}

/** Validate either a request's document defaults or a partial tool update. */
function validateDocumentStyle(style, { partial = false } = {}) {
  if (style === undefined && !partial) {
    return { ok: true, style: { preset: STYLE_SPEC.defaultPreset } };
  }
  if (!style || typeof style !== "object" || Array.isArray(style)) {
    return { ok: false, error: "documentStyle/style must be an object containing preset and optional fontFamily, fontSizePt, lineHeight, spaceAfterPt, marginMm." };
  }
  const cleaned = partial ? {} : { preset: STYLE_SPEC.defaultPreset };
  for (const [key, value] of Object.entries(style)) {
    if (key === "preset") {
      if (typeof value !== "string" || !Object.hasOwn(STYLE_SPEC.presets, value)) {
        return { ok: false, error: `preset must be one of: ${Object.keys(STYLE_SPEC.presets).join(" | ")}. It cannot be cleared; omit it to keep the current preset.` };
      }
      cleaned.preset = value;
    } else if (key === "fontFamily") {
      const checked = validateAttrs("paragraph", { fontFamily: value });
      if (!checked.ok) return checked;
      Object.assign(cleaned, checked.attrs);
    } else if (Object.hasOwn(DOCUMENT_NUMBER_ATTRS, key)) {
      if (value == null) continue;
      const [min, max] = DOCUMENT_NUMBER_ATTRS[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
        return { ok: false, error: `${key} must be a finite number between ${min} and ${max}, or null to inherit. Do not send numeric strings.` };
      }
      cleaned[key] = value;
    } else {
      return { ok: false, error: `Unknown document style attr "${key}". Allowed attrs: preset, fontFamily, ${Object.keys(DOCUMENT_NUMBER_ATTRS).join(", ")}. Use block style tools for other attrs.` };
    }
  }
  return { ok: true, style: cleaned };
}

/**
 * Validate incoming request blocks. Returns
 *   { ok:true, blocks, totalChars } with cloned/normalized blocks, or
 *   { ok:false, error } with a clear message (HTTP 400/413 by caller).
 */
function validateIncomingBlocks(blocks) {
  if (!Array.isArray(blocks)) {
    return { ok: false, error: "blocks must be an array of block objects {id, type, text, attrs}." };
  }
  const seen = new Set();
  const cloned = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const where = `block #${i + 1}`;
    if (!b || typeof b !== "object" || Array.isArray(b)) {
      return { ok: false, error: `${where} must be an object {id, type, text, attrs}.` };
    }
    if (typeof b.id !== "string" || b.id.trim() === "") {
      return { ok: false, error: `${where} has an invalid id: ids must be non-empty strings.` };
    }
    if (b.id === STYLE_SPEC.documentStyleId) {
      return { ok: false, error: `${where} uses reserved id "${STYLE_SPEC.documentStyleId}". Choose a different block id.` };
    }
    if (seen.has(b.id)) {
      return { ok: false, error: `Duplicate block id "${b.id}" (${where}); block ids must be unique.` };
    }
    seen.add(b.id);
    if (!BLOCK_TYPES.includes(b.type)) {
      return {
        ok: false,
        error: `${where} has invalid type ${JSON.stringify(b.type)}. Allowed types: ${BLOCK_TYPES.join(", ")}.`
      };
    }
    if (typeof b.text !== "string") {
      return { ok: false, error: `${where} ("${b.id}") text must be a string.` };
    }
    const checked = validateAttrs(b.type, b.attrs);
    if (!checked.ok) {
      return { ok: false, error: `${where} ("${b.id}") has invalid attrs: ${checked.error}` };
    }
    if (b.type === "heading" && checked.attrs.level == null) {
      return { ok: false, error: `${where} ("${b.id}") is a heading without attrs.level (1-6).` };
    }
    cloned.push({ id: b.id, type: b.type, text: b.text, attrs: checked.attrs });
  }
  const totalChars = totalBlockChars(cloned);
  if (totalChars > MAX_TOTAL_BLOCK_CHARS) {
    return {
      ok: false,
      tooLarge: true,
      error: `Document is too large: ${totalChars.toLocaleString("en-US")} characters across blocks (limit ${MAX_TOTAL_BLOCK_CHARS.toLocaleString("en-US")}). Try splitting the document or removing some content.`
    };
  }
  return { ok: true, blocks: cloned, totalChars };
}

module.exports = {
  BLOCK_TYPES,
  NAMED_COLORS,
  ALLOWED_ALIGN,
  STYLE_SPEC,
  DOCUMENT_NUMBER_ATTRS,
  MAX_TOTAL_BLOCK_CHARS,
  MAX_BLOCK_CHARS,
  isColorValue,
  previewText,
  blockLabel,
  generateBlockId,
  cloneBlocks,
  totalBlockChars,
  outlineOf,
  validateAttrs,
  validateDocumentStyle,
  validateIncomingBlocks
};
