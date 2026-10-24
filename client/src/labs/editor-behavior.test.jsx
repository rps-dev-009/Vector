import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildLabsExtensions } from "./extensions/buildExtensions.js";
import Toolbar from "./Toolbar.jsx";

let editor, host, root;
const formatting = {
  fontSizePt: 30, fontFamily: "georgia", textColor: "#123456", backgroundColor: "#eeeeee",
  textAlign: "center", lineHeight: 1.8, spaceBeforePt: 24, spaceAfterPt: 12
};
const block = (type, text, attrs = {}) => ({ type, attrs, content: [{ type: "text", text }] });
const paragraph = block("paragraph", "Following paragraph", { blockId: "p2" });

beforeAll(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  editor?.destroy(); host?.remove(); root = null; editor = null; host = null;
  vi.restoreAllMocks();
});

function makeEditor(type = "heading", attrs = {}) {
  editor = new Editor({
    extensions: buildLabsExtensions(),
    editorProps: { handleScrollToSelection: () => true },
    content: { type: "doc", content: [block(type, "Heading text", { blockId: "h1", level: 2, ...formatting, ...attrs }), paragraph] }
  });
  return editor;
}

function enterAt(pos) {
  editor.commands.setTextSelection(pos);
  const event = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true });
  editor.view.dom.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
}

describe("heading formatting transitions", () => {
  it("Enter at heading end starts a body paragraph without heading overrides", () => {
    makeEditor();
    const heading = editor.state.doc.firstChild.toJSON();
    enterAt(1 + "Heading text".length);
    expect(editor.state.doc.firstChild.toJSON()).toEqual(heading);
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    for (const key of Object.keys(formatting)) expect(editor.state.selection.$from.parent.attrs[key]).toBeNull();
    editor.commands.insertContent("Body text");
    expect(editor.state.doc.child(1).textContent).toBe("Body text");
    expect(editor.state.doc.child(1).attrs.fontSizePt).toBeNull();
  });

  it("Enter in a formatted paragraph continues paragraph formatting", () => {
    makeEditor("paragraph");
    enterAt(1 + "Heading text".length);
    expect(editor.state.selection.$from.parent.attrs).toMatchObject(formatting);
  });

  it("Enter in the middle retains formatting on both legitimate headings", () => {
    makeEditor(); enterAt(8);
    expect(editor.state.doc.child(0).type.name).toBe("heading");
    expect(editor.state.doc.child(1).type.name).toBe("heading");
    expect(editor.state.doc.child(0).attrs).toMatchObject({ ...formatting, level: 2 });
    expect(editor.state.doc.child(1).attrs).toMatchObject({ ...formatting, level: 2 });
    expect(editor.state.doc.child(0).attrs.blockId).not.toBe(editor.state.doc.child(1).attrs.blockId);
  });

  it("Enter at heading start inserts a plain paragraph but preserves the heading", () => {
    makeEditor(); enterAt(1);
    expect(editor.state.doc.child(0).type.name).toBe("paragraph");
    expect(editor.state.doc.child(0).attrs.fontSizePt).toBeNull();
    expect(editor.state.doc.child(1).type.name).toBe("heading");
    expect(editor.state.doc.child(1).attrs).toMatchObject(formatting);
  });

  it("setParagraph clears heading overrides and undo restores the exact heading", () => {
    makeEditor(); editor.commands.setTextSelection(4);
    const before = editor.getJSON();
    expect(editor.can().setParagraph()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    expect(editor.commands.setParagraph()).toBe(true);
    expect(editor.state.doc.firstChild.type.name).toBe("paragraph");
    expect(editor.state.doc.firstChild.attrs.blockId).toBe("h1");
    for (const key of Object.keys(formatting)) expect(editor.state.doc.firstChild.attrs[key]).toBeNull();
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.state.doc.firstChild.attrs.fontSizePt).toBeNull();
  });

  it("setParagraph on a paragraph does not reset its formatting", () => {
    makeEditor("paragraph"); editor.commands.setTextSelection(4);
    editor.commands.setParagraph();
    expect(editor.state.doc.firstChild.attrs).toMatchObject(formatting);
  });
});

async function mountToolbar(level = 4, aiActive = false) {
  makeEditor("heading", { level });
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Toolbar editor={editor} aiActive={aiActive} />));
}
const button = (container, label) => [...container.querySelectorAll("button")].find(node => node.textContent.trim() === label);

describe("editor toolbar", () => {
  it("waits for an editor view and reattaches shortcuts after remount", async () => {
    makeEditor();
    editor.unmount();
    host = document.createElement("div"); document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<React.StrictMode><Toolbar editor={editor} aiActive={false} /></React.StrictMode>));
    for (let i = 0; i < 2; i++) {
      await act(async () => editor.mount(document.createElement("div")));
      const shortcut = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
      await act(async () => editor.view.dom.dispatchEvent(shortcut));
      expect(shortcut.defaultPrevented).toBe(true);
      expect(document.querySelector(".labs-pop input")).toBeTruthy();
      await act(async () => editor.unmount());
    }
  });

  it.each([4, 5, 6])("labels H%s and choosing the same heading does not toggle to paragraph", async level => {
    await mountToolbar(level);
    const label = `Heading ${level}`;
    expect(button(host, label)).toBeTruthy();
    await act(async () => button(host, label).click());
    await act(async () => button(document.querySelector(".labs-pop"), label).click());
    expect(editor.state.doc.firstChild.type.name).toBe("heading");
    expect(editor.state.doc.firstChild.attrs.level).toBe(level);
  });

  it.each(["ctrlKey", "metaKey"])("%s+K opens the existing link popover and applies to the selection", async modifier => {
    await mountToolbar();
    await act(async () => editor.commands.setTextSelection({ from: 1, to: 8 }));
    const shortcut = new KeyboardEvent("keydown", { key: "k", [modifier]: true, bubbles: true, cancelable: true });
    await act(async () => editor.view.dom.dispatchEvent(shortcut));
    expect(shortcut.defaultPrevented).toBe(true);
    const input = document.querySelector(".labs-pop input");
    expect(input).toBeTruthy();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "https://example.com");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(document.querySelector(".labs-pop"), "Apply").click());
    expect(editor.getAttributes("link").href).toBe("https://example.com");
    expect(editor.state.doc.firstChild.child(0).text).toBe("Heading");
  });

  it("does not intercept shortcuts outside the editor or during AI editing", async () => {
    await mountToolbar();
    const outside = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => document.body.dispatchEvent(outside));
    expect(outside.defaultPrevented).toBe(false);
    expect(document.querySelector(".labs-pop")).toBeNull();
    await act(async () => root.render(<Toolbar editor={editor} aiActive />));
    const disabled = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => editor.view.dom.dispatchEvent(disabled));
    expect(disabled.defaultPrevented).toBe(false);
    expect(document.querySelector(".labs-pop")).toBeNull();
  });

  it("ordinary link clicks do not open a new window in the editable document", () => {
    makeEditor();
    editor.chain().setTextSelection({ from: 1, to: 8 }).setLink({ href: "https://example.com" }).run();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const target = editor.view.dom.querySelector("a");
    const click = new MouseEvent("click", { button: 0, bubbles: true, cancelable: true });
    Object.defineProperty(click, "target", { value: target });
    editor.view.someProp("handleClick", handler => handler(editor.view, 2, click));
    expect(open).not.toHaveBeenCalled();
  });
});
