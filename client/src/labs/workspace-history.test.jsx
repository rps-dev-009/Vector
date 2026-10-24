import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import LabsWorkspace from "./LabsWorkspace.jsx";

const agent = vi.hoisted(() => ({ callbacks: null, isRunning: false, start: vi.fn(), stop: vi.fn() }));
vi.mock("./hooks/useLabsAgent.js", () => ({ useLabsAgent: callbacks => {
  agent.callbacks = callbacks;
  return agent;
} }));

let root, host, editor;
const noOp = () => {};
const project = {
  id: "history-test", chat: [],
  content: { type: "doc", content: [{ type: "paragraph", attrs: { blockId: "p1" }, content: [{ type: "text", text: "Original." }] }] }
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
  host?.remove(); root = null; host = null; editor = null;
  vi.restoreAllMocks();
});

async function startRun() {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<LabsWorkspace
    activeProject={project} selectedModel={{ id: "test-model" }} onUpdateContent={noOp}
    onAppendChat={noOp} onSaveStatusChange={noOp} storageStatus="ok" assistantOpen
    onToggleAssistant={noOp} onEditorReady={value => { editor = value; }}
  />));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(editor).toBeTruthy();
  await act(async () => {
    const input = host.querySelector("textarea");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, "Extend the paragraph");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => host.querySelector('button[title="Send (Enter)"]').click());
  expect(editor.isEditable).toBe(false);
}

async function edit(before, after) {
  await act(async () => agent.callbacks.onEditBatch([{ op: "replace_in_block", blockId: "p1", before, after }]));
}

describe("AI run history boundaries", () => {
  it.each(["done", "partial", "error", "abort"])("isolates immediate manual typing after %s without grouping delayed AI batches", async ending => {
    await startRun();
    const original = editor.getJSON();
    const clock = vi.spyOn(Date, "now").mockReturnValue(100000);
    await edit("Original.", "Original. AI");
    const firstBatch = editor.getJSON();
    clock.mockReturnValue(101000);
    await edit("Original. AI", "Original. AI more");
    const lastBatch = editor.getJSON();
    await act(async () => {
      if (ending === "done") agent.callbacks.onDone({ ok: true, summary: "", editCount: 2 });
      else if (ending === "partial") agent.callbacks.onDone({ ok: false, summary: "", truncated: true, editCount: 2 });
      else if (ending === "error") agent.callbacks.onError({ message: "Interrupted", recoverable: true });
      else agent.callbacks.onAbort();
    });
    expect(editor.isEditable).toBe(true);
    // Same timestamp and adjacent text would merge into the last AI group
    // without closeHistory in finalizeRun.
    await act(async () => editor.view.dispatch(editor.state.tr.insertText(" manual", editor.state.doc.firstChild.nodeSize - 1)));
    await act(async () => editor.commands.undo());
    expect(editor.getJSON()).toEqual(lastBatch);
    await act(async () => editor.commands.undo());
    expect(editor.getJSON()).toEqual(firstBatch);
    await act(async () => editor.commands.undo());
    expect(editor.getJSON()).toEqual(original);
  });
});
