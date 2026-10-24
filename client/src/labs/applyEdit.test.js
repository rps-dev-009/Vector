/**
 * applyEdit + reviewStore tests (vitest, jsdom — runs against a REAL Tiptap
 * editor instance).
 *
 * Covers: every op, missing blockId skip, batched edits in one transaction,
 * the replace_in_block range/fallback paths, double-edit + Reject restoring
 * the original node exactly (marks included), insert/delete Reject flows, and
 * attr null-clearing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { buildLabsExtensions } from "./extensions/buildExtensions.js";
import { blockToNodeJSON, nodeToBlock } from "./bridge/markdown.js";
import {
  applyEditEvents,
  applyEditEvent,
  createApplyContext,
  restoreBlock,
  findBlockByPos,
  blockPlainText
} from "./applyEdit.js";
import { createReviewStore } from "./reviewStore.js";

let editor = null;

function docFrom(blocks) {
  return { type: "doc", content: blocks.map(blockToNodeJSON) };
}

function makeEditor(blocks) {
  return new Editor({
    extensions: buildLabsExtensions(),
    content: docFrom(blocks)
  });
}

function blockOf(docJSON, id) {
  const node = docJSON.content.find((n) => n.attrs?.blockId === id);
  return node ? nodeToBlock(node) : null;
}

function currentBlock(id) {
  return blockOf(editor.getJSON(), id);
}

beforeEach(() => {
  editor = null;
});

afterEach(() => {
  if (editor) editor.destroy();
  editor = null;
});

const BASE_BLOCKS = [
  { id: "b01", type: "heading", text: "Title", attrs: { level: 1 } },
  { id: "b02", type: "paragraph", text: "First paragraph.", attrs: {} },
  { id: "b03", type: "paragraph", text: "Second paragraph.", attrs: {} }
];

describe("applyEditEvents", () => {
  it("applies a whole-block replace and keeps the blockId", () => {
    editor = makeEditor(BASE_BLOCKS);
    const ctx = createApplyContext();
    applyEditEvent(editor, {
      editId: "e1", op: "replace", blockId: "b02",
      before: "First paragraph.", after: "Rewritten first."
    }, ctx);
    expect(currentBlock("b02").text).toBe("Rewritten first.");
    expect(currentBlock("b01").text).toBe("Title");
    expect(currentBlock("b03").text).toBe("Second paragraph.");
    expect(ctx.usage.wholeBlockReplaces).toBe(1);
    expect(ctx.skipped).toEqual([]);
  });

  it("replaces blocks by id, never by position (delete above first)", () => {
    editor = makeEditor(BASE_BLOCKS);
    const ctx = createApplyContext();
    applyEditEvent(editor, { editId: "e1", op: "delete", blockId: "b01" }, ctx);
    applyEditEvent(editor, {
      editId: "e2", op: "replace", blockId: "b03",
      before: "Second paragraph.", after: "Rewritten second."
    }, ctx);
    expect(currentBlock("b03").text).toBe("Rewritten second.");
  });

  it("uses the RANGE path for replace_in_block and preserves inline marks elsewhere", () => {
    const blocks = [
      { id: "p1", type: "paragraph", text: "quick **bold** fox", attrs: {} }
    ];
    editor = makeEditor(blocks);
    const ctx = createApplyContext();
    applyEditEvent(editor, {
      editId: "e1", op: "replace_in_block", blockId: "p1",
      before: "quick **bold** fox", after: "slow **bold** fox"
    }, ctx);
    expect(ctx.usage.rangePath).toBe(1);
    expect(ctx.usage.fallbackPath).toBe(0);
    expect(currentBlock("p1").text).toBe("slow **bold** fox");
    // The bold mark survived because only the changed word was spliced.
    const bold = editor.state.doc.content.firstChild.content.content.find((n) => n.marks?.some((m) => m.type.name === "bold"));
    expect(bold).toBeTruthy();
  });

  it("uses the FALLBACK path when the node text does not match `before`", () => {
    editor = makeEditor(BASE_BLOCKS);
    const ctx = createApplyContext();
    applyEditEvent(editor, {
      editId: "e1", op: "replace_in_block", blockId: "b02",
      before: "stale text that does not match", after: "totally new"
    }, ctx);
    expect(ctx.usage.fallbackPath).toBe(1);
    expect(ctx.usage.rangePath).toBe(0);
    expect(currentBlock("b02").text).toBe("totally new");
  });

  it("preserves unchanged interior text and marks between disjoint, unequal-length edits", () => {
    editor = makeEditor([{ id: "p1", type: "paragraph", text: "alpha **middle** omega", attrs: {} }]);
    // Inline highlighting is local-only and is not present in server markdown.
    editor.view.dispatch(editor.state.tr.addMark(7, 13, editor.schema.marks.highlight.create({ color: "#ffff00" })));
    const middle = findBlockByPos(editor.state.doc, "p1").node.child(1).toJSON();
    const ctx = createApplyContext();
    applyEditEvent(editor, {
      op: "replace_in_block", blockId: "p1",
      before: "alpha **middle** omega", after: "ALPHABET **middle** END"
    }, ctx);
    const node = findBlockByPos(editor.state.doc, "p1").node;
    expect(blockPlainText(node)).toBe("ALPHABET middle END");
    expect(node.child(1).toJSON()).toEqual(middle);
    expect(ctx.usage.rangePath).toBe(1);
    expect(ctx.usage.fallbackPath).toBe(0);
  });

  it.each([
    ["alpha middle omega", "middle"],
    ["middle", "alpha middle omega"],
    ["alpha  middle omega", "ALPHA middle   END"],
    ["alpha\n**middle**\nomega", "ALPHABET\n**middle**\nEND"],
    ["alpha middle omega", "alpha\nmiddle\nomega"],
    ["", "new text"],
    ["old text", ""]
  ])("applies exact range text including whitespace and hard breaks: %j -> %j", (before, after) => {
    editor = makeEditor([{ id: "p1", type: "paragraph", text: before, attrs: {} }]);
    const ctx = createApplyContext();
    applyEditEvent(editor, { op: "replace_in_block", blockId: "p1", before, after }, ctx);
    const expected = editor.schema.nodeFromJSON(blockToNodeJSON({ id: "p1", type: "paragraph", text: after, attrs: {} }));
    expect(findBlockByPos(editor.state.doc, "p1").node.content.toJSON()).toEqual(expected.content.toJSON());
    expect(ctx.usage.rangePath).toBe(1);
    expect(ctx.usage.fallbackPath).toBe(0);
  });

  it("uses the FALLBACK path for non text-container blocks (lists)", () => {
    editor = makeEditor([
      { id: "l1", type: "bulletList", text: "- one\n- two", attrs: {} }
    ]);
    const ctx = createApplyContext();
    applyEditEvent(editor, {
      editId: "e1", op: "replace_in_block", blockId: "l1",
      before: "- one\n- two", after: "- one\n- two\n- three"
    }, ctx);
    expect(ctx.usage.fallbackPath).toBe(1);
    expect(currentBlock("l1").text).toBe("- one\n- two\n- three");
  });

  it("inserts with the server-provided id, at start and after a block", () => {
    editor = makeEditor(BASE_BLOCKS);
    const ctx = createApplyContext();
    applyEditEvents(editor, [
      { editId: "e1", op: "insert", blockId: "new1", afterId: null, type: "paragraph", after: "At the start." },
      { editId: "e2", op: "insert", blockId: "new2", afterId: "b02", type: "bulletList", after: "- a\n- b" }
    ], ctx);
    const ids = editor.getJSON().content.map((n) => n.attrs?.blockId);
    expect(ids[0]).toBe("new1");
    expect(ids[3]).toBe("new2"); // inserted after b02: [new1, b01, b02, new2, b03]
    expect(currentBlock("new2").text).toBe("- a\n- b");
    expect(ctx.usage.inserts).toBe(2);
  });

  it("replaces a block with a table via markdown text", () => {
    editor = makeEditor(BASE_BLOCKS);
    const ctx = createApplyContext();
    applyEditEvent(editor, {
      editId: "e1", op: "replace", blockId: "b02",
      before: "First paragraph.",
      after: "| A | B |\n| --- | --- |\n| 1 | 2 |"
    }, ctx);
    const node = findBlockByPos(editor.state.doc, "b02");
    expect(node.node.type.name).toBe("paragraph"); // type stays paragraph?
    // NOTE: server replace_block keeps the block TYPE; a paragraph replaced
    // with table markdown stays a paragraph holding the raw text.
    expect(currentBlock("b02").text).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
  });

  it("skips edits for missing blockIds and records them", () => {
    editor = makeEditor(BASE_BLOCKS);
    const ctx = createApplyContext();
    applyEditEvents(editor, [
      { editId: "e1", op: "replace", blockId: "nope", before: "", after: "x" },
      { editId: "e2", op: "insert", blockId: "i1", afterId: "also-nope", type: "paragraph", after: "x" },
      { editId: "e3", op: "set_attrs", blockId: "nope2", attrs: { textColor: "blue" } }
    ], ctx);
    expect(ctx.skipped.length).toBe(3);
    expect(editor.getJSON().content.length).toBe(3);
  });

  it("applies set_attrs and honors null-clearing (absent key = cleared)", () => {
    editor = makeEditor(BASE_BLOCKS);
    const ctx = createApplyContext();
    applyEditEvent(editor, {
      editId: "e1", op: "set_attrs", blockId: "b02",
      before: {}, attrs: { textColor: "blue", align: "center" }, after: {}
    }, ctx);
    expect(currentBlock("b02").attrs.textColor).toBe("blue");
    expect(currentBlock("b02").attrs.align).toBe("center");
    applyEditEvent(editor, {
      editId: "e2", op: "set_attrs", blockId: "b02",
      before: {}, attrs: { textColor: null, align: "center" }, after: {}
    }, ctx);
    expect(currentBlock("b02").attrs.textColor).toBeUndefined();
    expect(currentBlock("b02").attrs.align).toBe("center");
  });

  it("keeps heading level on set_attrs of other keys", () => {
    editor = makeEditor(BASE_BLOCKS);
    const ctx = createApplyContext();
    applyEditEvent(editor, {
      editId: "e1", op: "set_attrs", blockId: "b01",
      before: {}, attrs: { textColor: "red", level: 1 }, after: {}
    }, ctx);
    expect(currentBlock("b01").attrs.level).toBe(1);
    expect(currentBlock("b01").attrs.textColor).toBe("red");
  });

  it("applies a batch of edits in ONE transaction (single undo step)", () => {
    editor = makeEditor(BASE_BLOCKS);
    const ctx = createApplyContext();
    applyEditEvents(editor, [
      { editId: "e1", op: "replace", blockId: "b01", before: "Title", after: "New Title" },
      { editId: "e2", op: "replace", blockId: "b02", before: "First paragraph.", after: "First." },
      { editId: "e3", op: "replace", blockId: "b03", before: "Second paragraph.", after: "Second." }
    ], ctx);
    expect(currentBlock("b01").text).toBe("New Title");
    expect(currentBlock("b02").text).toBe("First.");
    expect(currentBlock("b03").text).toBe("Second.");
    // One dispatch = one undo step: undoing once restores all three.
    editor.commands.undo();
    expect(currentBlock("b01").text).toBe("Title");
    expect(currentBlock("b02").text).toBe("First paragraph.");
    expect(currentBlock("b03").text).toBe("Second paragraph.");
  });
});

describe("reviewStore + restoreBlock", () => {
  it("Reject restores the original node EXACTLY after two edits (marks included)", () => {
    editor = makeEditor([
      { id: "p1", type: "paragraph", text: "Keep **these marks** intact.", attrs: {} }
    ]);
    const store = createReviewStore();
    const ctx = createApplyContext();
    store.startRun(editor);
    const hooks = {
      onBeforeEdit: (event, info) => store.captureBeforeEdit(event, info)
    };
    applyEditEvent(editor, {
      editId: "e1", op: "replace_in_block", blockId: "p1",
      before: "Keep **these marks** intact.", after: "Keep **these marks** changed."
    }, ctx, hooks);
    applyEditEvent(editor, {
      editId: "e2", op: "replace", blockId: "p1",
      before: "Keep **these marks** changed.", after: "Everything rewritten, marks gone."
    }, ctx, hooks);

    const entry = store.getRun().blocks.get("p1");
    expect(entry.before).toBeTruthy();
    expect(currentBlock("p1").text).toBe("Everything rewritten, marks gone.");

    restoreBlock(editor, entry);
    expect(currentBlock("p1").text).toBe("Keep **these marks** intact.");
    // marks restored exactly:
    const bold = findBlockByPos(editor.state.doc, "p1").node.content.content.find(
      (n) => n.marks?.some((m) => m.type.name === "bold")
    );
    expect(bold?.text).toBe("these marks");
  });

  it("Reject deletes an inserted block", () => {
    editor = makeEditor(BASE_BLOCKS);
    const store = createReviewStore();
    const ctx = createApplyContext();
    store.startRun(editor);
    applyEditEvent(editor, {
      editId: "e1", op: "insert", blockId: "ins1", afterId: "b01",
      type: "paragraph", after: "Temporary."
    }, ctx, { onBeforeEdit: (e, i) => store.captureBeforeEdit(e, i) });
    expect(currentBlock("ins1").text).toBe("Temporary.");
    restoreBlock(editor, store.getRun().blocks.get("ins1"));
    expect(currentBlock("ins1")).toBeNull();
    expect(editor.getJSON().content.length).toBe(3);
  });

  it("Reject reinserts a deleted block after its previous sibling", () => {
    editor = makeEditor(BASE_BLOCKS);
    const store = createReviewStore();
    const ctx = createApplyContext();
    store.startRun(editor);
    applyEditEvent(editor, { editId: "e1", op: "delete", blockId: "b02" }, ctx, {
      onBeforeEdit: (e, i) => store.captureBeforeEdit(e, i)
    });
    expect(currentBlock("b02")).toBeNull();
    restoreBlock(editor, store.getRun().blocks.get("b02"));
    const ids = editor.getJSON().content.map((n) => n.attrs?.blockId);
    expect(ids).toEqual(["b01", "b02", "b03"]);
    expect(currentBlock("b02").text).toBe("First paragraph.");
  });

  it("Reject restores a deleted first block at the document start (no prev sibling)", () => {
    editor = makeEditor(BASE_BLOCKS);
    const store = createReviewStore();
    const ctx = createApplyContext();
    store.startRun(editor);
    applyEditEvent(editor, { editId: "e1", op: "delete", blockId: "b01" }, ctx, {
      onBeforeEdit: (e, i) => store.captureBeforeEdit(e, i)
    });
    restoreBlock(editor, store.getRun().blocks.get("b01"));
    const ids = editor.getJSON().content.map((n) => n.attrs?.blockId);
    expect(ids[0]).toBe("b01");
  });

  it("flags unexpected changes after the run (block changed without an edit event)", () => {
    editor = makeEditor(BASE_BLOCKS);
    const store = createReviewStore();
    store.startRun(editor);
    // User (or a bug) changes b03 directly, no edit event:
    editor.commands.insertContentAt(
      editor.state.doc.content.findIndex ? 0 : 0,
      ""
    );
    editor.chain().focus().updateAttributes("paragraph", {}).run();
    // Simpler: directly modify b03 text via a command.
    const pos = findBlockByPos(editor.state.doc, "b03").pos;
    editor.chain().command(({ tr }) => {
      tr.insertText("EDITED", pos + 1, pos + 1 + "Second paragraph.".length);
      return true;
    }).run();
    store.finishRun(editor, { summary: "", editCount: 0 }, "done");
    const pending = store.pendingEntries();
    expect(pending.some((p) => p.blockId === "b03" && p.kind === "unexpected")).toBe(true);
  });

  it("pendingEntries excludes kept blocks", () => {
    editor = makeEditor(BASE_BLOCKS);
    const store = createReviewStore();
    const ctx = createApplyContext();
    store.startRun(editor);
    applyEditEvent(editor, {
      editId: "e1", op: "replace", blockId: "b01", before: "Title", after: "New"
    }, ctx, { onBeforeEdit: (e, i) => store.captureBeforeEdit(e, i) });
    applyEditEvent(editor, {
      editId: "e2", op: "replace", blockId: "b02", before: "First paragraph.", after: "First."
    }, ctx, { onBeforeEdit: (e, i) => store.captureBeforeEdit(e, i) });
    store.keep("b01");
    const ids = store.pendingEntries().map((e) => e.blockId);
    expect(ids).toEqual(["b02"]);
  });
});
