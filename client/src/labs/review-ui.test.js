import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Plugin } from "@tiptap/pm/state";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import LabsWorkspace from "./LabsWorkspace.jsx";
import { restoreEntries } from "./applyEdit.js";

let root, host, editor, stream;
const noOp = () => {};
const ready = value => { editor = value; };
const initial = {
  id: "review-test", name: "Review test", document: "Original document", chat: [],
  content: { type: "doc", content: [
    { type: "heading", attrs: { blockId: "title", level: 1 }, content: [{ type: "text", text: "Title" }] },
    { type: "paragraph", attrs: { blockId: "p1" }, content: [{ type: "text", text: "Original first paragraph.", marks: [{ type: "bold" }] }] },
    { type: "paragraph", attrs: { blockId: "p2" }, content: [{ type: "text", text: "Original second paragraph." }] }
  ] }
};
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ||= class { observe() {} disconnect() {} };
  Element.prototype.scrollTo ||= noOp;
  Element.prototype.scrollIntoView ||= noOp;
  window.scrollTo = noOp;
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = null; host?.remove(); editor = null;
  vi.restoreAllMocks();
});
function Harness() {
  const [project, setProject] = useState(initial);
  return React.createElement(LabsWorkspace, {
    activeProject: project, onUpdateContent: (content, document) => setProject(p => ({ ...p, content, document, updatedAt: Date.now() })),
    onAppendChat: messages => setProject(p => ({ ...p, chat: [...p.chat, ...messages] })),
    storageStatus: "ok", onSaveStatusChange: noOp, assistantOpen: true, onToggleAssistant: noOp,
    isMobile: false, mobileTab: "document", onEditorReady: ready
  });
}
async function mount() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { "content-type": "text/event-stream" } }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(React.createElement(Harness)));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(editor).toBeTruthy();
}
async function send(text = "Update the first paragraph") {
  await act(async () => {
    const textarea = host.querySelector("textarea");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => host.querySelector('button[title="Send (Enter)"]').click());
}
async function emit(events, close = true) {
  await act(async () => {
    const data = events.map(([event, payload]) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`).join("");
    stream.enqueue(new TextEncoder().encode(data));
    if (close) stream.close();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}
const done = ["done", { ok: true, summary: "Updated.", editCount: 1 }];
const replacement = ["edit", { op: "replace", blockId: "p1", after: "AI replacement." }];
const button = label => [...host.querySelectorAll("button")].find(b => b.textContent.trim() === label);
const block = id => editor.getJSON().content.find(n => n.attrs?.blockId === id);

describe("review controls through real workspace and SSE", () => {
  it("Reject all restores the complete original document and removes highlights", async () => {
    await mount(); const before = editor.getJSON(); await send();
    await emit([replacement, done]);
    expect(button("Reject all")).toBeTruthy();
    await act(async () => button("Reject all").click());
    expect(editor.getJSON()).toEqual(before);
    expect(host.querySelector(".labs-review-modified")).toBeNull();
    expect(host.textContent).toContain("Rejected 1 change");
  });

  it("Accept all resolves unexpected changes too, without reverting their content", async () => {
    await mount(); await send();
    await act(async () => {
      editor.view.dispatch(editor.state.tr.insertText("Unexpected ", 1).setMeta("labsEdit", true));
    });
    await emit([done]);
    expect(button("Accept all")).toBeTruthy();
    const accepted = editor.getJSON();
    await act(async () => button("Accept all").click());
    expect(editor.getJSON()).toEqual(accepted);
    expect(host.querySelector(".labs-review-modified")).toBeNull();
    expect(host.textContent).not.toContain("change to review");
    expect(host.textContent).toContain("Accepted 1 change");
  });

  it("does not expose per-block review while later AI edits can overwrite a rejection", async () => {
    await mount(); await send();
    await emit([replacement], false);
    await act(async () => host.querySelector('[data-block-id="p1"]').dispatchEvent(new MouseEvent("mousemove", { bubbles: true })));
    expect(host.querySelector(".labs-block-actions")).toBeNull();
    await emit([["edit", { op: "replace", blockId: "p1", after: "AI second replacement." }], done]);
    await act(async () => button("Reject all").click());
    expect(block("p1").content[0].text).toBe("Original first paragraph.");
  });

  it("keeps pending review visible when an editor plugin refuses restoration", async () => {
    await mount(); await send(); await emit([replacement, done]);
    editor.registerPlugin(new Plugin({ filterTransaction: tr => !(tr.getMeta("labsEditIds") || []).some(id => id.startsWith("restore:")) }));
    await act(async () => button("Reject all").click());
    expect(block("p1").content[0].text).toBe("AI replacement.");
    expect(host.querySelector(".labs-review-modified")).toBeTruthy();
    expect(host.querySelector('[role="alert"]').textContent).toMatch(/restore|reject/i);
    expect(host.textContent).toContain("change to review");
  });

  it("preserves unreviewed changes across follow-up questions and later edits", async () => {
    await mount(); const before = editor.getJSON();
    await send(); await emit([replacement, done]);
    await send("What did you change?"); await emit([done]);
    expect(button("Reject all")).toBeTruthy();
    expect(block("p1").content[0].text).toBe("AI replacement.");
    await send("Rewrite it again");
    await emit([["edit", { op: "replace", blockId: "p1", after: "AI rewrite in a later run." }], done]);
    await act(async () => button("Reject all").click());
    expect(editor.getJSON()).toEqual(before);
  });

  it("rejects a mixed batch atomically in original order, with one undo action", async () => {
    await mount(); const before = editor.getJSON(); await send();
    await emit([
      ["edit", { op: "delete", blockId: "p1" }],
      ["edit", { op: "delete", blockId: "p2" }],
      ["edit", { op: "insert", blockId: "new", afterId: "title", type: "paragraph", after: "AI addition." }], done
    ]);
    const after = editor.getJSON();
    await act(async () => button("Reject all").click());
    expect(editor.getJSON()).toEqual(before);
    await act(async () => editor.commands.undo());
    expect(editor.getJSON()).toEqual(after);
  });

  it("does not partially reject a batch with an invalid original snapshot", async () => {
    await mount(); const original = block("p1"); await send(); await emit([replacement, done]);
    const before = editor.getJSON();
    const log = vi.spyOn(console, "error").mockImplementation(noOp);
    expect(restoreEntries(editor, [
      { blockId: "p1", before: original }, { blockId: "p2", before: { type: "invalid-node" } }
    ])).toBe(false);
    expect(editor.getJSON()).toEqual(before);
    expect(button("Reject all")).toBeTruthy();
    log.mockRestore();
  });
});
