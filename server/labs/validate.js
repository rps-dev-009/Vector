/**
 * Labs canonical text construction, validation, and auto-repair.
 *
 * Principles: build structure instead of trusting the model's formatting;
 * normalize before matching; validate after writing; auto-repair what is
 * safely repairable (counting each repair); reject with actionable errors
 * the model can retry from.
 *
 * This module owns every transformation of block text. tools.js calls these
 * functions before applying writes; engine.js reads the repair/warning
 * counters for the done event and logs.
 */

const { BLOCK_TYPES } = require("./blocks");

const LIST_TYPES = ["bulletList", "orderedList", "taskList"];
const TEXT_TYPES = ["paragraph", "heading", "blockquote", "codeBlock"];

/* ── 1.5 newline normalization (moved here from tools.js; re-exported there) ── */

/**
 * Some models emit the two literal characters backslash + "n" instead of real
 * line breaks in multi-line block text. Only applies when:
 *   - the block type is NOT codeBlock (code content is never altered), and
 *   - the text contains the literal sequence \n, and
 *   - the text contains NO real newline characters.
 */
function normalizeEscapedNewlines(text, blockType) {
  if (typeof text !== "string" || blockType === "codeBlock") return text;
  if (!text.includes("\\n")) return text;
  if (text.includes("\n")) return text;
  return text.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
}

/* ── Repair counters ── */

function createRepairsCounter() {
  return { trim: 0, strip_fence: 0, heading_marker: 0, quote_marker: 0, newline: 0 };
}

function totalRepairs(repairs) {
  return Object.values(repairs || {}).reduce((a, b) => a + (Number(b) || 0), 0);
}

/* ── Type guards ── */

function isKnownType(type) {
  return BLOCK_TYPES.includes(type);
}

/* ── Single-block repairs ── */

// Strip a wrapping ``` fence (```lang\n...\n```) from non-code block text.
function stripWrappingFence(text) {
  const m = text.match(/^```[^\n]*\n([\s\S]*?)\n```[ \t\r\n]*$/);
  return m ? m[1] : null;
}

