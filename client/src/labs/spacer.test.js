import React, { act, StrictMode, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { Fragment } from "@tiptap/pm/model";
import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { Packer } from "docx";
import { buildLabsExtensions } from "./extensions/buildExtensions.js";
import { blockToNodeJSON, nodeToBlock, editorToBlocks, blocksToMarkdownDocument } from "./bridge/markdown.js";
import { applyEditEvents, createApplyContext, findBlockByPos, restoreEntries } from "./applyEdit.js";
import { createReviewStore } from "./reviewStore.js";
import { BLOCK_STYLE_KEYS, SERVER_ATTR_KEYS, resolveSpacerHeight } from "./styles.js";
import { SelectionChip } from "./SelectionMenu.jsx";
import { useLabsProjects } from "../hooks/useLabsProjects.js";
import { createLabsExportModel } from "../utils/labsExportModel.js";
import { buildLabsPrintHtml } from "../utils/exportToPdf.js";
import { buildLabsWordDocument } from "../utils/exportToWord.js";

const editors = [];
let root;
const spacer = (heightPt = 144) => ({ id: "b_space", type: "spacer", text: "", attrs: { heightPt } });
const paragraph = (id, text) => ({ id, type: "paragraph", text, attrs: {} });
const doc = blocks => ({ type: "doc", content: blocks.map(blockToNodeJSON) });
const current = editor => nodeToBlock(findBlockByPos(editor.state.doc, "b_space")?.node);

function makeEditor(content = doc([spacer()])) {
  const editor = new Editor({
    extensions: buildLabsExtensions(), content,
    editorProps: { handleScrollToSelection: () => true }
  });
  editors.push(editor);
  return editor;
}

function apply(editor, events, review) {
  const ctx = createApplyContext();
  applyEditEvents(editor, events, ctx, review ? {
    onBeforeEdit: (event, info) => review.captureBeforeEdit(event, info)
  } : {});
  expect(ctx.skipped).toEqual([]);
  if (review) for (const event of events) review.recordEdit(editor, event);
  return ctx;
}

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = null;
  for (const editor of editors.splice(0)) if (!editor.isDestroyed) editor.destroy();
  document.body.replaceChildren();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("spacer bridge and schema", () => {
  it.each([
    [undefined, 144], [null, 144], [NaN, 144], [Infinity, 144], ["200", 144],
    [-10, 24], [0, 24], [24, 24], [212.5, 212.5], [360, 360], [900, 360]
  ])("normalizes height %s to %s points", (input, expected) => {
    expect(resolveSpacerHeight(input)).toBe(expected);
  });

  it("round-trips id and geometry without text or generic styles", () => {
    const input = { ...spacer(212.5), text: "not document text", attrs: {
      heightPt: 212.5, backgroundColor: "red", textColor: "blue", align: "right", fontSizePt: 48
    } };
    const node = blockToNodeJSON(input);
    expect(node).toEqual({ type: "spacer", attrs: { blockId: "b_space", heightPt: 212.5 } });
    expect(nodeToBlock(node)).toEqual(spacer(212.5));
    expect(blockToNodeJSON({ id: "b_space", type: "spacer", text: "" }).attrs.heightPt).toBe(144);
    expect(nodeToBlock({ type: "spacer", attrs: { blockId: "b_space", heightPt: null } })).toEqual(spacer());
    expect(SERVER_ATTR_KEYS).toContain("heightPt");
    expect(BLOCK_STYLE_KEYS).not.toContain("heightPt");
  });

  it("saves and reloads canonical JSON while both Markdown serializers omit blank-space labels", () => {
    const blocks = [paragraph("b_before", "Before"), spacer(180), paragraph("b_after", "After")];
    const editor = makeEditor(doc(blocks));
    const saved = JSON.parse(JSON.stringify(editor.getJSON()));
    const loaded = makeEditor(saved);
    expect(editorToBlocks(loaded.getJSON())).toEqual(blocks);
    expect(loaded.getJSON()).toEqual(saved);
    expect(loaded.getMarkdown().trim()).toMatch(/^Before\s+After$/);
    expect(blocksToMarkdownDocument(blocks)).toBe("Before\n\nAfter");
    expect(makeEditor().getMarkdown().trim()).toBe("");
    expect(blocksToMarkdownDocument([spacer()])).toBe("");
    expect(loaded.getText()).not.toMatch(/blank|spacer|180/i);
  });

  it("is a contentless selectable atom allowed only at the document root", () => {
    const editor = makeEditor();
    const { schema, doc: documentNode } = editor.state;
    const node = documentNode.firstChild;
    expect(node.isAtom).toBe(true);
    expect(node.isLeaf).toBe(true);
    expect(node.nodeSize).toBe(1);
    expect(node.type.spec.selectable).toBe(true);
    expect(Object.keys(node.attrs).sort()).toEqual(["blockId", "heightPt"]);
    expect(node.type.allowsMarks([schema.marks.bold.create()])).toBe(false);
    expect(schema.nodes.doc.validContent(Fragment.from(node))).toBe(true);
    expect(schema.nodes.blockquote.validContent(Fragment.from(node))).toBe(false);
    expect(schema.nodes.tableCell.validContent(Fragment.from(node))).toBe(false);
    expect(schema.nodes.listItem.validContent(Fragment.fromArray([schema.nodes.paragraph.create(), node]))).toBe(false);
  });

  it.each([
    [null, 144], ["", 144], ["junk", 144], ["Infinity", 144], ["240;display:none", 144],
    ["-20", 24], ["0", 24], ["24", 24], ["187.5", 187.5], ["360", 360], ["9999", 360]
  ])("parses safe bounded HTML height %s", (value, expected) => {
    const element = document.createElement("div");
    element.dataset.type = "labs-spacer";
    element.dataset.blockId = "b_space";
    if (value !== null) element.dataset.heightPt = value;
    element.style.cssText = "height:9999pt;background:red;border:5px solid red";
    element.setAttribute("onclick", "alert(1)");
    element.setAttribute("aria-label", "Untrusted label");
    element.innerHTML = "<span>Visible placeholder must not survive</span>";
    const editor = makeEditor(element.outerHTML);
    expect(current(editor)).toEqual(spacer(expected));
    const output = new DOMParser().parseFromString(editor.getHTML(), "text/html");
    const blank = output.querySelector('[data-type="labs-spacer"]');
    expect(blank.textContent).toBe("");
    expect(blank.children).toHaveLength(0);
    expect(blank.getAttribute("aria-label")).toBe(`Blank space, ${expected} points`);
    expect(blank.style.height).toBe(`${expected}pt`);
    expect(blank.getAttribute("data-height-pt")).toBe(String(expected));
    expect(blank.getAttribute("onclick")).toBeNull();
    expect(blank.getAttribute("style")).not.toContain("red");
    expect(blank.getAttribute("contenteditable")).toBe("false");
    expect(editor.getMarkdown().trim()).toBe("");
    expect(current(makeEditor(editor.getHTML()))).toEqual(spacer(expected));
  });

  it("does not turn arbitrary styled divs into spacers", () => {
    const editor = makeEditor('<div style="height:144pt" data-height-pt="144">Actual text</div>');
    expect(editorToBlocks(editor.getJSON()).some(block => block.type === "spacer")).toBe(false);
    expect(editor.getText()).toBe("Actual text");
  });
});

describe("spacer editing and review", () => {
  it("inserts a real node by anchor and rejects it without changing surrounding text", () => {
    const editor = makeEditor(doc([paragraph("b_before", "Before"), paragraph("b_after", "After")]));
    const before = editor.getJSON();
    const review = createReviewStore();
    review.startRun(editor);
    apply(editor, [{ op: "insert", blockId: "b_space", afterId: "b_before", type: "spacer", after: "", attrs: { heightPt: 192 } }], review);
    expect(editorToBlocks(editor.getJSON()).map(block => block.id)).toEqual(["b_before", "b_space", "b_after"]);
    expect(review.pendingEntries()[0].currentPreview).toBe("Blank space (192 pt)");
    expect(restoreEntries(editor, review.pendingEntries())).toBe(true);
    expect(editor.getJSON()).toEqual(before);
  });

  it("resizes, resets to default with null or omitted height, and rejects back to exact geometry", () => {
    const editor = makeEditor(doc([spacer(216), paragraph("b_after", "After")]));
    const before = editor.getJSON();
    const review = createReviewStore();
    review.startRun(editor);
    apply(editor, [{ op: "set_attrs", blockId: "b_space", attrs: { heightPt: 300 } }], review);
    expect(current(editor)).toEqual(spacer(300));
    apply(editor, [{ op: "set_attrs", blockId: "b_space", attrs: { heightPt: null } }], review);
    expect(current(editor)).toEqual(spacer());
    expect(editor.view.dom.querySelector('[data-type="labs-spacer"]').style.height).toBe("144pt");
    apply(editor, [{ op: "set_attrs", blockId: "b_space", attrs: {} }], review);
    expect(current(editor)).toEqual(spacer());
    expect(restoreEntries(editor, review.pendingEntries())).toBe(true);
    expect(editor.getJSON()).toEqual(before);
  });

  it("keeps height on replace without attrs and clears it with a complete empty attrs map", () => {
    const editor = makeEditor(doc([spacer(264), paragraph("b_after", "After")]));
    apply(editor, [{ op: "replace", blockId: "b_space", before: "", after: "" }]);
    expect(current(editor)).toEqual(spacer(264));
    apply(editor, [{ op: "replace", blockId: "b_space", before: "", after: "", attrs: {} }]);
    expect(current(editor)).toEqual(spacer());
  });

  it("restores deleted spacers from review snapshots", () => {
    const editor = makeEditor(doc([paragraph("b_before", "Before"), spacer(240), paragraph("b_after", "After")]));
    const before = editor.getJSON();
    const review = createReviewStore();
    review.startRun(editor);
    apply(editor, [{ op: "delete", blockId: "b_space", before: "" }], review);
    expect(current(editor)).toBeNull();
    expect(restoreEntries(editor, review.pendingEntries())).toBe(true);
    expect(editor.getJSON()).toEqual(before);
  });

  it("undoes and redoes insert plus resize as one edit batch", () => {
    const editor = makeEditor(doc([paragraph("b_before", "Before"), paragraph("b_after", "After")]));
    const before = editor.getJSON();
    apply(editor, [
      { op: "insert", blockId: "b_space", afterId: "b_before", type: "spacer", after: "" },
      { op: "set_attrs", blockId: "b_space", attrs: { heightPt: 288 } }
    ]);
    const after = editor.getJSON();
    expect(current(editor)).toEqual(spacer(288));
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.getJSON()).toEqual(after);
  });

  it.each([["Backspace", 8], ["Delete", 46]])("deletes selected spacer with %s and restores it with undo", (key, keyCode) => {
    const editor = makeEditor(doc([spacer(168), paragraph("b_after", "After")]));
    const before = editor.getJSON();
    editor.commands.setNodeSelection(0);
    const event = new KeyboardEvent("keydown", { key, keyCode, bubbles: true, cancelable: true });
    editor.view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(current(editor)).toBeNull();
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
  });
});

