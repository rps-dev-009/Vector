import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { buildLabsExtensions } from "./extensions/buildExtensions.js";
import { blockToNodeJSON, editorToBlocks } from "./bridge/markdown.js";
import { applyEditEvents, createApplyContext, restoreBlock } from "./applyEdit.js";
import { createReviewStore } from "./reviewStore.js";
import { STYLE_SPEC, DOCUMENT_STYLE_ID, resolveColor, resolveBlockStyle, resolveDocumentStyle, documentCssVariables } from "./styles.js";

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

  it("clears omitted overrides in a complete replacement attrs map", () => {
    create([{ id: "p", type: "paragraph", text: "Body", attrs: { fontSizePt: 19, textColor: "blue" } }]);
    applyEditEvents(editor, [{ op: "replace", blockId: "p", after: "Body", attrs: { textColor: "blue" } }], createApplyContext());
    expect(editorToBlocks(editor.getJSON())[0].attrs).toEqual({ textColor: "blue" });
  });

  it("repairs a prose heading without losing words or marks, and can reject the conversion", () => {
    const text = "Pruning regulates **growth** and fruit quality. ".repeat(25).trim();
    create([{ id: "bad-h", type: "heading", text, attrs: { level: 2, fontSizePt: 19, textColor: "blue" } }]);
    const before = editor.getJSON().content[0];
    const store = createReviewStore(); store.startRun(editor);
    const event = { op: "replace", blockId: "bad-h", type: "paragraph", before: text, after: text, attrs: {} };
    const ctx = createApplyContext();
    applyEditEvents(editor, [event], ctx, { onBeforeEdit: (e, info) => store.captureBeforeEdit(e, info) });
    expect(ctx.skipped).toEqual([]);
    expect(editorToBlocks(editor.getJSON())[0]).toMatchObject({ id: "bad-h", type: "paragraph", text, attrs: {} });
    expect(editor.getJSON().content[0].content).toEqual(before.content);
    restoreBlock(editor, store.pendingEntries()[0]);
    expect(editor.getJSON().content[0]).toEqual(before);
  });

  it("keeps shorter gaps below headings than above and preserves explicit spacing", () => {
    const section = resolveBlockStyle("heading", { level: 2 });
    const subsection = resolveBlockStyle("heading", { level: 3 });
    expect(section.spaceBeforePt).toBe(18);
    expect(subsection.spaceBeforePt).toBe(12);
    expect(section.spaceAfterPt).toBe(6);
    expect(resolveBlockStyle("heading", { level: 2, spaceAfterPt: 0 }).spaceAfterPt).toBe(0);
  });

  it("normalizes opaque CSSOM colors without accepting translucent or unsafe values", () => {
    expect(resolveColor("rgb(33, 79, 97)")).toBe("#214F61");
    expect(resolveColor("rgba(33, 79, 97, 1)")).toBe("#214F61");
    expect(resolveColor("rgba(33, 79, 97, 0.5)")).toBeNull();
    expect(resolveColor("rgb(999, 79, 97)")).toBeNull();
    expect(resolveColor("rgb(33,79,97);background:red")).toBeNull();
  });

  it("packs pasted block colors as server-safe hex, not CSSOM rgb strings", () => {
    create();
    editor.commands.setContent('<p style="color:#214f61;background-color:#eef5f6">Pasted text</p>');
    expect(editorToBlocks(editor.getJSON())[0].attrs).toMatchObject({ textColor: "#214F61", backgroundColor: "#EEF5F6" });
  });

  it("converts mixed multi-block selections to body text without leaking heading styles", () => {
    create([
      { id: "h", type: "heading", text: "Heading", attrs: { level: 2, fontSizePt: 30, textColor: "blue" } },
      { id: "body", type: "paragraph", text: "Body", attrs: { fontSizePt: 12, textColor: "green" } },
      { id: "h2", type: "heading", text: "Second", attrs: { level: 2, fontSizePt: 19 } },
      { id: "tail", type: "paragraph", text: "Tail", attrs: {} }
    ]);
    editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 });
    expect(editor.commands.setParagraph()).toBe(true);
    const blocks = editorToBlocks(editor.getJSON());
    expect(blocks.map(block => block.id)).toEqual(["h", "body", "h2", "tail"]);
    expect(blocks.every(block => block.type === "paragraph")).toBe(true);
    expect(blocks[0].attrs).toEqual({});
    expect(blocks[1].attrs).toEqual({ fontSizePt: 12, textColor: "green" });
    expect(blocks[2].attrs).toEqual({});
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
