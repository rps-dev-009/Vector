#!/usr/bin/env node
/**
 * Phase 1.6 unit tests: canonical list/table builders, normalized matching
 * (simplified per adjustment A), and validate.js repairs/rejections.
 *
 * Run: node scripts/labs-validate-test.cjs
 * Exits 0 when all checks pass, 1 otherwise.
 */

const assert = require("assert");
const {
  normalizeEscapedNewlines,
  prepareBlockText,
  buildListText,
  buildTableText,
  normalizeListItems,
  canonicalizeListText,
  parsePipeTable,
  canonicalizeTableText,
  isKnownType,
  detectInlineList,
  createRepairsCounter,
  countDuplicateIds
} = require("../server/labs/validate");
const { createLabsTools } = require("../server/labs/tools");
const { validateAttrs, validateIncomingBlocks, STYLE_SPEC } = require("../server/labs/blocks");

let passed = 0;
let failed = 0;
function check(cond, label) {
  if (cond) {
    passed += 1;
    console.log(`PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL: ${label}`);
  }
}

function freshState() {
  return { repairs: createRepairsCounter(), newlineNormalized: 0 };
}

function freshHarness(doc, extraLimits) {
  const edits = [];
  const acts = [];
  const { tools, state } = createLabsTools({
    doc,
    emitEdit: (e) => edits.push(e),
    emitActivity: (label, tool) => acts.push(label),
    limits: { maxEdits: 40, maxBlockChars: 20000, ...(extraLimits || {}) }
  });
  return { tools, state, edits };
}

