import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { buildLabsExtensions } from "./extensions/buildExtensions.js";
import { blockToNodeJSON } from "./bridge/markdown.js";
import {
  applyEditEvents,
  createApplyContext,
  findBlockByPos,
  restoreBlock
} from "./applyEdit.js";
import { createReviewStore } from "./reviewStore.js";

let editor;
afterEach(() => {
  editor?.destroy();
  editor = null;
  vi.restoreAllMocks();
});

const BLOCKS = [
  { id: "a", type: "paragraph", text: "Alpha", attrs: {} },
  { id: "b", type: "paragraph", text: "**Bravo**", attrs: {} },
  { id: "c", type: "paragraph", text: "Charlie is longer", attrs: {} },
  { id: "d", type: "paragraph", text: "Delta", attrs: { textColor: "blue" } },
  { id: "e", type: "paragraph", text: "Echo", attrs: {} }
];

function startRun(blocks = BLOCKS) {
  editor = new Editor({
    extensions: buildLabsExtensions(),
    content: { type: "doc", content: blocks.map(blockToNodeJSON) }
  });
  const before = editor.getJSON();
  const store = createReviewStore();
  const ctx = createApplyContext();
  store.startRun(editor);
  return {
    before,
    store,
    apply(events) {
      applyEditEvents(editor, events, ctx, {
        onBeforeEdit: (event, info) => store.captureBeforeEdit(event, info)
      });
      for (const event of events) store.recordEdit(editor, event);
      expect(ctx.skipped).toEqual([]);
    }
  };
}

function ids() {
  return editor.getJSON().content.map(node => node.attrs.blockId);
}

const DELETE_ORDERS = [
  "b,c,d", "b,d,c", "c,b,d", "c,d,b", "d,b,c", "d,c,b"
];

describe("pre-run review ordering", () => {
  for (const delivery of ["one batch", "separate batches"]) {
    it.each(DELETE_ORDERS)(`restores neighboring deletes %s in document order (${delivery})`, order => {
      const { before, store, apply } = startRun();
      const events = order.split(",").map(blockId => ({ op: "delete", blockId }));
      if (delivery === "one batch") apply(events);
      else for (const event of events) apply([event]);
      expect(ids()).toEqual(["a", "e"]);
      store.finishRun(editor, { ok: true }, "done");
      expect(store.getRun().unexpected).toEqual([]);

      // Use the store's public document-order contract, not a test-only repair.
      for (const entry of store.pendingEntries()) {
        expect(restoreBlock(editor, entry)).toBe(true);
        store.keep(entry.blockId);
      }
      expect(ids()).toEqual(["a", "b", "c", "d", "e"]);
      expect(editor.getJSON()).toEqual(before);
      expect(store.pendingIds()).toEqual({ edited: [], unexpected: [] });
    });
  }

  it.each([
    ["delete a predecessor", { op: "delete", blockId: "b" }],
    ["insert a predecessor", { op: "insert", blockId: "new", afterId: "b", after: "New neighbor" }],
    ["resize an earlier block", { op: "replace", blockId: "a", after: "A much longer preceding paragraph" }]
  ])("captures pre-run position and predecessor when earlier edits %s", (_, earlierEdit) => {
    const { before, store, apply } = startRun();
    const originalPos = findBlockByPos(editor.state.doc, "c").pos;
    apply([earlierEdit, { op: "replace", blockId: "c", after: "Changed" }]);

    expect(store.getRun().blocks.get("c")).toMatchObject({
      before: before.content[2],
      originalPos,
      prevSiblingId: "b"
    });
  });

  it("allows rejecting a later deleted neighbor before its missing predecessor", () => {
    const { before, store, apply } = startRun();
    apply([{ op: "delete", blockId: "c" }, { op: "delete", blockId: "b" }]);

    expect(restoreBlock(editor, store.getRun().blocks.get("c"))).toBe(true);
    expect(ids()).toEqual(["a", "c", "d", "e"]);
    expect(restoreBlock(editor, store.getRun().blocks.get("b"))).toBe(true);
    expect(editor.getJSON()).toEqual(before);
  });
});