// Strip a leading "# " marker (with level) from heading text.
function stripHeadingMarker(text) {
  const m = text.match(/^[ \t]*(#{1,6})[ \t]+([\s\S]*)$/);
  if (!m) return null;
  return { level: m[1].length, text: m[2] };
}

// Strip leading "> " markers from blockquote text lines.
function stripQuoteMarkers(text) {
  const lines = text.split("\n");
  let changed = false;
  const out = lines.map((l) => {
    const m = l.match(/^[ \t]*>[ \t]?(.*)$/);
    if (m) {
      changed = true;
      return m[1];
    }
    return l;
  });
  return changed ? out.join("\n") : null;
}

/**
 * Detect a list that the model typed INSIDE a single text block, e.g.
 * "Key initiatives include: 1. Kisan Call Centers … 2. mKisan Portal … 3. …".
 * Such a block renders as one run-on paragraph, so it is rejected and the
 * model is told to build a real list block instead.
 *
 * Deliberately conservative: an ascending 1-2-3 run (or three bullet glyphs)
 * is required, so prose that merely mentions "2." is never flagged.
 * @returns {"numbered"|"bulleted"|null}
 */
function detectInlineList(text) {
  if (typeof text !== "string" || text.length < 80) return null;
  const numbers = [];
  for (const m of text.matchAll(/(?:^|[\s(])(\d{1,2})[.)]\s+\S/g)) {
    numbers.push(Number(m[1]));
  }
  let run = 0;
  let expected = 1;
  for (const n of numbers) {
    if (n === expected) {
      run += 1;
      expected += 1;
    } else if (n === 1) {
      run = 1;
      expected = 2;
    }
  }
  if (run >= 3) return "numbered";
  // Only unambiguous bullet glyphs: an ASCII hyphen is too common in prose.
  const bullets = [...text.matchAll(/(?:^|\s)[•‣▪]\s+\S/g)].length;
  if (bullets >= 3) return "bulleted";
  return null;
}

// This guard applies to AI writes, not imported or manually authored headings.
function validateHeadingText(text) {
  const visible = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").trim();
  if (/[\r\n]/.test(text) || visible.length > 240 || visible.split(/\s+/).length > 40) {
    return {
      ok: false,
      error: "A heading must be a concise single-line title (at most 40 words and 240 characters), not body prose. Put explanations in separate paragraph blocks using insert_blocks. To repair an existing paragraph stored as a heading, use replace_block with type: paragraph and preserve its text."
    };
  }
  return { ok: true };
}

/**
 * Validate + auto-repair the raw text for a block type (the four text types
 * and the text-fallback paths for lists/tables). Counts every repair in
 * `state.repairs` (and keeps the 1.5 `state.newlineNormalized` in sync).
 * Returns { ok, text, impliedLevel? } or { ok:false, error }.
 */
function prepareBlockText({ type, text, state }) {
  if (type === "spacer") {
    if (text != null && (typeof text !== "string" || text.trim() !== "")) {
      return { ok: false, error: "A spacer is blank: omit text or use an empty string. Do not add labels, diagrams, flowcharts or divider lines." };
    }
    return { ok: true, text: "" };
  }
  if (typeof text !== "string") {
    return { ok: false, error: `A ${type} block requires text (the Markdown content).` };
  }
  let t = text;

  const nl = normalizeEscapedNewlines(t, type);
  if (nl !== t) {
    t = nl;
    state.repairs.newline += 1;
    state.newlineNormalized += 1;
  }

  if (type !== "codeBlock") {
    const inner = stripWrappingFence(t);
    if (inner != null) {
      t = inner;
      state.repairs.strip_fence += 1;
    }
  }

  let impliedLevel = null;
  if (type === "heading") {
    const h = stripHeadingMarker(t);
    if (h) {
      t = h.text;
      impliedLevel = h.level;
      state.repairs.heading_marker += 1;
    }
  } else if (type === "blockquote") {
    const q = stripQuoteMarkers(t);
    if (q != null) {
      t = q;
      state.repairs.quote_marker += 1;
    }
  }

  if (type === "horizontalRule") {
    if (t !== "") {
      t = "";
      state.repairs.trim += 1;
    }
    return { ok: true, text: "" };
  }

  if (type !== "codeBlock") {
    const trimmed = t.trim();
    if (trimmed !== t) {
      t = trimmed;
      state.repairs.trim += 1;
    }
  }

  if (t === "" && !LIST_TYPES.includes(type)) {
    return {
      ok: false,
      error: `A ${type} block cannot have empty text. For requested blank diagram space, insert a spacer with attrs.heightPt (24-360 points, default 144) instead. Do not substitute a horizontal rule or write placeholder text.`
    };
  }
  if (type === "heading") {
    const heading = validateHeadingText(t);
    if (!heading.ok) return heading;
  }
  // List typed inline into a text block -> reject with the structural fix.
  if (type === "paragraph" || type === "heading" || type === "blockquote") {
    const inlineList = detectInlineList(t);
    if (inlineList) {
      const listType = inlineList === "numbered" ? "orderedList" : "bulletList";
      return {
        ok: false,
        error: `This ${type} contains a ${inlineList} list written inline, so it would render as one run-on paragraph. Keep only the lead-in sentence in this ${type}, and put the items in a separate ${listType} block: {"type": "${listType}", "items": ["first item", "second item", "third item"]}. Use insert_blocks to write the ${type} and the list together.`
      };
    }
  }
  // List types allow empty text here: canonicalizeListText decides and
  // produces the list-specific "use items" error instead.

  return { ok: true, text: t, impliedLevel };
}

/* ── List canonical construction ── */

// Parse one list item line: strips optional markers ("-", "*", "+", "1.",
// "- [ ]"/"- [x]") and detects the checkbox state. Blank lines return null.
function parseListLine(line) {
  let t = typeof line === "string" ? line.trim() : "";
  if (t === "") return null;
  let checked = null;
  let m = t.match(/^\[([ xX])\][ \t]*(.*)$/); // "[x] foo"
  if (m) {
    checked = m[1] !== " ";
    t = m[2];
  }
  m = t.match(/^[-*+][ \t]*\[([ xX])\][ \t]+(.*)$/); // "- [x] foo"
  if (m) {
    checked = m[1] !== " ";
    t = m[2];
  } else {
    m = t.match(/^[-*+][ \t]+(.*)$/); // "- foo"
    if (m) t = m[1];
    else {
      m = t.match(/^\d+[.)][ \t]+(.*)$/); // "1. foo"
      if (m) t = m[1];
    }
  }
  t = t.trim();
  if (t === "") return checked != null ? { text: "", checked } : null;
  return { text: t, checked };
}

// Build the canonical block text for a list block from normalized items.
function buildListText(type, items) {
  if (type === "bulletList") return items.map((i) => `- ${i.text}`).join("\n");
  if (type === "orderedList") return items.map((i, n) => `${n + 1}. ${i.text}`).join("\n");
  if (type === "taskList") return items.map((i) => `- [${i.checked ? "x" : " "}] ${i.text}`).join("\n");
  return null;
}

// Normalize structured `items` input: strings or {text, checked}; strips
// markers the model may have included; splits multi-line items.
function normalizeListItems(rawItems, type, state) {
  if (!Array.isArray(rawItems)) {
    return {
      ok: false,
      error: `For ${type} blocks use items: a non-empty array of item strings, e.g. ["first item", "second item"].`
    };
  }
  const items = [];
  let repaired = false;
  for (const raw of rawItems) {
    let base = raw;
    let objChecked = false;
    if (base && typeof base === "object" && !Array.isArray(base)) {
      if (typeof base.text !== "string") {
        return { ok: false, error: `Every list item must be a string or {text, checked}. Problem at item ${items.length + 1}.` };
      }
      objChecked = Boolean(base.checked);
      base = base.text;
    }
    if (typeof base !== "string") {
      return { ok: false, error: `Every list item must be a string or {text, checked}. Problem at item ${items.length + 1}.` };
    }
    let piece = base;
    const nl = normalizeEscapedNewlines(piece, type);
    if (nl !== piece) {
      piece = nl;
      state.repairs.newline += 1;
      state.newlineNormalized += 1;
    }
    for (const line of piece.split("\n")) {
      const parsed = parseListLine(line);
      if (!parsed) continue;
      if (parsed.text !== line.trim()) repaired = true;
      items.push({ text: parsed.text, checked: parsed.checked != null ? parsed.checked : objChecked });
    }
  }
  if (items.length === 0) {
    return { ok: false, error: `A ${type} block needs at least one item. Use items: ["first item", "second item"].` };
  }
  if (repaired) state.repairs.trim += 1;
  return { ok: true, items };
}

// Text fallback for list blocks: repair, parse lines, rebuild canonically.
function canonicalizeListText(text, type, state) {
  const prepared = prepareBlockText({ type, text, state });
  if (!prepared.ok) return prepared;
  const items = [];
  let repaired = false;
  for (const line of prepared.text.split("\n")) {
    const parsed = parseListLine(line);
    if (!parsed) continue;
    if (parsed.text !== line.trim()) repaired = true;
    items.push({ text: parsed.text, checked: parsed.checked != null ? parsed.checked : false });
  }
  if (items.length === 0) {
    return {
      ok: false,
      error: `A ${type} block needs at least one item (the text contained none). Use items: ["first item", "second item"].`
    };
  }
  if (repaired) state.repairs.trim += 1;
  return { ok: true, text: buildListText(type, items) };
}

/* ── Table canonical construction ── */

// Build a canonical pipe table: escaped pipes, separator row, every row
// padded/trimmed to the header length.
function buildTableText(header, rows) {
  const width = header.length;
  const esc = (s) => String(s).trim().replace(/\|/g, "\\|");
  const normCells = (cells) => {
    const out = [];
    for (let i = 0; i < width; i++) out.push(cells[i] != null ? esc(cells[i]) : "");
    return out;
  };
  const lines = [`| ${normCells(header).join(" | ")} |`];
  lines.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const r of rows) lines.push(`| ${normCells(r).join(" | ")} |`);
  return lines.join("\n");
}