async function main() {
  /* ── List builders ──────────────────────────────────────────────────────── */

  check(
    buildListText("bulletList", [{ text: "a" }, { text: "b" }]) === "- a\n- b",
    "bulletList builder: '- ' prefix"
  );
  check(
    buildListText("orderedList", [{ text: "x" }, { text: "y" }, { text: "z" }]) === "1. x\n2. y\n3. z",
    "orderedList builder: renumbered '1. ' prefixes"
  );
  check(
    buildListText("taskList", [{ text: "t", checked: true }, { text: "u", checked: false }]) === "- [x] t\n- [ ] u",
    "taskList builder: checkbox states"
  );

  {
    const state = freshState();
    const r = normalizeListItems(["* star", "- dash", "1. num"], "bulletList", state);
    check(r.ok && buildListText("bulletList", r.items) === "- star\n- dash\n- num",
      "normalizeListItems strips markers (bulletList)");
  }
  {
    const state = freshState();
    const r = normalizeListItems([{ text: "task", checked: true }, "- [x] done", "plain"], "taskList", state);
    check(r.ok && buildListText("taskList", r.items) === "- [x] task\n- [x] done\n- [ ] plain",
      "normalizeListItems parses checkboxes ({text,checked} objects and '- [x]' markers) for taskList");
  }
  {
    const state = freshState();
    const r = normalizeListItems(["a\\nb", "c"], "bulletList", state);
    check(r.ok && buildListText("bulletList", r.items) === "- a\n- b\n- c",
      "multi-line item strings are split into items");
  }
  {
    const state = freshState();
    const r = normalizeListItems([], "bulletList", state);
    check(!r.ok && /at least one item/i.test(r.error), "list with zero items is rejected");
  }
  {
    const state = freshState();
    const r = canonicalizeListText("* a\n* b", "bulletList", state);
    check(r.ok && r.text === "- a\n- b", "text-fallback list canonicalizes '*' markers");
  }
  {
    const state = freshState();
    const r = canonicalizeListText("3. x\n9. y", "orderedList", state);
    check(r.ok && r.text === "1. x\n2. y", "text-fallback ordered list is renumbered");
  }
  {
    const state = freshState();
    const r = canonicalizeListText("", "bulletList", state);
    check(!r.ok && /at least one item/i.test(r.error), "text-fallback list with zero items is rejected");
  }

  /* ── Table builders ────────────────────────────────────────────────────── */

  check(
    buildTableText(["A", "B"], [["a|b", "x"], ["c"]]) ===
      "| A | B |\n| --- | --- |\n| a\\|b | x |\n| c |  |",
    "table builder: escapes pipes, separator row, pads/trims rows to header"
  );
  {
    const r = parsePipeTable("| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |");
    check(r.ok && r.header.length === 2 && r.rows.length === 2, "parsePipeTable parses header + rows, skips separator");
  }
  {
    const r = parsePipeTable("| A | B |\n| --- | --- |\n| only-one |");
    check(!r.ok && /inconsistent column counts/i.test(r.error), "parsePipeTable rejects ragged rows");
  }
  {
    const state = freshState();
    const r = canonicalizeTableText("| A | B |\n| --- | --- |\n| 1 | 2 |", state);
    check(r.ok && r.text === "| A | B |\n| --- | --- |\n| 1 | 2 |", "text-fallback table rebuilds identically when canonical");
  }
  {
    const state = freshState();
    const r = canonicalizeTableText("just some words", state);
    check(!r.ok && r.error.includes("header") && r.error.includes("rows"), "text without pipes rejected: use header and rows");
  }
  {
    const state = freshState();
    const r = canonicalizeTableText("| A | B |\n| 1 | 2 |\n| 3 |", state);
    check(!r.ok && /inconsistent column counts/i.test(r.error), "text-fallback table with ragged row is rejected");
  }

  /* ── validate.js repairs (each repair type) ─────────────────────────────── */

  {
    const state = freshState();
    const r = prepareBlockText({ type: "paragraph", text: "  hello  ", state });
    check(r.ok && r.text === "hello" && state.repairs.trim === 1, "repair: trim");
  }
  {
    const state = freshState();
    const r = prepareBlockText({ type: "paragraph", text: "```\nplain text\n```", state });
    check(r.ok && r.text === "plain text" && state.repairs.strip_fence === 1, "repair: strip wrapping code fence on non-code block");
  }
  {
    const state = freshState();
    const r = prepareBlockText({ type: "heading", text: "##  Section Title", state });
    check(r.ok && r.text === "Section Title" && r.impliedLevel === 2 && state.repairs.heading_marker === 1,
      "repair: strip heading marker and infer level");
  }
  {
    const state = freshState();
    const r = prepareBlockText({ type: "blockquote", text: "> quoted line\n> second line", state });
    check(r.ok && r.text === "quoted line\nsecond line" && state.repairs.quote_marker === 1,
      "repair: strip blockquote markers");
  }
  {
    const state = freshState();
    const r = prepareBlockText({ type: "paragraph", text: "one\\ntwo", state });
    check(r.ok && r.text === "one\ntwo" && state.repairs.newline === 1, "repair: literal \\n normalization");
  }
  {
    const state = freshState();
    const r = prepareBlockText({ type: "codeBlock", text: "echo hi\\nexit", state });
    check(r.ok && r.text === "echo hi\\nexit", "codeBlock content is never altered (literal \\n kept)");
  }
  {
    const state = freshState();
    const r = prepareBlockText({ type: "horizontalRule", text: "--- some junk", state });
    check(r.ok && r.text === "", "horizontalRule text canonicalized to empty");
  }

  /* ── validate.js rejections (each rejection) ───────────────────────────── */

  {
    const state = freshState();
    const r = prepareBlockText({ type: "paragraph", text: "   ", state });
    check(!r.ok && /cannot have empty text/i.test(r.error), "reject: empty text on a non-hr block");
  }
  check(!isKnownType("nonsense") && isKnownType("paragraph"), "reject: unknown type check");
  {
    const state = freshState();
    const r = prepareBlockText({ type: "paragraph", text: "x".repeat(21), state });
    check(r.ok, "prepareBlockText itself has no size cap (tools enforce it)");
  }
  {
    // over-size via the insert tool (20001 chars)
    const doc = [];
    const { tools } = freshHarness(doc);
    const r = await tools.insert_block.execute({ afterId: null, type: "paragraph", text: "x".repeat(20001), attrs: {} });
    check(!r.ok && /too long/i.test(r.error), "reject: text over the size limit");
  }

  /* ── Structured input through the tools ────────────────────────────────── */

  {
    // insert_block with items for a bullet list
    const doc = [{ id: "b1", type: "paragraph", text: "Intro.", attrs: {} }];
    const { tools, state, edits } = freshHarness(doc);
    const r = await tools.insert_block.execute({ afterId: "b1", type: "bulletList", items: ["one", "two", "three"], attrs: {} });
    const inserted = doc.find((b) => b.id === r.blockId);
    check(r.ok && inserted.text === "- one\n- two\n- three", "insert_block builds list text from items");
    check(edits[0].after === "- one\n- two\n- three", "insert edit event carries the built list text");
  }
  {
    // insert_block with header/rows for a table
    const doc = [];
    const { tools } = freshHarness(doc);
    const r = await tools.insert_block.execute({
      afterId: null,
      type: "table",
      header: ["Tool", "Purpose"],
      rows: [["chat", "daily coordination"], ["docs"]],
      attrs: {}
    });
    const inserted = doc.find((b) => b.id === r.blockId);
    check(
      r.ok && inserted.text === "| Tool | Purpose |\n| --- | --- |\n| chat | daily coordination |\n| docs |  |",
      "insert_block builds canonical table from header/rows (pads short rows)"
    );
  }
  {
    // insert_block for a table with plain text -> actionable error
    const doc = [];
    const { tools } = freshHarness(doc);
    const r = await tools.insert_block.execute({ afterId: null, type: "table", text: "no pipes here", attrs: {} });
    check(!r.ok && r.error.includes("header") && r.error.includes("rows"), "table insert with plain text rejected with actionable error");
  }
  {
    // insert_block heading with marker -> level inferred
    const doc = [];
    const { tools, state } = freshHarness(doc);
    const r = await tools.insert_block.execute({ afterId: null, type: "heading", text: "### Deep section", attrs: {} });
    const inserted = doc.find((b) => b.id === r.blockId);
    check(r.ok && inserted.text === "Deep section" && inserted.attrs.level === 3,
      "heading insert: marker stripped, level inferred from hashes");
  }
  {
    // replace_block with items on an existing list
    const doc = [{ id: "b1", type: "orderedList", text: "1. old one\n2. old two", attrs: {} }];
    const { tools } = freshHarness(doc);
    const r = await tools.replace_block.execute({ blockId: "b1", items: ["new one", "new two", "new three"], attrs: {} });
    check(r.ok && doc[0].text === "1. new one\n2. new two\n3. new three", "replace_block rebuilds ordered list from items");
  }

  /* ── large_shrink warning ──────────────────────────────────────────────── */

  {
    const doc = [{ id: "b1", type: "paragraph", text: "word ".repeat(40).trim(), attrs: {} }];
    const { tools, state, edits } = freshHarness(doc);
    await tools.replace_block.execute({ blockId: "b1", text: "short", attrs: {} });
    check(
      edits[0].warnings && edits[0].warnings[0].code === "large_shrink",
      "replace_block shrinking >70% attaches large_shrink warning to the edit event"
    );
    check(state.warnings.length === 1, "large_shrink warning collected in state.warnings");
  }
  {
    const doc = [{ id: "b1", type: "paragraph", text: "word ".repeat(20).trim(), attrs: {} }];
    const { tools, state, edits } = freshHarness(doc);
    await tools.replace_block.execute({ blockId: "b1", text: "word ".repeat(10).trim(), attrs: {} });
    check(!edits[0].warnings && state.warnings.length === 0, "50% shrink does not warn");
  }

  /* ── Normalized matching (adjustment A scope) ──────────────────────────── */

  {
    // curly quotes/dashes/ellipsis vs ASCII
    const doc = [{ id: "b1", type: "paragraph", text: "It’s a “test” – really…", attrs: {} }];
    const { tools } = freshHarness(doc);
    const r = await tools.replace_in_block.execute({ blockId: "b1", find: "It's a \"test\" - really...", replace: "REPLACED" });
    check(r.ok && doc[0].text === "REPLACED", "matching: curly punctuation matches ASCII find text");
  }
  {
    // double spaces
    const doc = [{ id: "b1", type: "paragraph", text: "alpha  beta   gamma end", attrs: {} }];
    const { tools } = freshHarness(doc);
    const r = await tools.replace_in_block.execute({ blockId: "b1", find: "alpha beta gamma", replace: "X" });
    check(r.ok && doc[0].text === "X end", "matching: collapsed whitespace matches doubled spaces");
  }
  {
    // NBSP
    const doc = [{ id: "b1", type: "paragraph", text: "caf\u00A0é menu", attrs: {} }];
    const { tools } = freshHarness(doc);
    const r = await tools.replace_in_block.execute({ blockId: "b1", find: "caf é", replace: "X" });
    check(r.ok && doc[0].text === "X menu", "matching: NBSP matches a plain space");
  }
  {
    // emphasis markers are NOT special-cased (adjustment A)
    const doc = [{ id: "b1", type: "paragraph", text: "very **important** point", attrs: {} }];
    const { tools } = freshHarness(doc);
    const r = await tools.replace_in_block.execute({ blockId: "b1", find: "very important point", replace: "X" });
    check(!r.ok && r.error.includes("very **important** point"),
      "matching: emphasis markers are not stripped (find must include **), error carries block text");
  }
  {
    // markers outside the matched span survive a normalized match
    const doc = [{ id: "b1", type: "paragraph", text: "**bold** and ‘quoted’ tail", attrs: {} }];
    const { tools } = freshHarness(doc);
    const r = await tools.replace_in_block.execute({ blockId: "b1", find: "'quoted' tail", replace: "REPLACED" });
    check(r.ok && doc[0].text === "**bold** and REPLACED", "matching: original splicing preserves markers outside the span");
  }
  {
    // ambiguous normalized match -> error
    const doc = [{ id: "b1", type: "paragraph", text: "caf\u00A0é one. caf\u00A9é two.", attrs: {} }];
    const { tools } = freshHarness(doc);
    const r = await tools.replace_in_block.execute({ blockId: "b1", find: "café", replace: "X" });
    check(!r.ok, "matching: ambiguous normalized match is rejected");
  }
  {
    // absent -> error includes current block text
    const doc = [{ id: "b1", type: "paragraph", text: "totally different content", attrs: {} }];
    const { tools } = freshHarness(doc);
    const r = await tools.replace_in_block.execute({ blockId: "b1", find: "not there", replace: "X" });
    check(!r.ok && r.error.includes("totally different content"), "matching: absent find returns error with block text");
  }

  {
    // set_block_attrs: null clears an attr (Phase 2 Step 0a)
    const doc = [{ id: "b1", type: "paragraph", text: "Hello world.", attrs: { textColor: "blue", align: "center" } }];
    const { tools, edits } = freshHarness(doc);
    const r = await tools.set_block_attrs.execute({ blockId: "b1", attrs: { textColor: null } });
    check(r.ok && doc[0].attrs.textColor === undefined && doc[0].attrs.align === "center",
      "set_block_attrs: null clears the attr, other attrs kept");
    check(edits[0] && edits[0].after && edits[0].after.textColor === undefined && edits[0].after.align === "center",
      "set_attrs edit event reflects the cleared state");
  }
  {
    // set_block_attrs: heading level cannot be cleared
    const doc = [{ id: "b1", type: "heading", text: "Title", attrs: { level: 2 } }];
    const { tools } = freshHarness(doc);
    const r = await tools.set_block_attrs.execute({ blockId: "b1", attrs: { level: null } });
    check(!r.ok && /cannot be cleared/i.test(r.error), "set_block_attrs: clearing heading level is rejected");
  }
  {
    // set_block_attrs: no-op is idempotent success, NOT an error (an error
    // made the model retry the same call until the step limit).
    const doc = [{ id: "b1", type: "paragraph", text: "Hello.", attrs: { textColor: "blue" } }];
    const { tools, state } = freshHarness(doc);
    const r = await tools.set_block_attrs.execute({ blockId: "b1", attrs: { textColor: "blue" } });
    check(r.ok && r.noChange === true && /No change was needed/.test(r.note) && state.editCount === 0,
      "set_block_attrs: no-op call is idempotent success with no edit (prevents retry loops)");
  }

  /* ── Inline-list detection (run-on paragraph guard) ────────────────────── */
  {
    const numbered = "Key ICT initiatives in Indian agriculture include: 1. Kisan Call Centers provide advisory. 2. mKisan Portal sends SMS. 3. Community Radio broadcasts tips. 4. Social media video extension.";
    check(detectInlineList(numbered) === "numbered", "detectInlineList: ascending 1-2-3 run flagged as numbered");
  }
  {
    const prose = "The project cost 2.5 crore and finished in 3.2 years, a 1.4x overrun versus the plan.";
    check(detectInlineList(prose) === null, "detectInlineList: decimals in prose are NOT flagged");
  }
  {
    const bullets = "Key points to remember about the system: \u2022 first important point here \u2022 second important point here \u2022 third important point here now.";
    check(detectInlineList(bullets) === "bulleted", "detectInlineList: three bullet glyphs flagged as bulleted");
  }
  {
    const state = freshState();
    const r = prepareBlockText({
      type: "paragraph",
      text: "Initiatives include: 1. Kisan Call Centers for advisory services. 2. mKisan Portal for SMS. 3. Community Radio Stations for local tips.",
      state
    });
    check(!r.ok && /orderedList/.test(r.error), "prepareBlockText: inline numbered list in a paragraph is rejected with the orderedList fix");
  }
  {
    const state = freshState();
    const r = prepareBlockText({ type: "paragraph", text: "Communication is the exchange of ideas between a sender and a receiver, and feedback closes the loop.", state });
    check(r.ok, "prepareBlockText: a normal paragraph still passes");
  }

  /* ── Outline-mode read-before-write guard ──────────────────────────────── */
  {
    const doc = [{ id: "b1", type: "paragraph", text: "Original text.", attrs: {} }];
    const { tools } = freshHarness(doc, { inlineDoc: false });
    const r = await tools.replace_block.execute({ blockId: "b1", text: "Rewritten blindly." });
    check(!r.ok && /have not read block/i.test(r.error), "outline mode: replace_block without read_blocks is blocked");
  }
  {
    const doc = [{ id: "b1", type: "paragraph", text: "Original text.", attrs: {} }];
    const { tools, state } = freshHarness(doc, { inlineDoc: false });
    await tools.read_blocks.execute({ ids: ["b1"] });
    const r = await tools.replace_block.execute({ blockId: "b1", text: "Rewritten after reading." });
    check(r.ok && state.editCount === 1, "outline mode: replace_block AFTER read_blocks succeeds");
  }
  {
    const doc = [{ id: "b1", type: "paragraph", text: "Original text.", attrs: {} }];
    const { tools, state } = freshHarness(doc);
    const r = await tools.replace_block.execute({ blockId: "b1", text: "Rewritten directly." });
    check(r.ok && state.editCount === 1, "inline mode: replace_block needs no prior read");
  }

  /* ── insert_blocks batch ───────────────────────────────────────────────── */
  {
    const doc = [];
    const { tools, state, edits } = freshHarness(doc);
    const r = await tools.insert_blocks.execute({
      afterId: null,
      blocks: [
        { type: "heading", text: "Title", attrs: { level: 1 } },
        { type: "paragraph", text: "Intro paragraph." },
        { type: "bulletList", items: ["one", "two", "three"] }
      ]
    });
    check(r.ok && r.count === 3 && state.editCount === 3, "insert_blocks: writes a 3-block draft in one call");
    check(edits[0].afterId === null && edits[1].afterId === edits[0].blockId, "insert_blocks: blocks chain in document order");
  }
  {
    const doc = [];
    const { tools, state } = freshHarness(doc);
    const r = await tools.insert_blocks.execute({
      afterId: null,
      blocks: [{ type: "paragraph", text: "ok" }, { type: "heading", text: "no level" }]
    });
    check(!r.ok && state.editCount === 0 && doc.length === 0, "insert_blocks: an invalid block aborts the batch with no partial writes");
  }

  /* ── End-of-run duplicate id check ─────────────────────────────────────── */

  {
    check(STYLE_SPEC.spacer.defaultHeightPt === 144, "spacers default to two inches of blank space");
    for (const heightPt of [24, 144, 360, null]) {
      check(validateAttrs("spacer", { heightPt }).ok, `spacer height accepts ${heightPt}`);
    }
    for (const heightPt of [0, 23, 361, "144", Infinity, NaN]) {
      check(!validateAttrs("spacer", { heightPt }).ok, `spacer height rejects ${heightPt}`);
    }
    check(!validateAttrs("paragraph", { heightPt: 144 }).ok && !validateAttrs("spacer", { backgroundColor: "blue" }).ok,
      "spacer geometry cannot be confused with paragraph typography or colored placeholders");
    check(validateIncomingBlocks([{ id: "s", type: "spacer", text: "", attrs: {} }]).ok,
      "incoming spacer with inherited height is valid");
    check(!validateIncomingBlocks([{ id: "s", type: "spacer", text: "Diagram", attrs: {} }]).ok,
      "incoming spacer cannot contain text");
  }
  {
    const doc = [{ id: "p", type: "paragraph", text: "Keep this explanation.", attrs: {} }];
    const { tools, edits } = freshHarness(doc);
    const result = await tools.insert_blocks.execute({ afterId: "p", blocks: [
      { type: "spacer", attrs: { heightPt: 144 } }, { type: "spacer" }
    ] });
    check(result.ok && doc.length === 3 && doc[1].text === "" && doc[1].attrs.heightPt === 144 && doc[2].text === "",
      "spacer batches insert actual empty regions with optional height and no text");
    check(edits[1].afterId === edits[0].blockId, "spacers preserve insertion order");
    const id = result.blockIds[0];
    const resized = await tools.set_block_attrs.execute({ blockId: id, attrs: { heightPt: 216 } });
    check(resized.ok && doc[1].attrs.heightPt === 216, "existing blank region can be resized without content edits");
    const cleared = await tools.set_block_attrs.execute({ blockId: id, attrs: { heightPt: null } });
    check(cleared.ok && !Object.hasOwn(doc[1].attrs, "heightPt"), "null spacer height resets to shared default");
    const replaced = await tools.replace_block.execute({ blockId: id, attrs: { heightPt: 180 } });
    check(replaced.ok && doc[1].text === "" && doc[1].attrs.heightPt === 180, "spacer replacement does not require text");
    const invalid = await tools.insert_blocks.execute({ afterId: id, blocks: [
      { type: "spacer" }, { type: "spacer", text: "Not blank" }
    ] });
    check(!invalid.ok && doc.length === 3, "invalid spacer content rejects its entire batch");
    const invalidItems = await tools.insert_block.execute({ type: "spacer", items: ["Not blank"] });
    check(!invalidItems.ok && doc.length === 3, "spacer cannot smuggle content through list items");
  }
  {
    const doc = [{ id: "p", type: "paragraph", text: "Keep all words.", attrs: {} }];
    const { tools, edits } = freshHarness(doc, { blankSpaceOnly: true });
    const calls = [
      ["insert_block", { afterId: "p", type: "horizontalRule" }],
      ["insert_blocks", { afterId: "p", blocks: [{ type: "spacer" }, { type: "paragraph", text: "Unrequested flowchart" }] }],
      ["replace_block", { blockId: "p", text: "New text" }],
      ["replace_in_block", { blockId: "p", find: "words", replace: "diagram" }],
      ["delete_block", { blockId: "p" }],
      ["set_block_attrs", { blockId: "p", attrs: { fontSizePt: 30 } }],
      ["set_document_style", { style: { preset: "academic" } }]
    ];
    for (const [name, input] of calls) {
      const result = await tools[name].execute(input);
      check(!result.ok && result.code === "scope_violation", `blank-only scope rejects ${name} content/appearance changes`);
    }
    check(edits.length === 0 && doc[0].text === "Keep all words.", "scope failures preserve all content with no partial edits");
    const inserted = await tools.insert_block.execute({ afterId: "p", type: "spacer", attrs: { heightPt: 144 } });
    const styled = await tools.set_block_attrs.execute({ blockId: "p", attrs: { spaceAfterPt: 12 } });
    check(inserted.ok && styled.ok && doc[0].text === "Keep all words.", "blank-only scope permits real blank space and paragraph spacing");
  }

  {
    // Regression: the sample assignment stored entire body paragraphs as H2.
    for (const text of ["Pruning is selective removal of branches. ".repeat(25), "Training\n\nBody explanation.", "x".repeat(241)]) {
      const doc = [];
      const { tools, state, edits } = freshHarness(doc);
      const result = await tools.insert_blocks.execute({ afterId: null, blocks: [
        { type: "paragraph", text: "Valid body text." },
        { type: "heading", text, attrs: { level: 2 } }
      ] });
      check(!result.ok && /concise single-line/.test(result.error) && doc.length === 0 && state.editCount === 0 && edits.length === 0,
        "paragraph-sized or multiline heading rejects the whole batch without mutation");
    }
  }
  {
    const doc = [{ id: "h", type: "heading", text: "Pruning", attrs: { level: 2 } }];
    const { tools, edits } = freshHarness(doc);
    const result = await tools.replace_in_block.execute({ blockId: "h", find: "Pruning", replace: "Body explanation. ".repeat(60) });
    check(!result.ok && doc[0].text === "Pruning" && edits.length === 0, "in-block replacement cannot bypass heading guard");
  }
  {
    const body = "Pruning regulates growth and fruit quality. ".repeat(25).trim();
    const doc = [{ id: "bad-h", type: "heading", text: body, attrs: { level: 2, fontSizePt: 19, textColor: "blue" } }];
    const { tools, edits } = freshHarness(doc);
    const result = await tools.replace_block.execute({ blockId: "bad-h", type: "paragraph", text: body });
    check(result.ok && doc[0].type === "paragraph" && doc[0].text === body && Object.keys(doc[0].attrs).length === 0,
      "repairing a prose heading preserves words/id and clears heading overrides");
    check(edits[0].type === "paragraph" && edits[0].blockId === "bad-h" && Object.keys(edits[0].attrs).length === 0,
      "conversion event carries new type and complete attribute map");
    const missingLevel = await tools.replace_block.execute({ blockId: "bad-h", type: "heading", text: "Pruning" });
    check(!missingLevel.ok && doc[0].text === body, "conversion to heading requires a level without mutating content");
    const heading = await tools.replace_block.execute({ blockId: "bad-h", type: "heading", text: "Pruning", attrs: { level: 2 } });
    check(heading.ok && doc[0].type === "heading" && doc[0].attrs.level === 2, "explicit paragraph-to-heading conversion works");
    const clearLevel = await tools.replace_block.execute({ blockId: "bad-h", text: "Pruning", attrs: { level: null } });
    check(!clearLevel.ok && doc[0].attrs.level === 2, "rewrites cannot silently clear required heading level");
  }
  {
    const doc = [{ id: "p", type: "paragraph", text: "Body", attrs: { fontSizePt: 19, textColor: "blue" } }];
    const { tools } = freshHarness(doc);
    const result = await tools.replace_block.execute({ blockId: "p", text: "Body", attrs: { fontSizePt: null } });
    check(result.ok && !Object.hasOwn(doc[0].attrs, "fontSizePt") && doc[0].attrs.textColor === "blue", "rewrite honors null attribute clearing");
  }
  {
    const doc = [{ id: "large", type: "paragraph", text: "x".repeat(199995), attrs: {} }];
    const { tools, edits } = freshHarness(doc);
    const result = await tools.insert_blocks.execute({ afterId: "large", blocks: [
      { type: "paragraph", text: "abcd" }, { type: "paragraph", text: "efgh" }
    ] });
    check(!result.ok && result.code === "document_limit" && doc.length === 1 && edits.length === 0, "total document growth limit is atomic across a batch");
  }
  {
    const doc = [{ id: "large", type: "paragraph", text: "x".repeat(199999), attrs: {} }, { id: "p", type: "paragraph", text: "a", attrs: {} }];
    const { tools, edits } = freshHarness(doc);
    const insert = await tools.insert_block.execute({ afterId: "p", type: "paragraph", text: "b" });
    const replace = await tools.replace_block.execute({ blockId: "p", text: "ab" });
    const inBlock = await tools.replace_in_block.execute({ blockId: "p", find: "a", replace: "ab" });
    check([insert, replace, inBlock].every(result => !result.ok && result.code === "document_limit") && edits.length === 0,
      "single insert and both replacement tools enforce total document limit");
  }
  {
    const doc = [];
    const { tools } = freshHarness(doc);
    const result = await tools.insert_block.execute({ type: "table", header: ["A"], rows: [["one", "must not disappear"]] });
    check(!result.ok && /cells must not be discarded/.test(result.error) && doc.length === 0, "table rows cannot silently lose extra cells");
  }

  check(countDuplicateIds([{ id: "a" }, { id: "b" }]) === 0, "countDuplicateIds: none");
  check(countDuplicateIds([{ id: "a" }, { id: "a" }]) === 1, "countDuplicateIds: detects one");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test harness crashed:", err);
  process.exit(2);
});