describe("spacer exports", () => {
  it("normalizes JSON and legacy blocks without propagating labels, children or generic formatting", () => {
    const raw = { type: "doc", content: [{ type: "spacer", attrs: { heightPt: 212.5, backgroundColor: "red" }, content: [{ type: "text", text: "not visible" }] }] };
    const before = JSON.stringify(raw);
    expect(createLabsExportModel(raw).elements).toEqual([{ type: "spacer", attrs: { heightPt: 212.5 } }]);
    expect(createLabsExportModel(null, null, [spacer(212.5)]).elements).toEqual(createLabsExportModel(raw).elements);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it.each([undefined, null, 24, 24.01, 24.04, 144, 180, 212.5, 212.53, 360, 9999])("exports height %s as one fixed-height indivisible diagram reservation", async heightPt => {
    const input = { type: "doc", content: [{ type: "spacer", attrs: {
      heightPt, backgroundColor: "red", textColor: "blue", spaceBeforePt: 72, spaceAfterPt: 72
    } }] };
    const height = resolveSpacerHeight(heightPt);
    const page = new DOMParser().parseFromString(buildLabsPrintHtml(input), "text/html");
    const blank = page.body.firstElementChild;
    expect(page.body.textContent).toBe("");
    expect(blank.tagName).toBe("DIV");
    expect(blank.children).toHaveLength(0);
    expect(blank.style.height).toBe(`${height}pt`);
    expect(blank.style.margin).toBe("0px");
    expect(blank.style.padding).toBe("0px");
    expect(blank.style.breakInside).toBe("avoid");
    expect(blank.style.pageBreakInside).toBe("avoid");
    expect(blank.hasAttribute("aria-label")).toBe(false);
    expect(blank.getAttribute("style")).toContain("border:0");
    expect(page.body.querySelector("hr,br,img")).toBeNull();

    const zip = await JSZip.loadAsync(await Packer.toBuffer(buildLabsWordDocument(input)));
    const xml = new DOMParser().parseFromString(await zip.file("word/document.xml").async("string"), "application/xml");
    expect(xml.querySelector("parsererror")).toBeNull();
    const paragraphs = [...xml.getElementsByTagName("w:p")];
    expect(paragraphs).toHaveLength(1);
    const p = paragraphs[0];
    const spacing = p.getElementsByTagName("w:spacing")[0];
    expect(["before", "after", "line", "lineRule"].map(name => spacing.getAttribute(`w:${name}`)))
      .toEqual(["0", "0", String(Math.round(height * 20)), "exact"]);
    for (const tag of ["t", "r", "br", "shd", "pBdr", "pageBreakBefore"]) expect(p.getElementsByTagName(`w:${tag}`)).toHaveLength(0);
    expect(p.getElementsByTagName("w:keepLines")).toHaveLength(1);
    expect(p.getElementsByTagName("w:keepLines")[0].hasAttribute("w:val")).toBe(false);
    for (const tag of ["keepNext", "widowControl"]) {
      expect(p.getElementsByTagName(`w:${tag}`)[0].getAttribute("w:val")).toBe("false");
    }
  });

  it("preserves normal heading/body pagination around consecutive spacer regions", async () => {
    const input = doc([
      { id: "title", type: "heading", text: "Training", attrs: { level: 2 } }, spacer(144),
      { ...spacer(180), id: "second" }, paragraph("after", "Next explanation")
    ]);
    const original = JSON.stringify(input);
    const zip = await JSZip.loadAsync(await Packer.toBuffer(buildLabsWordDocument(input)));
    const xml = new DOMParser().parseFromString(await zip.file("word/document.xml").async("string"), "application/xml");
    const paragraphs = [...xml.getElementsByTagName("w:p")];
    expect(paragraphs[0].getElementsByTagName("w:keepNext")[0].hasAttribute("w:val")).toBe(false);
    expect(paragraphs.at(-1).getElementsByTagName("w:widowControl")[0].hasAttribute("w:val")).toBe(false);
    const blanks = paragraphs.slice(1, -1);
    expect(blanks).toHaveLength(2);
    for (const p of blanks) expect(p.getElementsByTagName("w:keepNext")[0].getAttribute("w:val")).toBe("false");
    expect(blanks.reduce((sum, p) => sum + Number(p.getElementsByTagName("w:spacing")[0].getAttribute("w:line")), 0)).toBe((144 + 180) * 20);
    const html = new DOMParser().parseFromString(buildLabsPrintHtml(input), "text/html");
    expect(html.querySelectorAll('[data-type="labs-spacer"]')).toHaveLength(2);
    expect(html.body.textContent).toContain("Training");
    expect(html.body.textContent).toContain("Next explanation");
    expect(JSON.stringify(input)).toBe(original);
  });
});

describe("blank-only UI and editor lifecycle", () => {
  it("shows the UI-only blank-space selection label", () => {
    const html = renderToStaticMarkup(React.createElement(SelectionChip, {
      selection: { blockIds: ["b_space"], text: "", label: "Blank space" }, onRemove() {}
    }));
    expect(html).toContain("Blank space");
  });

  it("recognizes a saved spacer-only project as having content", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ models: [] }) })));
    localStorage.setItem("labs_projects_global", JSON.stringify([{ id: "project", document: "", content: doc([spacer()]) }]));
    let projectState;
    function Probe() { projectState = useLabsProjects(); return null; }
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(React.createElement(Probe)));
    expect(projectState.isProjectLocked).toBe(true);
    expect(projectState.activeProject.content.content[0].attrs.heightPt).toBe(144);
  });

  it("builds the spacer schema safely through React StrictMode mount and remount", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let liveEditor;
    function Probe() {
      const extensions = useMemo(() => buildLabsExtensions(), []);
      const editor = useEditor({ extensions, content: doc([spacer(180)]) });
      useEffect(() => { liveEditor = editor; }, [editor]);
      return React.createElement(EditorContent, { editor });
    }
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(React.createElement(StrictMode, null, React.createElement(Probe))));
    expect(liveEditor.isDestroyed).toBe(false);
    expect(current(liveEditor)).toEqual(spacer(180));
    expect(host.querySelector('[data-type="labs-spacer"]').textContent).toBe("");
    await act(async () => root.render(null));
    await act(async () => root.render(React.createElement(StrictMode, null, React.createElement(Probe))));
    expect(liveEditor.isDestroyed).toBe(false);
    expect(current(liveEditor)).toEqual(spacer(180));
  });
});