// Validate structured header/rows input.
function normalizeTableInput(header, rows, state) {
  if (!Array.isArray(header) || header.length === 0 || header.some((h) => typeof h !== "string" || h.trim() === "")) {
    return { ok: false, error: 'For table blocks use header: ["Column 1", "Column 2"] (non-empty strings).' };
  }
  let rr = [];
  if (rows == null) {
    rr = [];
  } else if (!Array.isArray(rows)) {
    return { ok: false, error: "rows must be an array of row arrays, e.g. [[\"a\", \"b\"]]." };
  } else {
    for (const r of rows) {
      if (!Array.isArray(r) || r.some((c) => typeof c !== "string")) {
        return { ok: false, error: "Every table row must be an array of cell strings. Use header and rows." };
      }
      if (r.length > header.length) {
        return { ok: false, error: `Table row ${rr.length + 1} has ${r.length} cells but the header has ${header.length}. Add the missing headers or correct the row; cells must not be discarded.` };
      }
      rr.push(r);
    }
  }
  return { ok: true, header, rows: rr };
}

// Parse a pipe table from text. Rejects ragged rows with an actionable error.
function parsePipeTable(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length === 0) {
    return { ok: false, error: "The table text is empty. Use header and rows to build the table." };
  }
  const splitRow = (line) => {
    let s = line;
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
    return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
  };
  const header = splitRow(lines[0]);
  const isSeparator = (l) => /^[\s|:-]+$/.test(l) && l.includes("-");
  const bodyLines = lines.slice(1).filter((l) => !isSeparator(l));
  const rows = bodyLines.map(splitRow);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].length !== header.length) {
      return {
        ok: false,
        error: `Table rows have inconsistent column counts: row ${i + 1} has ${rows[i].length} cell${rows[i].length === 1 ? "" : "s"} but the header has ${header.length}. Send header and rows instead, or fix the row.`
      };
    }
  }
  return { ok: true, header, rows };
}

