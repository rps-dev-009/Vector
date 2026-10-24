import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import LabsWorkspace from "./LabsWorkspace.jsx";
import { IMAGE_LIMITS, imageForRequest, prepareImage } from "./imageAttachments.js";

vi.mock("./imageAttachments.js", async importOriginal => ({
  ...await importOriginal(),
  prepareImage: vi.fn()
}));

let root, host, editor, stream;
const noOp = () => {};
const ready = value => { editor = value; };
const initial = {
  id: "continuation-test", chat: [],
  content: { type: "doc", content: [
    { type: "paragraph", attrs: { blockId: "p1" }, content: [{ type: "text", text: "Original selected paragraph." }] },
    { type: "paragraph", attrs: { blockId: "p2" }, content: [{ type: "text", text: "Unrelated second paragraph." }] }
  ] }
};
const restriction = "dont wrie anything i want blank spaces wherever we can add diagrams";
const partial = { ok: true, truncated: true, stopReason: "tool_error", summary: "", editCount: 0 };
const button = label => [...host.querySelectorAll("button")].find(b => b.textContent.trim() === label);
const request = () => JSON.parse(fetch.mock.calls.at(-1)[1].body);

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
  root = null; host?.remove(); host = null; editor = null; stream = null;
  prepareImage.mockReset();
  vi.restoreAllMocks();
});

function Harness() {
  const [project, setProject] = useState(initial);
  return <LabsWorkspace
    activeProject={project} selectedModel={{ id: "test-model" }}
    onUpdateContent={(content, document) => setProject(p => ({ ...p, content, document }))}
    onAppendChat={messages => setProject(p => ({ ...p, chat: [...p.chat, ...messages] }))}
    storageStatus="ok" onSaveStatusChange={noOp} assistantOpen
    onToggleAssistant={noOp} onEditorReady={ready}
  />;
}

async function mount() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    expect(url).toBe("/labs/agent");
    const body = JSON.parse(options.body);
    const count = body.images.length + body.messages.reduce((sum, m) => sum + (m.images?.length || 0), 0);
    return new Response(new ReadableStream({ start(controller) { stream = controller; } }), {
      headers: { "content-type": "text/event-stream", [IMAGE_LIMITS.receiptHeader]: String(count) }
    });
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Harness />));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(editor).toBeTruthy();
}

