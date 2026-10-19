import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { buildLabsExtensions } from "./extensions/buildExtensions.js";
import { blockToNodeJSON, editorToBlocks } from "./bridge/markdown.js";
import { applyEditEvents, createApplyContext, restoreBlock } from "./applyEdit.js";
import { createReviewStore } from "./reviewStore.js";
import { STYLE_SPEC, DOCUMENT_STYLE_ID, resolveBlockStyle, resolveDocumentStyle, documentCssVariables } from "./styles.js";

let editor;
afterEach(() => { editor?.destroy(); editor = null; });
const table = { id: "table", type: "table", text: "| Method | Purpose |\n| --- | --- |\n| Visit | Advice |", attrs: {} };
function create(blocks = [table], documentStyle = { preset: "editorial" }) {
  editor = new Editor({ extensions: buildLabsExtensions(), content: { type: "doc", attrs: { documentStyle }, content: blocks.map(blockToNodeJSON) } });
  return editor;
}

describe("document styling contract", () => {
  it("provides five readable themes with typography and complete table styling", () => {
    expect(Object.keys(STYLE_SPEC.presets)).toHaveLength(5);
    for (const preset of Object.keys(STYLE_SPEC.presets)) {
      const t = resolveBlockStyle("table", {}, { preset });
      expect(t.tableCellPaddingPt).toBeGreaterThan(0);
      expect(t.tableHeaderBackground).toMatch(/^#[\dA-F]{6}$/i);
      expect(documentCssVariables({ preset })["--doc-table-header"]).toBe(t.tableHeaderBackground);
      expect(resolveBlockStyle("heading", { level: 1 }, { preset }).fontSizePt).toBeGreaterThan(t.fontSizePt);
    }
  });

  it("roundtrips font, zero spacing and all table properties through real Tiptap", () => {
    const attrs = { fontFamily: "Georgia", fontSizePt: 14, lineHeight: 1.5, spaceBeforePt: 0, spaceAfterPt: 0,
      tableVariant: "grid", tableCellPaddingPt: 12, tableHeaderBackground: "#173B57", tableHeaderColor: "#FFFFFF",
      tableAlternateBackground: "#EDF4F8", tableBorderColor: "#CBD5E1" };
    create([{ ...table, attrs }]);
    expect(editorToBlocks(editor.getJSON())[0].attrs).toEqual(attrs);
    const html = editor.getHTML();
    expect(html).toContain("font-size: 14pt");
    expect(html).toContain("--table-header: #173B57");
    expect(html).toContain('data-table-variant="grid"');
    const saved = editor.getJSON();
    editor.commands.setContent(saved);
    expect(editorToBlocks(editor.getJSON())[0].attrs).toEqual(attrs);
  });

  it("applies formatting without replacing text or inline marks and rejects exactly", () => {
    create([{ id: "p", type: "paragraph", text: "Keep **these words**.", attrs: { fontSizePt: 12 } }]);
    const before = editor.getJSON().content[0];
    const store = createReviewStore(); store.startRun(editor);
    const event = { op: "set_attrs", blockId: "p", after: { fontFamily: "Cambria", fontSizePt: 16, spaceAfterPt: 0 } };
    applyEditEvents(editor, [event], createApplyContext(), { onBeforeEdit: (e, info) => store.captureBeforeEdit(e, info) });
    expect(editor.getJSON().content[0].content).toEqual(before.content);
    expect(editorToBlocks(editor.getJSON())[0].attrs).toEqual(event.after);
    restoreBlock(editor, store.pendingEntries()[0]);
    expect(editor.getJSON().content[0]).toEqual(before);
  });

  it("clears style overrides from the complete set_attrs map", () => {
    create([{ ...table, attrs: { fontFamily: "Georgia", tableHeaderBackground: "#173B57", tableCellPaddingPt: 12 } }]);
    applyEditEvents(editor, [{ op: "set_attrs", blockId: "table", after: {} }], createApplyContext());
    expect(editorToBlocks(editor.getJSON())[0].attrs).toEqual({});
  });

  it("keeps style attributes when a block is rewritten", () => {
    create([{ id: "p", type: "paragraph", text: "Original", attrs: { fontFamily: "Georgia", fontSizePt: 15, spaceAfterPt: 0 } }]);
    applyEditEvents(editor, [{ op: "replace", blockId: "p", after: "Updated" }], createApplyContext());
    expect(editorToBlocks(editor.getJSON())[0].attrs).toEqual({ fontFamily: "Georgia", fontSizePt: 15, spaceAfterPt: 0 });
  });

  it("keeps first document-style before-state and reverts without touching content", () => {
    create([table, { id: "last", type: "paragraph", text: "Closing note.", attrs: {} }]);
    const before = editor.getJSON();
    const store = createReviewStore(); store.startRun(editor);
    const events = [
      { op: "set_document_style", blockId: DOCUMENT_STYLE_ID, after: { preset: "botanical" } },
      { op: "set_document_style", blockId: DOCUMENT_STYLE_ID, after: { preset: "executive", lineHeight: 2 } }
    ];
    applyEditEvents(editor, events, createApplyContext(), { onBeforeEdit: (e, info) => store.captureBeforeEdit(e, info) });
    expect(editor.getJSON().content).toEqual(before.content);
    expect(editor.getJSON().attrs.documentStyle).toEqual(events[1].after);
    store.finishRun(editor, { ok: true }, "done");
    expect(store.pendingEntries()).toHaveLength(1);
    expect(store.getRun().unexpected).toEqual([]);
    restoreBlock(editor, store.pendingEntries()[0]);
    expect(editor.getJSON()).toEqual(before);
  });

  it("persists document style and allows undo", () => {
    create();
    editor.view.dispatch(editor.state.tr.setDocAttribute("documentStyle", { preset: "academic", fontSizePt: 14 }));
    expect(editor.getJSON().attrs.documentStyle.preset).toBe("academic");
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON().attrs.documentStyle.preset).toBe("editorial");
  });

  it("resolves named backgrounds identically and preserves literal hex overrides", () => {
    expect(resolveBlockStyle("paragraph", { backgroundColor: "blue" }).backgroundColor).toBe("#DBEAFE");
    expect(resolveBlockStyle("table", { tableHeaderBackground: "#fff" }).tableHeaderColor).toBe("#182431");
    expect(resolveBlockStyle("table", { tableHeaderBackground: "#123" }).tableHeaderColor).toBe("#FFFFFF");
    expect(resolveBlockStyle("paragraph", { spaceAfterPt: 0 }).spaceAfterPt).toBe(0);
  });

  it("does not generate unsafe CSS from malformed persisted style values", () => {
    expect(resolveDocumentStyle({ preset: "__proto__", marginMm: 999, fontFamily: 'x";background:red' }).preset).toBe("editorial");
    const s = resolveBlockStyle("paragraph", { fontSizePt: 500, textColor: "red; background:url(x)", lineHeight: -1 });
    expect(s.fontSizePt).toBe(11);
    expect(s.lineHeight).toBe(1.7);
    expect(s.textColor).toBe("#263342");
    expect(() => resolveBlockStyle("paragraph", { backgroundColor: "invalid" })).not.toThrow();
    expect(resolveBlockStyle("table", { backgroundColor: "black" }).textColor).toBe("#263342");
  });
});
