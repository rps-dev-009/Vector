import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Plugin } from "@tiptap/pm/state";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import LabsWorkspace from "./LabsWorkspace.jsx";
import { restoreEntries } from "./applyEdit.js";

let root, host, editor, stream;
const noOp = () => {};
const models = [
  { id: "gemini-3.5-flash-lite", name: "Gemini", thinking: { levels: ["minimal", "low", "medium", "high"], defaultLevel: "medium" } },
  { id: "gemma-4-31b-it", name: "Gemma", thinking: { levels: ["minimal", "high"], defaultLevel: "high" } }
];
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
  Range.prototype.getClientRects ||= () => [];
  Range.prototype.getBoundingClientRect ||= () => new DOMRect();
  window.scrollTo = noOp;
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = null; host?.remove(); editor = null;
  vi.restoreAllMocks();
});
function Harness() {
  const [project, setProject] = useState(initial);
  const [modelId, setModelId] = useState(models[0].id);
  const [level, setLevel] = useState("");
  const selectedModel = models.find(model => model.id === modelId);
  return React.createElement(LabsWorkspace, {
    models, selectedModel, thinkingLevel: level || selectedModel.thinking.defaultLevel,
    onSelectModel: id => { setModelId(id); setLevel(""); }, onThinkingLevelChange: setLevel,
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
  it("shows the real partial reason and retains the word target when continuing", async () => {
    await mount(); await send("Write a full assignment");
    await emit([replacement, ["done", { ok: true, truncated: true, stopReason: "length_target", wordCount: 900,
      targetWords: { min: 2500, max: 3500, source: "default" }, editCount: 1 }]]);
    expect(host.textContent).toContain("outside the requested word range");
    expect(host.textContent).toContain("900 document words; target 2,500-3,500 words");
    expect(host.textContent).not.toContain("used all");
    await act(async () => editor.commands.setTextSelection({ from: 1, to: 4 }));
    await act(async () => button("Continue the work").click());
    const request = JSON.parse(fetch.mock.calls.at(-1)[1].body);
    expect(request.instruction).toBe("Write a full assignment");
    expect(request.continuation).toEqual({ targetWords: { min: 2500, max: 3500, source: "default" }, failedOperations: [] });
    expect(request.selection).toBeNull();
    await emit([done]);
  });

  it("does not offer a futile continuation after the document size limit", async () => {
    await mount(); await send();
    await emit([["done", { ok: true, truncated: true, stopReason: "document_limit", wordCount: 30000, editCount: 0 }]]);
    expect(host.textContent).toContain("separate document");
    expect(button("Continue the work")).toBeUndefined();
  });

  it.each([false, true])("unlocks the workspace after EOF without done and preserves review: %s", async partial => {
    await mount(); await send();
    await emit(partial ? [replacement] : []);
    expect(host.querySelector("textarea").disabled).toBe(false);
    expect(host.querySelector('[aria-label="Labs model"]').disabled).toBe(false);
    expect(editor.isEditable).toBe(true);
    expect(host.textContent).toContain(partial ? "interrupted before completion" : "empty response");
    if (partial) {
      expect(block("p1").content[0].text).toBe("AI replacement.");
      expect(button("Reject all")).toBeTruthy();
    }
  });

  it("switches model and thinking in the same workspace and sends preserved project context", async () => {
    await mount();
    const originalEditor = editor;
    const originalDoc = editor.getJSON();
    await send("First request");
    await emit([done]);
    await act(async () => {
      const select = host.querySelector('[aria-label="Labs model"]');
      select.value = models[1].id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const thinking = host.querySelector('[aria-label="Thinking level"]');
    expect([...thinking.options].map(option => option.value)).toEqual(["minimal", "high"]);
    expect(thinking.value).toBe("high");
    await act(async () => {
      thinking.value = "minimal";
      thinking.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await send("Second request");
    const request = JSON.parse(fetch.mock.calls.at(-1)[1].body);
    expect(request).toMatchObject({ projectId: initial.id, modelId: models[1].id, thinkingLevel: "minimal" });
    expect(request.messages[0]).toMatchObject({ role: "user", content: "First request" });
    expect(host.querySelector('[aria-label="Labs model"]').disabled).toBe(true);
    expect(thinking.disabled).toBe(true);
    await emit([done]);
    expect(editor).toBe(originalEditor);
    expect(editor.getJSON()).toEqual(originalDoc);
  });

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