async function send(text) {
  await act(async () => {
    const textarea = host.querySelector("textarea");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => host.querySelector('button[title="Send (Enter)"]').click());
}

async function finish(done = partial, edits = []) {
  await act(async () => {
    const events = [...edits.map(edit => ["edit", edit]), ["done", done]];
    stream.enqueue(new TextEncoder().encode(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("")));
    stream.close();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

async function selectText(id, attach = true) {
  await act(async () => {
    editor.state.doc.forEach((node, pos) => {
      if (node.attrs.blockId === id) editor.commands.setTextSelection({ from: pos + 1, to: pos + 1 + node.textContent.length });
    });
  });
  if (attach) await askAI();
}

async function askAI() {
  // Tiptap debounces the selection bubble by 250 ms before attaching its DOM.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
  await act(async () => button("Ask AI").click());
}

async function continueWork() {
  expect(button("Continue the work")).toBeTruthy();
  await act(async () => button("Continue the work").click());
}

describe("task-preserving Continue through mocked SSE", () => {
  it("preserves the exact request and original selection across unrelated selections and repeated Continue", async () => {
    await mount();
    await selectText("p1");
    const original = `  ${restriction}\n`;
    await send(original);
    const first = request();
    expect(first.instruction).toBe(original);
    expect(first.selection).toEqual({ blockIds: ["p1"], text: "Original selected paragraph." });
    expect(first.continuation).toBeUndefined();
    const failedOperations = [{ tool: "insert_blocks", blockId: "p1", message: "A blank spacer is required.", code: "invalid_text" }];
    const targetWords = { min: 100, max: 200, source: "words" };
    await finish({ ...partial, targetWords, failedOperations, summary: "I cannot create model flowcharts." }, [
      { op: "replace", blockId: "p1", after: "Successful earlier edit." }
    ]);
    await selectText("p2");
    await continueWork();
    expect(request()).toMatchObject({ instruction: original, selection: first.selection, continuation: { targetWords, failedOperations } });
    expect(request().blocks.find(b => b.id === "p1").text).toBe("Successful earlier edit.");
    const nextFailures = [{ tool: "set_block_attrs", blockId: "p1", message: "Height is out of range." }];
    await finish({ ...partial, failedOperations: nextFailures });
    await selectText("p2", false);
    await continueWork();
    expect(request()).toMatchObject({ instruction: original, selection: first.selection,
      continuation: { targetWords: null, failedOperations: nextFailures } });
    await finish({ ok: true });
  });

  it("keeps an originally unscoped task unscoped despite a new selected-text chip", async () => {
    await mount(); await send(restriction); await finish();
    expect(request().selection).toBeNull();
    await selectText("p2");
    await continueWork();
    expect(request()).toMatchObject({ instruction: restriction, selection: null,
      continuation: { targetWords: null, failedOperations: [] } });
    await finish({ ok: true });
  });

  it("resets the task and continuation metadata for each new ordinary request", async () => {
    await mount(); await selectText("p1"); await send("Write a long assignment.");
    await finish({ ...partial, targetWords: { min: 2500, max: 3500, source: "default" },
      failedOperations: [{ tool: "replace_block", blockId: "p1", message: "Old failure" }] });
    await selectText("p2");
    await send(restriction);
    const latest = request();
    expect(latest.continuation).toBeUndefined();
    expect(latest.selection).toEqual({ blockIds: ["p2"], text: "Unrelated second paragraph." });
    await finish({ ...partial, summary: "Suggested model flowchart changes are unfinished." });
    await continueWork();
    expect(request()).toMatchObject({ instruction: restriction, selection: latest.selection,
      continuation: { targetWords: null, failedOperations: [] } });
    await finish();
    await send("Only fix punctuation.");
    expect(request().continuation).toBeUndefined();
    await finish(); await continueWork();
    expect(request()).toMatchObject({ instruction: "Only fix punctuation.", selection: null });
    await finish({ ok: true });
  });

  it("passes an overlength target without escalating a selected edit to a whole-document rewrite", async () => {
    await mount(); await selectText("p1"); await send("Shorten only this paragraph to 20 words.");
    const first = request();
    const targetWords = { min: 20, max: 20, source: "words" };
    await finish({ ...partial, stopReason: "length_target", targetWords, wordCount: 400 });
    await continueWork();
    expect(request()).toMatchObject({ instruction: first.instruction, selection: first.selection,
      continuation: { targetWords, failedOperations: [] } });
    expect(request().instruction).not.toMatch(/rewrite the whole document/i);
    await finish({ ok: true });
  });

  it.each([true, false])("renders actual operation errors as escaped text without inferring model flowcharts, and retains review (ok=%s)", async ok => {
    await mount(); await send(restriction);
    const failedOperations = [
      { tool: "insert_blocks", blockId: "p2", message: 'Blank text rejected: <img src=x onerror="alert(1)">', code: "empty_text" },
      { tool: "set_block_attrs", message: "heightPt must be between 24 and 360." }
    ];
    await finish({ ok, truncated: false, failedOperations, editCount: 1 }, [
      { op: "replace", blockId: "p1", after: "Successful edit remains reviewable." }
    ]);
    const details = host.querySelector('[aria-label="Failed operations"]');
    expect(details.textContent).toContain("insert_blocks on p2 (empty_text)");
    expect(details.textContent).toContain(failedOperations[0].message);
    expect(details.textContent).toContain("set_block_attrs");
    expect(details.textContent).toContain(failedOperations[1].message);
    expect(details.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("The requested changes are not finished.");
    expect(host.textContent).not.toMatch(/whole document incomplete|model flowchart/i);
    expect(button("Continue the work")).toBeTruthy();
    expect(button("Accept all")).toBeTruthy();
    await act(async () => button("Reject all").click());
    expect(editor.state.doc.firstChild.textContent).toBe("Original selected paragraph.");
  });

  it("retains all original image bodies across repeated Continue and uses the existing cache for follow-ups", async () => {
    await mount();
    const images = ["a", "b", "c", "d"].map(id => ({ id, name: `${id}.png`, mediaType: "image/png",
      data: "aGVsbG8=", preview: "data:image/png;base64,aGVsbG8=", bytes: 5, width: 20, height: 10 }));
    for (const image of images) prepareImage.mockResolvedValueOnce(image);
    await act(async () => {
      const input = host.querySelector('input[type="file"]');
      Object.defineProperty(input, "files", { configurable: true,
        value: images.map(image => new File(["image"], image.name, { type: image.mediaType })) });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await send(restriction);
    expect(request().images).toEqual(images.map(imageForRequest));
    for (let i = 0; i < 6; i++) {
      await finish({ ...partial, summary: `Partial attempt ${i}.` });
      await continueWork();
      expect(request().instruction).toBe(restriction);
      expect(request().images).toEqual(images.map(imageForRequest));
      expect(request().messages.flatMap(m => m.images || [])).toEqual([]);
    }
    await finish({ ok: true });
    await send("Explain the images without editing.");
    expect(request().continuation).toBeUndefined();
    expect(request().images).toEqual([]);
    expect(request().messages.flatMap(m => m.images || [])).toEqual(images.map(imageForRequest));
    // A new task can depend on cached history images rather than new attachments.
    for (let i = 0; i < 6; i++) {
      await finish({ ...partial, summary: `Partial explanation ${i}.` });
      await continueWork();
      expect(request().instruction).toBe("Explain the images without editing.");
      expect(request().images).toEqual(images.map(imageForRequest));
      expect(request().messages.flatMap(m => m.images || [])).toEqual([]);
    }
    await finish({ ok: true });
  });

  it("captures a selected spacer atom with empty text and keeps its UI label out of requests", async () => {
    await mount();
    await act(async () => {
      editor.commands.insertContentAt(0, { type: "spacer", attrs: { blockId: "space1", heightPt: 144 } });
      editor.commands.setNodeSelection(0);
    });
    await askAI();
    expect(host.textContent).toContain("Blank space");
    await send("Make this blank space taller.");
    expect(request().selection).toEqual({ blockIds: ["space1"], text: "" });
    await finish();
    await selectText("p2"); await continueWork();
    expect(request()).toMatchObject({ instruction: "Make this blank space taller.", selection: { blockIds: ["space1"], text: "" } });
    await finish({ ok: true });
  });
});
