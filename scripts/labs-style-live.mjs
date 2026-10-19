// Focused live tool-contract check. Run against a fresh Labs server:
// node scripts/labs-style-live.mjs http://127.0.0.1:3108
import assert from "node:assert/strict";
const base = process.argv[2] || "http://127.0.0.1:3108";
const blocks = [
  { id: "title", type: "heading", text: "Agricultural extension communication", attrs: { level: 1 } },
  { id: "intro", type: "paragraph", text: "Effective extension connects local knowledge with research, building trust through dialogue and practical demonstrations.", attrs: {} },
  { id: "table", type: "table", text: "| Channel | Strength |\n| --- | --- |\n| Field visit | Trust |\n| Demonstration | Practice |", attrs: {} }
];
const response = await fetch(`${base}/labs/agent`, {
  method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(150000),
  body: JSON.stringify({ projectId: "styling-verification", blocks, documentStyle: { preset: "editorial" }, messages: [],
    instruction: "Do not change any words or insert/delete blocks. Apply the Botanical document preset. Give table id table a #173B57 header with white text, #EDF4F8 alternating rows, and 10 pt cell padding. Set paragraph intro to 12 pt with 12 pt space after. Use formatting tools only." })
});
assert(response.ok, `HTTP ${response.status}`);
const stream = await response.text();
const events = stream.split(/\r?\n\r?\n/).map(frame => {
  const type = frame.match(/^event: (.+)$/m)?.[1];
  const data = frame.match(/^data: (.+)$/m)?.[1];
  return type && data ? { type, data: JSON.parse(data) } : null;
}).filter(Boolean);
const errors = events.filter(e => e.type === "error");
assert.equal(errors.length, 0, JSON.stringify(errors));
const done = events.find(e => e.type === "done")?.data;
assert(done?.ok && !done.truncated, JSON.stringify(done));
const edits = events.filter(e => e.type === "edit").map(e => e.data);
assert(edits.length >= 3, "Expected document, table and paragraph formatting");
assert(edits.every(e => ["set_attrs", "set_document_style"].includes(e.op)), "Styling must not rewrite content");
assert(edits.some(e => e.op === "set_document_style" && e.after.preset === "botanical"));
const tableEdit = edits.filter(e => e.blockId === "table").at(-1);
assert.equal(tableEdit.after.tableHeaderBackground.toUpperCase(), "#173B57");
assert.equal(tableEdit.after.tableCellPaddingPt, 10);
const paragraphEdit = edits.filter(e => e.blockId === "intro").at(-1);
assert.equal(paragraphEdit.after.fontSizePt, 12);
assert.equal(paragraphEdit.after.spaceAfterPt, 12);
console.log(`PASS: ${edits.length} formatting-only edits, ${done.steps} steps, ${done.toolCalls} tool calls; no text rewrites.`);