// Text fallback for table blocks: repair, parse, reject inconsistencies,
// rebuild canonically.
function canonicalizeTableText(text, state) {
  const prepared = prepareBlockText({ type: "table", text, state });
  if (!prepared.ok) return prepared;
  if (!prepared.text.includes("|")) {
    return {
      ok: false,
      error: 'For table blocks use header: ["Column 1", "Column 2"] and rows: [["a", "b"]]. Plain text cannot be used for tables.'
    };
  }
  const parsed = parsePipeTable(prepared.text);
  if (!parsed.ok) return parsed;
  return { ok: true, text: buildTableText(parsed.header, parsed.rows) };
}

/* ── End-of-run document check ── */

function countDuplicateIds(blocks) {
  const seen = new Set();
  let dups = 0;
  for (const b of blocks) {
    if (seen.has(b.id)) dups += 1;
    else seen.add(b.id);
  }
  return dups;
}

module.exports = {
  LIST_TYPES,
  TEXT_TYPES,
  normalizeEscapedNewlines,
  createRepairsCounter,
  totalRepairs,
  isKnownType,
  detectInlineList,
  validateHeadingText,
  prepareBlockText,
  parseListLine,
  buildListText,
  normalizeListItems,
  canonicalizeListText,
  buildTableText,
  normalizeTableInput,
  parsePipeTable,
  canonicalizeTableText,
  countDuplicateIds
};
