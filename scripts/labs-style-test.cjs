#!/usr/bin/env node
const assert = require("node:assert/strict");
const { z } = require("zod");
const spec = require("../shared/labsStyles.json");
const { validateAttrs, validateDocumentStyle, validateIncomingBlocks, outlineOf } = require("../server/labs/blocks");
const { createLabsTools } = require("../server/labs/tools");
const { buildUserContent } = require("../server/labs/engine");

const paragraph = (id, attrs = {}) => ({ id, type: "paragraph", text: "Keep **these** exact words.", attrs });
const table = (id, attrs = {}) => ({ id, type: "table", text: "| A | B |\n| --- | --- |\n| a | b |", attrs });
function harness(doc = [], documentStyle, limits = {}) {
  const edits = [];
  const activities = [];
  const result = createLabsTools({
    doc, documentStyle,
    emitEdit: (edit) => edits.push(edit),
    emitActivity: (label, tool) => activities.push({ label, tool }),
    limits: { maxEdits: 40, maxBlockChars: 20000, ...limits }
  });
  return { ...result, doc, edits, activities };
}

let passed = 0;
async function test(label, fn) {
  await fn();
  passed += 1;
  console.log(`PASS: ${label}`);
}

async function main() {
  await test("all allowlisted fonts, table variants and colors validate", () => {
    for (const fontFamily of spec.fonts) assert.equal(validateAttrs("paragraph", { fontFamily }).ok, true);
    for (const tableVariant of spec.tableVariants) assert.equal(validateAttrs("table", { tableVariant }).ok, true);
    for (const key of spec.tableColorAttrs) {
      for (const value of ["#abc", "#A1B2C3", "white", null]) assert.equal(validateAttrs("table", { [key]: value }).ok, true);
      assert.match(validateAttrs("table", { [key]: "url(evil)" }).error, /hex color/);
    }
    assert.match(validateAttrs("paragraph", { fontFamily: "Comic Sans" }).error, /Inter/);
    assert.match(validateAttrs("table", { tableVariant: "fancy" }).error, /striped/);
  });

  await test("numeric attrs accept boundaries and zero spacing but reject coercion/nonfinite/range errors", () => {
    for (const [key, [min, max]] of Object.entries(spec.numberAttrs)) {
      const type = key === "tableCellPaddingPt" ? "table" : "paragraph";
      for (const value of [min, max, null]) assert.equal(validateAttrs(type, { [key]: value }).ok, true);
      for (const value of [String(min), false, NaN, Infinity, -Infinity, min - 0.1, max + 0.1]) {
        const result = validateAttrs(type, { [key]: value });
        assert.equal(result.ok, false, `${key}: ${value}`);
        assert.match(result.error, /finite number between/);
      }
    }
    assert.deepEqual(validateAttrs("paragraph", { spaceBeforePt: 0, spaceAfterPt: 0 }).attrs, { spaceBeforePt: 0, spaceAfterPt: 0 });
  });

  await test("table-only attrs are rejected on other blocks even when null", () => {
    for (const key of ["tableVariant", "tableCellPaddingPt", ...spec.tableColorAttrs]) {
      assert.match(validateAttrs("paragraph", { [key]: null }).error, /only allowed on table blocks/);
    }
  });

  await test("legacy attrs survive and unknown attrs give actionable errors", () => {
    const attrs = { textColor: "blue", backgroundColor: "#fff", align: "center", level: 2, language: "js" };
    assert.deepEqual(validateAttrs("heading", attrs), { ok: true, attrs });
    assert.match(validateAttrs("paragraph", { arbitraryCss: null }).error, /Unknown attr.*Allowed attrs/);
  });

  await test("incoming blocks clone style attrs and reserve the document-style id", () => {
    const blocks = [paragraph("a", { fontFamily: "Inter", spaceAfterPt: 0 }), table("b", { tableVariant: "grid" })];
    const result = validateIncomingBlocks(blocks);
    assert.equal(result.ok, true);
    assert.deepEqual(result.blocks, blocks);
    assert.notEqual(result.blocks[0].attrs, blocks[0].attrs);
    assert.match(validateIncomingBlocks([paragraph(spec.documentStyleId)]).error, /reserved id/);
    assert.equal(validateIncomingBlocks([paragraph("a", { fontSizePt: "12" })]).ok, false);
  });

  await test("document style defaults, nullable overrides and shared bounds validate", () => {
    assert.deepEqual(validateDocumentStyle().style, { preset: spec.defaultPreset });
    assert.deepEqual(validateDocumentStyle({ fontFamily: null, spaceAfterPt: 0 }).style, { preset: spec.defaultPreset, spaceAfterPt: 0 });
    for (const preset of Object.keys(spec.presets)) assert.equal(validateDocumentStyle({ preset }).ok, true);
    for (const marginMm of spec.documentNumberAttrs.marginMm) assert.equal(validateDocumentStyle({ marginMm }).ok, true);
    for (const style of [null, [], "bad", { preset: null }, { preset: "unknown" }, { preset: "__proto__" },
      { marginMm: 11 }, { marginMm: 33 }, { marginMm: "22" }, { lineHeight: Infinity }, { spaceAfterPt: -1 },
      { fontFamily: "Unknown" }, { tableVariant: "grid" }, { spaceBeforePt: 10 }]) {
      assert.equal(validateDocumentStyle(style).ok, false, JSON.stringify(style));
    }
  });

  await test("typed strict nullable schemas cover all block-writing tools", () => {
    const h = harness();
    const allAttrs = {
      textColor: null, backgroundColor: null, align: null, level: null, language: null, fontFamily: null, heightPt: null,
      ...Object.fromEntries(Object.keys(spec.numberAttrs).map((key) => [key, null])),
      tableVariant: null, ...Object.fromEntries(spec.tableColorAttrs.map((key) => [key, null]))
    };
    const args = {
      set_block_attrs: { blockId: "a", attrs: allAttrs },
      set_block_styles: { blockIds: ["a"], attrs: allAttrs },
      insert_block: { type: "table", attrs: allAttrs },
      insert_blocks: { blocks: [{ type: "table", attrs: allAttrs }] },
      replace_block: { blockId: "a", attrs: allAttrs }
    };
    for (const [name, input] of Object.entries(args)) {
      const schema = h.tools[name].inputSchema;
      assert.equal(schema.safeParse(input).success, true, name);
      const json = z.toJSONSchema(schema);
      const attrs = name === "insert_blocks" ? json.properties.blocks.items.properties.attrs : json.properties.attrs;
      assert.equal(attrs.additionalProperties, false, name);
      assert.deepEqual(Object.keys(attrs.properties).sort(), Object.keys(allAttrs).sort());
    }
    const schema = h.tools.set_block_styles.inputSchema;
    for (const attrs of [{ surprise: true }, { fontSizePt: "12" }, { fontSizePt: NaN }, { lineHeight: 5 }, { fontFamily: "Unknown" }]) {
      assert.equal(schema.safeParse({ blockIds: ["a"], attrs }).success, false);
    }
    assert.equal(h.tools.set_document_style.inputSchema.safeParse({ style: { preset: "academic", marginMm: null, spaceAfterPt: 0 } }).success, true);
    assert.equal(h.tools.set_document_style.inputSchema.safeParse({ style: { preset: null } }).success, false);
    assert.equal(h.tools.set_document_style.inputSchema.safeParse({ style: { unknown: null } }).success, false);
  });

  await test("style batches preserve text and send full attrs with one activity", async () => {
    const doc = [paragraph("a", { align: "center" }), paragraph("b", { textColor: "red" })];
    const original = structuredClone(doc);
    const h = harness(doc, undefined, { inlineDoc: false });
    const attrs = { fontFamily: "Georgia", fontSizePt: 12, spaceAfterPt: 0 };
    const result = await h.tools.set_block_styles.execute({ blockIds: ["a", "b"], attrs });
    assert.equal(result.ok, true);
    assert.equal(result.count, 2);
    assert.equal(h.activities.length, 1);
    assert.equal(h.activities[0].tool, "set_block_styles");
    assert.equal(h.state.editCount, 2);
    for (let i = 0; i < doc.length; i++) {
      assert.equal(doc[i].text, original[i].text);
      assert.equal(doc[i].type, original[i].type);
      assert.deepEqual(h.edits[i], { op: "set_attrs", blockId: doc[i].id, before: original[i].attrs,
        after: { ...original[i].attrs, ...attrs }, attrs: { ...original[i].attrs, ...attrs } });
    }
  });

  await test("single-block tool uses the same merge and null-clearing logic", async () => {
    const h = harness([paragraph("a", { fontFamily: "Georgia", spaceBeforePt: 4, align: "right" })]);
    const result = await h.tools.set_block_attrs.execute({ blockId: "a", attrs: { fontFamily: null, spaceBeforePt: 0 } });
    assert.deepEqual(result, { ok: true, blockId: "a", attrs: { spaceBeforePt: 0, align: "right" } });
    assert.deepEqual(h.edits[0].after, result.attrs);
    assert.equal(h.activities.length, 1);
  });

  await test("missing, duplicate, invalid-type, unknown and invalid-heading batches are atomic", async () => {
    for (const args of [
      { blockIds: ["a", "missing"], attrs: { fontFamily: "Georgia" } },
      { blockIds: ["a", "a"], attrs: { fontFamily: "Georgia" } },
      { blockIds: ["t", "a"], attrs: { tableVariant: "grid" } },
      { blockIds: ["a", "h"], attrs: { level: null } },
      { blockIds: ["a", "h"], attrs: { unknown: null } },
      { blockIds: [], attrs: {} }, { blockIds: ["a"], attrs: null }
    ]) {
      const doc = [paragraph("a"), table("t"), { id: "h", type: "heading", text: "Title", attrs: { level: 1 } }];
      const original = structuredClone(doc);
      const h = harness(doc);
      assert.equal((await h.tools.set_block_styles.execute(args)).ok, false);
      assert.deepEqual(doc, original);
      assert.equal(h.edits.length, 0);
      assert.equal(h.activities.length, 0);
      assert.equal(h.state.editCount, 0);
    }
  });

  await test("batches reject budget overflow before mutation and count only changed blocks", async () => {
    const h = harness([paragraph("a"), paragraph("b", { fontSizePt: 12 })], undefined, { maxEdits: 1 });
    assert.equal((await h.tools.set_block_styles.execute({ blockIds: ["a", "b"], attrs: { fontSizePt: 13 } })).ok, false);
    assert.equal(h.edits.length, 0);
    assert.deepEqual(h.doc[0].attrs, {});
    const result = await h.tools.set_block_styles.execute({ blockIds: ["a", "b"], attrs: { fontSizePt: 12 } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.blockIds, ["a"]);
    assert.equal(h.state.editCount, 1);
    const noop = await h.tools.set_block_styles.execute({ blockIds: ["a", "b"], attrs: { fontSizePt: 12 } });
    assert.equal(noop.noChange, true);
    assert.equal((await h.tools.set_block_attrs.execute({ blockId: "a", attrs: { fontSizePt: 12 } })).noChange, true);
    assert.equal(h.edits.length, 1);
    assert.equal(h.activities.length, 1);
  });

  await test("40-block style limit is enforced without changing edit budgets", async () => {
    const doc = Array.from({ length: 41 }, (_, i) => paragraph(`b${i}`));
    const h = harness(doc);
    assert.equal((await h.tools.set_block_styles.execute({ blockIds: doc.map((b) => b.id), attrs: { spaceAfterPt: 0 } })).ok, false);
    assert.equal(h.state.editCount, 0);
    assert.equal((await h.tools.set_block_styles.execute({ blockIds: doc.slice(0, 40).map((b) => b.id), attrs: { spaceAfterPt: 0 } })).count, 40);
    assert.equal(h.state.editCount, 40);
    assert.equal(h.activities.length, 1);
  });

  await test("document style edits use reserved id and full maps, not blocks", async () => {
    const doc = [paragraph("a", { fontSizePt: 14 })];
    const original = structuredClone(doc);
    const initial = { preset: "editorial", fontFamily: "Arial", fontSizePt: 13, marginMm: 26 };
    const h = harness(doc, initial);
    assert.notEqual(h.state.documentStyle, initial);
    assert.equal((await h.tools.set_document_style.execute({ style: { lineHeight: 1.8, spaceAfterPt: 0 } })).ok, true);
    assert.deepEqual(h.edits[0], { op: "set_document_style", blockId: spec.documentStyleId, before: initial,
      after: { ...initial, lineHeight: 1.8, spaceAfterPt: 0 } });
    assert.equal(h.state.editCount, 1);
    assert.deepEqual(doc, original);
    assert.deepEqual(initial, { preset: "editorial", fontFamily: "Arial", fontSizePt: 13, marginMm: 26 });
  });

  await test("changed preset clears old document overrides before merging", async () => {
    const h = harness([], { preset: "editorial", fontFamily: "Arial", fontSizePt: 13, marginMm: 26 });
    const result = await h.tools.set_document_style.execute({ style: { preset: "academic", spaceAfterPt: 0 } });
    assert.deepEqual(result.documentStyle, { preset: "academic", spaceAfterPt: 0 });
    assert.deepEqual(h.state.documentStyle, result.documentStyle);
    const samePreset = await h.tools.set_document_style.execute({ style: { preset: "academic", fontFamily: "Cambria" } });
    assert.deepEqual(samePreset.documentStyle, { preset: "academic", spaceAfterPt: 0, fontFamily: "Cambria" });
    const cleared = await h.tools.set_document_style.execute({ style: { fontFamily: null, spaceAfterPt: null } });
    assert.deepEqual(cleared.documentStyle, { preset: "academic" });
  });

  await test("document-style invalid and over-budget calls are atomic; noops succeed at budget", async () => {
    const h = harness([], undefined, { maxEdits: 1 });
    for (const style of [{ preset: null }, { fontFamily: "Unknown" }, { marginMm: 33 }, { fontSizePt: "12" }, { unknown: 1 }, null]) {
      assert.equal((await h.tools.set_document_style.execute({ style })).ok, false);
    }
    assert.equal(h.edits.length, 0);
    assert.equal(h.activities.length, 0);
    assert.deepEqual(h.state.documentStyle, { preset: spec.defaultPreset });
    await h.tools.set_document_style.execute({ style: { fontSizePt: 12 } });
    assert.equal((await h.tools.set_document_style.execute({ style: { fontSizePt: 12 } })).noChange, true);
    assert.equal((await h.tools.set_document_style.execute({ style: { preset: "minimal" } })).ok, false);
    assert.deepEqual(h.state.documentStyle, { preset: spec.defaultPreset, fontSizePt: 12 });
    assert.equal(h.state.editCount, 1);
  });

  await test("new inserts inherit defaults without copying styles into block attrs", async () => {
    const h = harness();
    await h.tools.set_document_style.execute({ style: { preset: "executive", spaceAfterPt: 0 } });
    const result = await h.tools.insert_block.execute({ type: "paragraph", text: "New content" });
    assert.equal(result.ok, true);
    assert.deepEqual(h.doc[0].attrs, {});
    assert.deepEqual(h.state.documentStyle, { preset: "executive", spaceAfterPt: 0 });
  });

  await test("style attrs survive canonical insert and replacement tools", async () => {
    const h = harness();
    const result = await h.tools.insert_blocks.execute({ blocks: [
      { type: "paragraph", text: "Paragraph", attrs: { fontFamily: "Inter", spaceAfterPt: 0 } },
      { type: "table", header: ["A"], rows: [["a"]], attrs: { tableVariant: "grid", tableCellPaddingPt: 6 } }
    ] });
    assert.equal(result.ok, true);
    assert.deepEqual(h.edits[0].attrs, { fontFamily: "Inter", spaceAfterPt: 0 });
    await h.tools.replace_block.execute({ blockId: result.blockIds[0], text: "Changed words", attrs: { fontSizePt: 12 } });
    assert.deepEqual(h.doc[0].attrs, { fontFamily: "Inter", spaceAfterPt: 0, fontSizePt: 12 });
  });

  await test("inline and outline model context include full current attrs and all preset settings", () => {
    const doc = [paragraph("a", { fontFamily: "Georgia", spaceAfterPt: 0 }), table("t", { tableBorderColor: "#abc" })];
    const documentStyle = { preset: "executive", marginMm: 24 };
    for (const inline of [true, false]) {
      const content = buildUserContent({ doc, documentStyle, instruction: "Style only", inline });
      assert.ok(content.includes(JSON.stringify(doc[0].attrs)));
      assert.ok(content.includes(JSON.stringify(doc[1].attrs)));
      assert.ok(content.includes(JSON.stringify(documentStyle)));
      assert.ok(content.includes(JSON.stringify(spec.presets)));
      assert.match(content, /existing and future/);
    }
    assert.deepEqual(outlineOf(doc)[0].attrs, doc[0].attrs);
    assert.match(buildUserContent({ doc: [], instruction: "Use academic style", inline: true }), /styling-only requests/);
  });

  await test("route rejects invalid style before SSE and passes independent normalized defaults to engine", async () => {
    const enginePath = require.resolve("../server/labs/engine");
    const routePath = require.resolve("../server/labs/route");
    const originalEngine = require.cache[enginePath].exports;
    const originalRoute = require.cache[routePath];
    const originalKey = process.env.GEMINI_API_KEY;
    const calls = [];
    try {
      require.cache[enginePath].exports = { ...originalEngine, runLabsAgent: async (args) => calls.push(args) };
      delete require.cache[routePath];
      let handler;
      require("../server/labs/route").registerLabsAgentRoute({ post: (path, fn) => { assert.equal(path, "/labs/agent"); handler = fn; } });
      process.env.GEMINI_API_KEY = "test-placeholder-not-used";
      const invoke = async (extra) => {
        const req = { body: { projectId: "test", blocks: [paragraph("a")], instruction: "Style only", ...extra }, on() {} };
        const res = { status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; },
          writeHead(code) { this.statusCode = code; this.streamed = true; }, write() {}, on() {}, end() { this.writableEnded = true; } };
        await handler(req, res);
        return res;
      };
      for (const documentStyle of [{ preset: null }, { marginMm: 33 }, { fontSizePt: "11" }, { unknown: true }, null]) {
        const res = await invoke({ documentStyle });
        assert.equal(res.statusCode, 400);
        assert.equal(res.streamed, undefined);
      }
      const reserved = await invoke({ blocks: [paragraph(spec.documentStyleId)] });
      assert.equal(reserved.statusCode, 400);
      assert.equal(calls.length, 0);
      assert.equal((await invoke({})).statusCode, 200);
      assert.deepEqual(calls[0].documentStyle, { preset: spec.defaultPreset });
      assert.equal((await invoke({ documentStyle: { preset: "minimal", fontFamily: null, spaceAfterPt: 0 } })).statusCode, 200);
      assert.deepEqual(calls[1].documentStyle, { preset: "minimal", spaceAfterPt: 0 });
      assert.deepEqual(calls[1].doc[0].attrs, {});
    } finally {
      require.cache[enginePath].exports = originalEngine;
      delete require.cache[routePath];
      if (originalRoute) require.cache[routePath] = originalRoute;
      if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalKey;
    }
  });

  console.log(`\n${passed} style test groups passed, 0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
