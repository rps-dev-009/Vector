/**
 * Labs agent tools. Every tool executes against the in-memory working copy
 * (`doc`, a mutable array of blocks owned by the engine for this request).
 *
 * Every tool returns { ok:true, ... } or { ok:false, error } — validation
 * failures are tool results (not thrown), so the model can read the error
 * and self-correct. Each successful edit tool emits an `edit` SSE event via
 * the injected emitEdit callback and updates the working copy.
 *
 * Block text is built canonically (lists from `items`, tables from
 * `header`/`rows`) and validated/repaired by server/labs/validate.js before
 * it is applied — the model's raw formatting is never trusted.
 */

const { z } = require("zod");
const {
  BLOCK_TYPES,
  ALLOWED_ALIGN,
  STYLE_SPEC,
  DOCUMENT_NUMBER_ATTRS,
  isColorValue,
  MAX_BLOCK_CHARS,
  MAX_TOTAL_BLOCK_CHARS,
  totalBlockChars,
  outlineOf,
  generateBlockId,
  validateAttrs,
  validateDocumentStyle,
  blockLabel
} = require("./blocks");
const {
  LIST_TYPES,
  normalizeEscapedNewlines,
  createRepairsCounter,
  isKnownType,
  prepareBlockText,
  validateHeadingText,
  buildListText,
  normalizeListItems,
  canonicalizeListText,
  buildTableText,
  normalizeTableInput,
  canonicalizeTableText
} = require("./validate");

// Re-exported for backward compatibility (1.5 unit tests import it from tools).
module.exports = {};

const READ_BLOCKS_MAX = 20;
// Bound individual batches; long drafts may use several ordered batches.
const INSERT_BLOCKS_MAX = 30;
const STYLE_BLOCKS_MAX = 40;

const nullableNumber = ([min, max]) => z.number().finite().min(min).max(max).nullable().optional()
  .describe(`Finite number from ${min} to ${max}; null clears the override.`);
const colorSchema = z.string().refine(isColorValue, "Use a hex color (#abc or #aabbcc) or a supported named color.")
  .nullable().optional().describe("Hex or named color; null clears the override.");
const attrsSchema = z.object({
  heightPt: nullableNumber([STYLE_SPEC.spacer.minHeightPt, STYLE_SPEC.spacer.maxHeightPt])
    .describe("Spacer blocks only: blank height in points (72pt = one inch). Omit or null for 144pt. Never a line or diagram."),
  textColor: colorSchema,
  backgroundColor: colorSchema,
  align: z.enum(ALLOWED_ALIGN).nullable().optional(),
  level: z.number().int().min(1).max(6).nullable().optional(),
  language: z.string().min(1).max(40).nullable().optional(),
  fontFamily: z.enum(STYLE_SPEC.fonts).nullable().optional(),
  ...Object.fromEntries(Object.entries(STYLE_SPEC.numberAttrs).map(([key, range]) => [key, nullableNumber(range)])),
  tableVariant: z.enum(STYLE_SPEC.tableVariants).nullable().optional(),
  ...Object.fromEntries(STYLE_SPEC.tableColorAttrs.map((key) => [key, colorSchema]))
}).strict().describe("Block attrs to merge; null clears an override. Table attrs require a table block; heading level cannot be cleared.");
const documentStyleSchema = z.object({
  preset: z.enum(Object.keys(STYLE_SPEC.presets)).optional(),
  fontFamily: z.enum(STYLE_SPEC.fonts).nullable().optional(),
  ...Object.fromEntries(Object.entries(DOCUMENT_NUMBER_ATTRS).map(([key, range]) => [key, nullableNumber(range)]))
}).strict().describe("Document defaults inherited by existing and future blocks without overrides. Changing preset resets prior document overrides; null clears an override, never preset.");

const sameAttrs = (a, b) => Object.keys(a).length === Object.keys(b).length &&
  Object.keys(a).every((key) => a[key] === b[key]);

/* ── Normalized matching (simplified per spec adjustment A) ── */

// Character-level transforms applied before comparison: NBSP and whitespace
// runs collapse to one space; curly quotes/dashes/ellipsis become ASCII.
const NORM_CHAR_MAP = {
  "\u2018": "'", // ‘
  "\u2019": "'", // ’
  "\u201C": '"', // “
  "\u201D": '"', // ”
  "\u2013": "-", // –
  "\u2014": "-", // —
  "\u2026": "..." // …
};