describe("replacement rejection preserves position", () => {
  it("restores in place while the original predecessor remains deleted", () => {
    const { before, store, apply } = startRun();
    apply([
      { op: "replace", blockId: "c", after: "Changed Charlie" },
      { op: "delete", blockId: "b" }
    ]);
    expect(ids()).toEqual(["a", "c", "d", "e"]);

    expect(restoreBlock(editor, store.getRun().blocks.get("c"))).toBe(true);
    expect(ids()).toEqual(["a", "c", "d", "e"]);
    expect(findBlockByPos(editor.state.doc, "c").node.toJSON()).toEqual(before.content[2]);
    expect(findBlockByPos(editor.state.doc, "b")).toBeNull();
  });

  it("does not move a replacement ahead of a restored predecessor", () => {
    const { before, store, apply } = startRun();
    apply([
      { op: "delete", blockId: "b" },
      { op: "replace", blockId: "c", after: "Changed Charlie" }
    ]);

    expect(restoreBlock(editor, store.getRun().blocks.get("b"))).toBe(true);
    expect(restoreBlock(editor, store.getRun().blocks.get("c"))).toBe(true);
    expect(ids()).toEqual(["a", "b", "c", "d", "e"]);
    expect(editor.getJSON()).toEqual(before);
  });

  it("restores the only block without manufacturing an extra empty paragraph", () => {
    const { before, store, apply } = startRun([BLOCKS[1]]);
    apply([{ op: "replace", blockId: "b", after: "Rewritten" }]);

    expect(restoreBlock(editor, store.getRun().blocks.get("b"))).toBe(true);
    expect(editor.getJSON()).toEqual(before);
  });
});

describe("mixed insert/edit/delete batches", () => {
  const events = [
    { op: "insert", blockId: "new", afterId: "a", after: "Temporary neighbor" },
    { op: "replace", blockId: "b", after: "Rewritten Bravo" },
    { op: "delete", blockId: "c" },
    { op: "replace_in_block", blockId: "d", before: "Delta", after: "Updated Delta" }
  ];

  it("undoes the complete mixed batch in one real history step", () => {
    const { before, apply } = startRun();
    apply(events);
    const after = editor.getJSON();
    expect(ids()).toEqual(["a", "new", "b", "d", "e"]);

    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.getJSON()).toEqual(after);
  });

  it("rejects the complete mixed batch back to exact pre-run JSON", () => {
    const { before, store, apply } = startRun();
    apply(events);
    store.finishRun(editor, { ok: true }, "done");
    expect(store.getRun().unexpected).toEqual([]);

    for (const entry of store.pendingEntries()) {
      expect(restoreBlock(editor, entry)).toBe(true);
      store.keep(entry.blockId);
    }
    expect(ids()).toEqual(["a", "b", "c", "d", "e"]);
    expect(editor.getJSON()).toEqual(before);
  });
});

describe("restore failure atomicity", () => {
  it.each(["replacement", "deletion"])("keeps document, selection and pending review intact on invalid %s snapshot", operation => {
    const { before, store, apply } = startRun();
    apply([operation === "replacement"
      ? { op: "replace", blockId: "b", after: "Changed Bravo" }
      : { op: "delete", blockId: "b" }]);
    const current = editor.getJSON();
    const selection = editor.state.selection.toJSON();
    const pending = store.pendingIds();
    const entry = store.getRun().blocks.get("b");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    // Invalid schema JSON exercises the real restore catch, with no editor mock.
    expect(restoreBlock(editor, {
      ...entry,
      before: { ...entry.before, type: "unregisteredReviewNode" }
    })).toBe(false);
    expect(consoleError).toHaveBeenCalled();
    expect(editor.getJSON()).toEqual(current);
    expect(editor.state.selection.toJSON()).toEqual(selection);
    expect(store.pendingIds()).toEqual(pending);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
  });

  it("returns false without touching the document for a missing entry", () => {
    const { before } = startRun();
    expect(restoreBlock(editor, null)).toBe(false);
    expect(editor.getJSON()).toEqual(before);
    expect(editor.commands.undo()).toBe(false);
  });
});
