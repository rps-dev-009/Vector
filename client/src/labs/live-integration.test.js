/**
 * LIVE integration test — runs ONLY when the dev server with a valid
 * GEMINI_API_KEY is up (skips silently otherwise, so CI/plain `vitest run`
 * stays green without a server).
 *
 * This exercises the headless slice of the Phase 2 manual checklist:
 *   (a) instruction -> live edits applied -> Reject one restores it
 *   (b) selection edit only touches selected blocks
 *   (d) empty doc -> blocks appear one by one
 * plus the null-clear attrs flow (Step 0a).
 *
 * NOT covered here (needs a real browser): visual highlights, bubble menu,
 * mobile tabs, dark mode, Ctrl+Z after Keep/Reject — those stay on the
 * manual checklist.
 */

import { describe, it, expect, afterAll } from "vitest";
import { Editor } from "@tiptap/core";
import { buildLabsExtensions } from "./extensions/buildExtensions.js";
import { blockToNodeJSON, nodeToBlock, editorToBlocks } from "./bridge/markdown.js";
import { applyEditEvents, createApplyContext, restoreBlock, findBlockByPos } from "./applyEdit.js";
import { createReviewStore } from "./reviewStore.js";

const BASE = process.env.LABS_TEST_BASE || "http://localhost:3000";

// Probe at module load: describe.skipIf is evaluated during COLLECTION,
// before any beforeAll hook could run, so reachability must be known here.
let serverUp = false;
try {
  const res = await fetch(`${BASE}/labs/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: "probe" })
  });
  serverUp = res.status === 400; // server alive and validating
} catch (error) {
  console.warn(`[labs-live] probe failed: ${error.message}`);
  serverUp = false;
}
if (!serverUp) {
  console.warn(`[labs-live] server not reachable at ${BASE} — skipping live tests`);
}

let editors = [];
function makeEditor(blocks) {
  const editor = new Editor({
    extensions: buildLabsExtensions(),
    content: { type: "doc", content: blocks.map(blockToNodeJSON) }
  });
  editors.push(editor);
  return editor;
}
afterAll(() => {
  for (const e of editors) e.destroy();
  editors = [];
});

const SAMPLE = [
  { id: "b01", type: "heading", text: "Remote Work Playbook", attrs: { level: 1 } },
  { id: "b02", type: "paragraph", text: "This is a very wordy introduction paragraph that rambles on about remote work history and contains far more words than it needs to make its simple point.", attrs: {} },
  { id: "b03", type: "paragraph", text: "Second body paragraph about focus and boundaries.", attrs: {} }
];

/** Stream one agent run, applying edit events live; resolves with the done payload. */
async function runAgent(editor, instruction, extra = {}) {
  const store = createReviewStore();
  const ctx = createApplyContext();
  store.startRun(editor);

  const res = await fetch(`${BASE}/labs/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: "vitest-live",
      blocks: editorToBlocks(editor.getJSON()),
      instruction,
      messages: [],
      selection: null,
      ...extra
    })
  });
  expect(res.headers.get("content-type") || "").toContain("text/event-stream");

  const { createParser } = await import("eventsource-parser");
  const parser = createParser((event) => {
    if (event.type !== "event") return;
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (event.event === "edit") {
      // Apply batches immediately, exactly like the React client.
      applyEditEvents(editor, [data], ctx, {
        onBeforeEdit: (e, info) => store.captureBeforeEdit(e, info)
      });
      store.recordEdit(editor, data);
    }
    if (event.event === "done") {
      store.finishRun(editor, data, "done");
      donePayload = data;
    }
  });
  let donePayload = null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.feed(decoder.decode(value, { stream: true }));
  }
  return { done: donePayload, store, ctx };
}

function blockText(editor, id) {
  const found = findBlockByPos(editor.state.doc, id);
  return found ? nodeToBlock(found.node).text : null;
}