// Build a normalized view of `text` plus an index map so a normalized match
// can be mapped back to the ORIGINAL text offsets (the replacement splices
// the original text, so inline markers outside the matched span survive).
function buildNormalizedText(text) {
  let norm = "";
  const starts = [];
  const ends = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const mapped = NORM_CHAR_MAP[ch];
    if (mapped != null) {
      for (const out of mapped) {
        starts.push(i);
        ends.push(i + 1);
        norm += out;
      }
      i += 1;
    } else if (/\s/.test(ch)) {
      const runStart = i;
      while (i < text.length && /\s/.test(text[i])) i += 1;
      starts.push(runStart);
      ends.push(i);
      norm += " ";
    } else {
      starts.push(i);
      ends.push(i + 1);
      norm += ch;
      i += 1;
    }
  }
  return { norm, starts, ends };
}

function normalizeFindString(find) {
  return buildNormalizedText(find).norm;
}

function createLabsTools({ doc, documentStyle, emitEdit, emitActivity, limits }) {
  const maxEdits = limits.maxEdits;
  const maxBlockChars = limits.maxBlockChars;
  // When the whole document is inlined in the request the model can see every
  // block, so it may edit directly. In outline mode it only sees 80-character
  // previews, which is how blocks get rewritten by mistake — so a text edit
  // then requires an explicit read first.
  const inlineDoc = limits.inlineDoc !== false;
  const state = {
    editCount: 0,
    newlineNormalized: 0,
    repairs: createRepairsCounter(),
    documentStyle: { preset: STYLE_SPEC.defaultPreset, ...documentStyle },
    warnings: []
  };
  const existingIds = new Set([STYLE_SPEC.documentStyleId, ...doc.map((b) => b.id)]);
  // Blocks whose full text this run has actually seen.
  const seenIds = new Set(inlineDoc ? doc.map((b) => b.id) : []);

  const findBlock = (id) => doc.find((b) => b.id === id);

  /** Block ids the model may safely rewrite or delete. */
  const requireSeen = (blockId, op) => {
    if (seenIds.has(blockId)) return null;
    return {
      ok: false,
      error: `You have not read block "${blockId}" in this run, and the document is only shown as an outline, so you cannot see its current text. Call read_blocks with its id first, then ${op}.`
    };
  };

  const editLimitError = () => ({
    ok: false,
    code: "edit_limit",
    error: `Edit limit reached (${maxEdits} edits per request). Stop editing and reply with what you completed.`
  });

  const notFound = (id) => ({
    ok: false,
    error: `Block "${id}" was not found. Use get_outline to see the current block ids.`,
    outline: outlineOf(doc)
  });

  const overLimit = (n) => ({
    ok: false,
    error: `Block text is too long (${n} characters). The maximum is ${maxBlockChars} characters per block — split the content into multiple blocks.`
  });

  const documentLimitError = (addedChars) => totalBlockChars(doc) + addedChars > MAX_TOTAL_BLOCK_CHARS ? {
    ok: false,
    code: "document_limit",
    error: `This write would exceed the document limit (${MAX_TOTAL_BLOCK_CHARS} characters). This call made no changes. Keep the remaining material for a separate document.`
  } : null;

  /**
   * Determine the canonical text for a block write, based on the block type
   * and the fields the model provided. Structured input wins; text is a
   * validated fallback; wrong combinations produce actionable errors.
   */
  const buildBlockTextForType = ({ type, text, items, header, rows }) => {
    if (!isKnownType(type)) {
      return {
        ok: false,
        error: `Unknown block type ${JSON.stringify(type)}. Allowed types: ${BLOCK_TYPES.join(", ")}.`
      };
    }
    if (type === "spacer") {
      if (items !== undefined || header !== undefined || rows !== undefined) {
        return { ok: false, error: "A spacer has no content. Omit text/items/header/rows and set only attrs.heightPt." };
      }
      return prepareBlockText({ type, text, state });
    }
    if (LIST_TYPES.includes(type)) {
      if (Array.isArray(items)) {
        const r = normalizeListItems(items, type, state);
        if (!r.ok) return r;
        return { ok: true, text: buildListText(type, r.items) };
      }
      if (text !== undefined) return canonicalizeListText(text, type, state);
      return {
        ok: false,
        error: `For ${type} blocks use items: a non-empty array of item strings, e.g. ["first item", "second item"].`
      };
    }
    if (type === "table") {
      if (header !== undefined || rows !== undefined) {
        const r = normalizeTableInput(header, rows, state);
        if (!r.ok) return r;
        return { ok: true, text: buildTableText(r.header, r.rows) };
      }
      if (text !== undefined) return canonicalizeTableText(text, state);
      return {
        ok: false,
        error: 'For table blocks use header: ["Column 1", "Column 2"] and rows: [["a", "b"]] to build the table.'
      };
    }
    if (type === "horizontalRule") {
      return prepareBlockText({ type, text: text != null ? text : "", state });
    }
    // paragraph, heading, blockquote, codeBlock
    if (typeof text !== "string") {
      return { ok: false, error: `A ${type} block requires text (the Markdown content).` };
    }
    return prepareBlockText({ type, text, state });
  };

  /**
   * Validate one new-block spec (type + content + attrs) WITHOUT mutating the
   * document. Shared by insert_block and insert_blocks so a batch can be
   * fully validated before anything is inserted.
   */
  const prepareNewBlock = ({ type, text, items, header, rows, attrs }) => {
    const checkedAttrs = validateAttrs(type, attrs);
    if (!checkedAttrs.ok) return checkedAttrs;
    const built = buildBlockTextForType({ type, text, items, header, rows });
    if (!built.ok) return built;
    if (built.text.length > maxBlockChars) return overLimit(built.text.length);
    const finalAttrs = { ...checkedAttrs.attrs };
    if (type === "heading" && finalAttrs.level == null && built.impliedLevel != null) {
      finalAttrs.level = built.impliedLevel;
    }
    if (type === "heading" && finalAttrs.level == null) {
      return {
        ok: false,
        error: 'Heading blocks require attrs.level (an integer 1-6). Example attrs: {"level": 2}.'
      };
    }
    return { ok: true, type, text: built.text, attrs: finalAttrs };
  };

  /** Resolve an afterId into a splice index, or an actionable error. */
  const indexAfter = (afterId) => {
    const target = afterId == null || afterId === "" ? null : afterId;
    if (target === null) return { ok: true, index: 0, anchor: null };
    const at = doc.findIndex((b) => b.id === target);
    if (at === -1) return notFound(target);
    return { ok: true, index: at + 1, anchor: target };
  };

  /** Insert one prepared block at `index`; emits the edit event. */
  const commitInsert = (prepared, index, anchor) => {
    const id = generateBlockId(existingIds);
    const block = { id, type: prepared.type, text: prepared.text, attrs: prepared.attrs };
    doc.splice(index, 0, block);
    // The agent wrote this block, so it knows its text.
    seenIds.add(id);
    state.editCount += 1;
    const edit = {
      op: "insert",
      blockId: id,
      afterId: anchor,
      after: prepared.text,
      type: prepared.type
    };
    if (Object.keys(prepared.attrs).length > 0) edit.attrs = { ...prepared.attrs };
    emitEdit(edit);
    return id;
  };

  // Preflight all ids, attrs, heading invariants and budget before any mutation.
  const styleBlocks = (blockIds, attrs, tool) => {
    if (!Array.isArray(blockIds) || blockIds.length === 0 ||
        blockIds.some((id) => typeof id !== "string" || id.trim() === "")) {
      return { ok: false, error: "blockIds must be a non-empty array of block id strings." };
    }
    if (blockIds.length > STYLE_BLOCKS_MAX) {
      return { ok: false, error: `Style at most ${STYLE_BLOCKS_MAX} blocks per call. Split this batch into smaller groups.` };
    }
    if (new Set(blockIds).size !== blockIds.length) {
      return { ok: false, error: "blockIds must be unique. Remove duplicate ids before retrying." };
    }
    if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) {
      return { ok: false, error: "attrs must be an object of attributes to set or clear with null." };
    }
    const prepared = [];
    for (const blockId of blockIds) {
      const block = findBlock(blockId);
      if (!block) return notFound(blockId);
      const checked = validateAttrs(block.type, attrs);
      if (!checked.ok) return { ok: false, error: `Block "${blockId}": ${checked.error}` };
      const before = { ...block.attrs };
      const after = { ...before, ...checked.attrs };
      for (const [key, value] of Object.entries(attrs)) {
        if (value === null) delete after[key];
      }
      if (block.type === "heading" && after.level == null) {
        return { ok: false, error: "Headings require attrs.level (1-6); it cannot be cleared. Set a level between 1 and 6 instead." };
      }
      prepared.push({ block, before, after, changed: !sameAttrs(before, after) });
    }
    const changes = prepared.filter((p) => p.changed);
    if (state.editCount + changes.length > maxEdits) {
      return { ok: false, code: "edit_limit", error: `This call would exceed the edit limit (${maxEdits} edits per request, ${state.editCount} used). Style fewer blocks; this batch made no changes.` };
    }
    if (changes.length > 0) {
      emitActivity(tool === "set_block_attrs"
        ? `Styling: ${blockLabel(changes[0].block)}`
        : `Styling ${changes.length} block${changes.length === 1 ? "" : "s"}`, tool);
      for (const { block, before, after } of changes) {
        block.attrs = after;
        state.editCount += 1;
        emitEdit({ op: "set_attrs", blockId: block.id, before, after: { ...after }, attrs: { ...after } });
      }
    }
    return {
      ok: true,
      blockIds: changes.map((p) => p.block.id),
      count: changes.length,
      blocks: prepared.map((p) => ({ blockId: p.block.id, attrs: { ...p.after } })),
      ...(changes.length === 0 ? { noChange: true, note: "No change was needed. Do not repeat this style call; report what you completed." } : {})
    };
  };

  const newBlockSchema = z.object({
    type: z.enum(BLOCK_TYPES).describe("Type of the new block."),
    text: z.string().optional().describe("Markdown content only. Headings must be concise single-line titles, not body paragraphs."),
    items: z
      .array(z.union([z.string(), z.object({ text: z.string(), checked: z.boolean().optional() })]))
      .optional()
      .describe("List items, e.g. [\"first\", \"second\"] or [{\"text\": \"task\", \"checked\": true}]."),
    header: z.array(z.string()).optional().describe("Table header cells, e.g. [\"Tool\", \"Purpose\"]."),
    rows: z.array(z.array(z.string())).optional().describe("Table rows, e.g. [[\"chat\", \"coordination\"]]."),
    attrs: attrsSchema.optional()
  });

  const tools = {
    get_outline: {
      description:
        "Get the document outline: every block's id, type, heading level, and an 80-character preview. ONLY for large documents shown as an outline — never call it when the full document is already in the conversation.",
      inputSchema: z.object({}),
      execute: async () => {
        emitActivity("Reading document outline", "get_outline");
        return { ok: true, outline: outlineOf(doc) };
      }
    },

    read_blocks: {
      description:
        `Read up to ${READ_BLOCKS_MAX} blocks in full by id. ONLY for large documents shown as an outline — never call it when the full document is already in the conversation.`,
      inputSchema: z.object({
        ids: z.array(z.string()).describe("Block ids to read, e.g. [\"b01\", \"b02\"].")
      }),
      execute: async ({ ids }) => {
        if (!Array.isArray(ids) || ids.length === 0) {
          return { ok: false, error: "ids must be a non-empty array of block ids." };
        }
        if (ids.length > READ_BLOCKS_MAX) {
          return {
            ok: false,
            error: `Too many ids (${ids.length}). Read at most ${READ_BLOCKS_MAX} blocks per call.`
          };
        }
        emitActivity(
          `Reading ${ids.length} block${ids.length === 1 ? "" : "s"}`,
          "read_blocks"
        );
        const missing = ids.filter((id) => !findBlock(id));
        if (missing.length > 0) {
          return {
            ok: false,
            error: `Blocks not found: ${missing.join(", ")}. Use get_outline to see the current block ids.`,
            outline: outlineOf(doc)
          };
        }
        return {
          ok: true,
          blocks: ids.map((id) => {
            const b = findBlock(id);
            seenIds.add(id);
            return { id: b.id, type: b.type, text: b.text, attrs: b.attrs };
          })
        };
      }
    },

    replace_in_block: {
      description:
        "Replace a few words inside one block. `find` must match the block text and occur exactly once; copy it character-for-character from the block. The match is retried with whitespace and quote normalization if the exact text is absent.",
      inputSchema: z.object({
        blockId: z.string().describe("Id of the block to edit."),
        find: z.string().describe("Exact text to find, copied from the block."),
        replace: z.string().describe("Replacement text (\"\" deletes the found text).")
      }),
      execute: async ({ blockId, find, replace }) => {
        const block = findBlock(blockId);
        if (!block) return notFound(blockId);
        if (block.type === "spacer") return { ok: false, error: "Spacers contain no text. Use set_block_attrs with heightPt to resize blank space." };
        const unseen = requireSeen(blockId, "edit it");
        if (unseen) return unseen;
        if (typeof find !== "string" || find.trim().length === 0) {
          return { ok: false, error: "find must be a non-empty string copied exactly from the block text." };
        }
        if (typeof replace !== "string") {
          return { ok: false, error: "replace must be a string (use \"\" to delete the found text)." };
        }
        if (state.editCount >= maxEdits) return editLimitError();

        // (a) exact match — must occur exactly once.
        let matchStart = -1;
        let matchEnd = -1;
        let usedFallback = false;
        const first = block.text.indexOf(find);
        if (first !== -1) {
          if (block.text.indexOf(find, first + 1) !== -1) {
            return {
              ok: false,
              error: `The find text occurs more than once in block ${blockId}. Extend find with surrounding words so it is unique. Current text:\n${block.text}`
            };
          }
          matchStart = first;
          matchEnd = first + find.length;
        } else {
          // (a2) literal escaped-newline rescue (1.5 behavior).
          if (find.includes("\\n") && !find.includes("\n")) {
            const unescaped = normalizeEscapedNewlines(find, block.type);
            const at = block.text.indexOf(unescaped);
            if (at !== -1 && block.text.indexOf(unescaped, at + 1) === -1) {
              matchStart = at;
              matchEnd = at + unescaped.length;
              usedFallback = true;
            }
          }
          // (b) normalized retry: NBSP/whitespace collapse + curly punctuation,
          // mapped back to original offsets. Still must occur exactly once.
          if (matchStart === -1) {
            const built = buildNormalizedText(block.text);
            const normFind = normalizeFindString(find);
            if (normFind.trim() !== "") {
              const nAt = built.norm.indexOf(normFind);
              if (nAt !== -1 && built.norm.indexOf(normFind, nAt + 1) === -1) {
                matchStart = built.starts[nAt];
                matchEnd = built.ends[nAt + normFind.length - 1];
                usedFallback = true;
              }
            }
          }
        }

        if (matchStart === -1) {
          return {
            ok: false,
            error: `The find text does not occur in block ${blockId}. Copy it exactly from the block's current text:\n${block.text}`
          };
        }

        const replaceText = normalizeEscapedNewlines(replace, block.type);
        // Splice the ORIGINAL text so inline markers outside the span survive.
        const next =
          block.text.slice(0, matchStart) + replaceText + block.text.slice(matchEnd);
        if (next.length > maxBlockChars) return overLimit(next.length);
        if (block.type === "heading") {
          const heading = validateHeadingText(next);
          if (!heading.ok) return heading;
        }
        const sizeError = documentLimitError(next.length - block.text.length);
        if (sizeError) return sizeError;
        if (replaceText !== replace) state.newlineNormalized += 1;
        if (usedFallback) state.newlineNormalized += 1;
        emitActivity(`Editing: ${blockLabel(block)}`, "replace_in_block");
        const before = block.text;
        block.text = next;
        state.editCount += 1;
        emitEdit({ op: "replace_in_block", blockId, before, after: next });
        return { ok: true, blockId };
      }
    },

    replace_block: {
      description:
        "Replace a whole block's content. For paragraphs, headings, quotes and code pass text. For lists pass items; for tables pass header and rows. Omit type to keep the block type. Set type only to convert between heading and paragraph when repairing structure; conversion clears old block overrides and preserves the id.",
      inputSchema: z.object({
        blockId: z.string().describe("Id of the block to replace."),
        type: z.enum(["paragraph", "heading"]).optional().describe("Optional heading/paragraph conversion. A new heading requires attrs.level. Omit for ordinary rewrites."),
        text: z.string().optional().describe("Markdown text (paragraph, heading, blockquote, codeBlock)."),
        items: z
          .array(z.union([z.string(), z.object({ text: z.string(), checked: z.boolean().optional() })]))
          .optional()
          .describe("List items, e.g. [\"first\", \"second\"] or [{\"text\": \"task\", \"checked\": true}]."),
        header: z.array(z.string()).optional().describe("Table header cells, e.g. [\"Tool\", \"Purpose\"]."),
        rows: z.array(z.array(z.string())).optional().describe("Table rows, e.g. [[\"chat\", \"coordination\"]]."),
        attrs: attrsSchema.optional()
      }),
      execute: async ({ blockId, type, text, items, header, rows, attrs }) => {
        const block = findBlock(blockId);
        if (!block) return notFound(blockId);
        const unseen = requireSeen(blockId, "rewrite it");
        if (unseen) return unseen;
        if (state.editCount >= maxEdits) return editLimitError();
        const targetType = type || block.type;
        const converting = targetType !== block.type;
        if (converting && (!["heading", "paragraph"].includes(block.type) || !["heading", "paragraph"].includes(targetType))) {
          return { ok: false, error: "Type conversion is supported only between heading and paragraph blocks." };
        }
        const checkedAttrs = validateAttrs(targetType, attrs);
        if (!checkedAttrs.ok) return checkedAttrs;

        const built = buildBlockTextForType({
          type: targetType,
          text,
          items,
          header,
          rows
        });
        if (!built.ok) return built;
        const blockText = built.text;
        if (blockText.length > maxBlockChars) return overLimit(blockText.length);
        const sizeError = documentLimitError(blockText.length - block.text.length);
        if (sizeError) return sizeError;
        const nextAttrs = { ...(converting ? {} : block.attrs), ...checkedAttrs.attrs };
        for (const [key, value] of Object.entries(attrs || {})) {
          if (value === null) delete nextAttrs[key];
        }
        if (targetType === "heading" && nextAttrs.level == null) {
          if (built.impliedLevel != null) nextAttrs.level = built.impliedLevel;
          else return { ok: false, error: "Heading blocks require attrs.level (1-6); it cannot be cleared." };
        }
        if (targetType !== "heading") delete nextAttrs.level;

        emitActivity(`Rewriting: ${blockLabel(block)}`, "replace_block");
        const before = block.text;
        block.text = blockText;
        block.type = targetType;
        block.attrs = nextAttrs;

        // Warn (without blocking) when a block shrinks by more than 70%.
        const beforeLen = before.trim().length;
        const afterLen = blockText.trim().length;
        const largeShrink = beforeLen > 0 && afterLen < beforeLen * 0.3;

        state.editCount += 1;
        const edit = { op: "replace", blockId, before, after: blockText };
        if (attrs || converting) edit.attrs = { ...block.attrs };
        if (converting) edit.type = targetType;
        if (largeShrink) {
          edit.warnings = [{ blockId, code: "large_shrink" }];
          state.warnings.push({ blockId, code: "large_shrink" });
        }
        emitEdit(edit);
        return { ok: true, blockId };
      }
    },

    insert_blocks: {
      description:
        `Insert SEVERAL new blocks at once, in document order, after the block with id \`afterId\` (null = at the start). This is the tool for writing a draft or adding a whole section: one call, up to ${INSERT_BLOCKS_MAX} blocks, each block {type, text | items | header+rows, attrs}. Prefer this over repeated insert_block calls. Returns the new block ids in order.`,
      inputSchema: z.object({
        afterId: z.string().nullable().optional()
          .describe("Id of the block to insert after, or null to insert at the start of the document."),
        blocks: z
          .array(newBlockSchema)
          .describe("The new blocks in reading order, e.g. [{\"type\":\"heading\",\"text\":\"Title\",\"attrs\":{\"level\":1}},{\"type\":\"paragraph\",\"text\":\"Intro…\"}].")
      }),
      execute: async ({ afterId, blocks }) => {
        if (!Array.isArray(blocks) || blocks.length === 0) {
          return {
            ok: false,
            error: 'blocks must be a non-empty array of {type, text|items|header+rows}, e.g. [{"type":"paragraph","text":"Hello"}].'
          };
        }
        if (blocks.length > INSERT_BLOCKS_MAX) {
          return {
            ok: false,
            error: `Too many blocks (${blocks.length}). Insert at most ${INSERT_BLOCKS_MAX} blocks per call.`
          };
        }
        if (state.editCount + blocks.length > maxEdits) {
          return {
            ok: false,
            code: "edit_limit",
            error: `This call would exceed the edit limit (${maxEdits} edits per request, ${state.editCount} used). Insert fewer blocks.`
          };
        }
        const where = indexAfter(afterId);
        if (!where.ok) return where;

        // Validate EVERY block before touching the document: a bad block in
        // the middle of a batch must not leave a half-written draft.
        const prepared = [];
        for (let i = 0; i < blocks.length; i++) {
          const spec = blocks[i];
          if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
            return { ok: false, error: `Block ${i + 1} must be an object {type, text|items|header+rows}.` };
          }
          const r = prepareNewBlock(spec);
          if (!r.ok) {
            return { ok: false, error: `Block ${i + 1} of ${blocks.length} is invalid: ${r.error}` };
          }
          prepared.push(r);
        }
        const sizeError = documentLimitError(prepared.reduce((sum, block) => sum + block.text.length, 0));
        if (sizeError) return sizeError;

        emitActivity(
          `Writing ${prepared.length} block${prepared.length === 1 ? "" : "s"}`,
          "insert_blocks"
        );
        const ids = [];
        let index = where.index;
        let anchor = where.anchor;
        for (const p of prepared) {
          const id = commitInsert(p, index, anchor);
          ids.push(id);
          index += 1;
          anchor = id;
        }
        return { ok: true, blockIds: ids, count: ids.length };
      }
    },

    insert_block: {
      description:
        "Insert ONE new block after afterId (null = start). For requested blank space use type spacer, omit text, and set attrs.heightPt (24-360 points, default144). Never use horizontalRule as blank space. For paragraphs/headings/quotes/code pass text; headings need attrs.level. Lists use items; tables use header and rows. For several blocks use insert_blocks. Returns the new block id.",
      inputSchema: z.object({
        afterId: z.string().nullable().optional()
          .describe("Id of the block to insert after, or null to insert at the start."),
        type: z.enum(BLOCK_TYPES).describe("Type of the new block."),
        text: z.string().optional().describe("Markdown text (paragraph, heading, blockquote, codeBlock)."),
        items: z
          .array(z.union([z.string(), z.object({ text: z.string(), checked: z.boolean().optional() })]))
          .optional()
          .describe("List items, e.g. [\"first\", \"second\"] or [{\"text\": \"task\", \"checked\": true}]."),
        header: z.array(z.string()).optional().describe("Table header cells, e.g. [\"Tool\", \"Purpose\"]."),
        rows: z.array(z.array(z.string())).optional().describe("Table rows, e.g. [[\"chat\", \"coordination\"]]."),
        attrs: attrsSchema.optional()
      }),
      execute: async ({ afterId, type, text, items, header, rows, attrs }) => {
        if (state.editCount >= maxEdits) return editLimitError();
        const prepared = prepareNewBlock({ type, text, items, header, rows, attrs });
        if (!prepared.ok) return prepared;
        const sizeError = documentLimitError(prepared.text.length);
        if (sizeError) return sizeError;
        const where = indexAfter(afterId);
        if (!where.ok) return where;

        emitActivity(
          `Adding ${type === "paragraph" ? "a paragraph" : `a ${type} block`}`,
          "insert_block"
        );
        const id = commitInsert(prepared, where.index, where.anchor);
        return { ok: true, blockId: id };
      }
    },

    delete_block: {
      description:
        "Delete a block by id. Only delete content the user asked to remove.",
      inputSchema: z.object({
        blockId: z.string().describe("Id of the block to delete.")
      }),
      execute: async ({ blockId }) => {
        const at = doc.findIndex((b) => b.id === blockId);
        if (at === -1) return notFound(blockId);
        const unseen = requireSeen(blockId, "delete it");
        if (unseen) return unseen;
        if (state.editCount >= maxEdits) return editLimitError();
        const block = doc[at];
        emitActivity(`Deleting: ${blockLabel(block)}`, "delete_block");
        doc.splice(at, 1);
        state.editCount += 1;
        emitEdit({ op: "delete", blockId, before: block.text });
        return { ok: true, blockId };
      }
    },

    set_block_attrs: {
      description:
        "Style one block without changing its text: font, size, spacing, color, alignment, heading level or table appearance. Null clears an override; heading level cannot be cleared. Existing attrs are preserved. Prefer set_block_styles for several blocks sharing styles.",
      inputSchema: z.object({
        blockId: z.string().describe("Id of the block to style."),
        attrs: attrsSchema
      }),
      execute: async ({ blockId, attrs }) => {
        const result = styleBlocks([blockId], attrs, "set_block_attrs");
        if (!result.ok) return result;
        return { ok: true, ...result.blocks[0], ...(result.noChange ? { noChange: true, note: result.note } : {}) };
      }
    },

    set_block_styles: {
      description:
        `Apply the same attrs to up to ${STYLE_BLOCKS_MAX} existing blocks without touching their text. The entire batch is validated before any edits. Table attrs require all targets to be tables. Null clears overrides; unchanged blocks use no edit budget.`,
      inputSchema: z.object({
        blockIds: z.array(z.string().min(1)).min(1).max(STYLE_BLOCKS_MAX),
        attrs: attrsSchema
      }).strict(),
      execute: async ({ blockIds, attrs }) => styleBlocks(blockIds, attrs, "set_block_styles")
    },

    set_document_style: {
      description:
        "Set cohesive document defaults, including future inserts, without changing text or block attrs. Send {style:{preset:...}} to choose a preset; changing preset resets previous document overrides before merging this call. Null clears an override, not preset. Explicit block attrs still take precedence.",
      inputSchema: z.object({ style: documentStyleSchema }).strict(),
      execute: async ({ style }) => {
        const checked = validateDocumentStyle(style, { partial: true });
        if (!checked.ok) return checked;
        const before = { ...state.documentStyle };
        const after = checked.style.preset !== undefined && checked.style.preset !== before.preset
          ? { preset: checked.style.preset }
          : { ...before };
        Object.assign(after, checked.style);
        for (const [key, value] of Object.entries(style)) {
          if (value === null) delete after[key];
        }
        if (sameAttrs(before, after)) {
          return { ok: true, documentStyle: after, noChange: true, note: "Document defaults already match. Do not repeat this style call." };
        }
        if (state.editCount >= maxEdits) return editLimitError();
        emitActivity("Styling document defaults", "set_document_style");
        state.documentStyle = after;
        state.editCount += 1;
        emitEdit({ op: "set_document_style", blockId: STYLE_SPEC.documentStyleId, before, after: { ...after } });
        return { ok: true, documentStyle: { ...after } };
      }
    }
  };

  if (limits.blankSpaceOnly) {
    for (const [name, tool] of Object.entries(tools)) {
      if (name === "get_outline" || name === "read_blocks") continue;
      const execute = tool.execute;
      tool.execute = async (input, ...rest) => {
        const spacingAttrs = Object.keys(input.attrs || {}).every(key => ["heightPt", "spaceBeforePt", "spaceAfterPt"].includes(key));
        const allowed = name === "insert_block" ? input.type === "spacer"
          : name === "insert_blocks" ? Array.isArray(input.blocks) && input.blocks.every(block => block?.type === "spacer")
          : ["set_block_attrs", "set_block_styles"].includes(name) && spacingAttrs;
        if (!allowed) return {
          ok: false, code: "scope_violation",
          error: "This request allows blank spacing only. Insert spacer blocks or adjust their height/paragraph spacing. Do not add text, flowcharts, diagrams, labels or horizontal rules, and do not rewrite or delete existing content."
        };
        return execute(input, ...rest);
      };
    }
  }

  return { tools, state };
}

module.exports = { createLabsTools, READ_BLOCKS_MAX, INSERT_BLOCKS_MAX, STYLE_BLOCKS_MAX, normalizeEscapedNewlines };