describe.skipIf(!serverUp)("labs agent live", () => {
  it("(a) applies a real edit run and Reject restores the original block", { timeout: 180000 }, async () => {
    const editor = makeEditor(SAMPLE);
    // Target the block unambiguously by its content so the assertion tests the
    // mechanics (edit-by-id, before-state capture, exact restore) rather than
    // the model's reading of an ambiguous phrase like "the second paragraph".
    const { done, store } = await runAgent(
      editor,
      "Make the wordy introduction paragraph (the one that starts with \"This is a very wordy introduction\") much shorter."
    );
    expect(done?.ok).toBe(true);
    expect(done.editCount).toBeGreaterThan(0);

    // The edit landed on b02 only; the title is untouched.
    const after = blockText(editor, "b02");
    expect(after).not.toBe(SAMPLE[1].text);
    expect(blockText(editor, "b01")).toBe("Remote Work Playbook");

    // Reject restores the exact original.
    const entry = store.getRun().blocks.get("b02");
    expect(entry).toBeTruthy();
    restoreBlock(editor, entry);
    expect(blockText(editor, "b02")).toBe(SAMPLE[1].text);
    editors.pop().destroy();
  });

  it("(b) selection edits only touch the selected blocks", { timeout: 180000 }, async () => {
    const editor = makeEditor(SAMPLE);
    const selection = {
      blockIds: ["b02"],
      text: SAMPLE[1].text
    };
    const beforeB = { b01: "Remote Work Playbook", b03: blockText(editor, "b03") };
    const { done } = await runAgent(
      editor,
      "Rewrite this selection to be one short sentence.",
      { selection }
    );
    expect(done?.ok).toBe(true);
    expect(done.editCount).toBeGreaterThan(0);
    // Only b02 changed.
    expect(blockText(editor, "b01")).toBe(beforeB.b01);
    expect(blockText(editor, "b03")).toBe(beforeB.b03);
    expect(blockText(editor, "b02")).not.toBe(SAMPLE[1].text);
    editors.pop().destroy();
  });

  it("(d) empty document fills in blocks one by one", { timeout: 180000 }, async () => {
    const editor = makeEditor([]);
    const seenCounts = [];
    const ctx = createApplyContext();
    const store = createReviewStore();
    store.startRun(editor);

    const res = await fetch(`${BASE}/labs/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "vitest-live-empty",
        blocks: [],
        instruction: "Write a two-heading note about testing with headings and one short paragraph under each",
        messages: [],
        selection: null
      })
    });
    const { createParser } = await import("eventsource-parser");
    const parser = createParser((event) => {
      if (event.type !== "event") return;
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (event.event === "edit") {
        applyEditEvents(editor, [data], ctx, {
          onBeforeEdit: (e, info) => store.captureBeforeEdit(e, info)
        });
        store.recordEdit(editor, data);
        // Records the document growing one block at a time.
        seenCounts.push(editor.state.doc.childCount);
      }
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }

    expect(seenCounts.length).toBeGreaterThanOrEqual(4);
    // Monotonic growth: blocks appear one by one, never shrinking mid-run.
    for (let i = 1; i < seenCounts.length; i++) {
      expect(seenCounts[i]).toBeGreaterThanOrEqual(seenCounts[i - 1]);
    }
    expect(editor.state.doc.childCount).toBeGreaterThanOrEqual(4);
    // All inserted blocks carry ids.
    const blocks = editorToBlocks(editor.getJSON());
    expect(blocks.every((b) => b.id)).toBe(true);
    editors.pop().destroy();
  });

  it("Step 0a: null-clear removes textColor via set_block_attrs", { timeout: 180000 }, async () => {
    const doc = SAMPLE.map((b) => ({ ...b }));
    doc[0].attrs = { level: 1, textColor: "blue" };
    const editor = makeEditor(doc);
    const { done } = await runAgent(editor, "Remove the color from the title");
    expect(done?.ok).toBe(true);
    const title = findBlockByPos(editor.state.doc, "b01");
    // Cleared attr = null on the node, omitted from block attrs.
    expect(title.node.attrs.textColor).toBeNull();
    expect(nodeToBlock(title.node).attrs.textColor).toBeUndefined();
    expect(title.node.attrs.level).toBe(1);
    editors.pop().destroy();
  });

  it("413: oversized document returns clean JSON", { timeout: 60000 }, async () => {
    const res = await fetch(`${BASE}/labs/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "vitest-413",
        blocks: [{ id: "big", type: "paragraph", text: "x".repeat(210000), attrs: {} }],
        instruction: "hi"
      })
    });
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.error).toMatch(/too large/i);
  });
});
