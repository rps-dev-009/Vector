import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLabsAgent } from "./hooks/useLabsAgent.js";
import AssistantPane from "./AssistantPane.jsx";

let root, host, agent, handlers, request;
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const edit = { op: "replace", blockId: "p1", after: "Keep this edit" };

function Probe() {
  agent = useLabsAgent(handlers);
  return null;
}

async function start(response) {
  fetch.mockImplementationOnce(() => response);
  await act(async () => { request = agent.start(() => ({ instruction: "Edit", blocks: [] })); });
}

function streamResponse() {
  let stream;
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ start(controller) { stream = controller; }, cancel }), {
    headers: { "content-type": "text/event-stream" }
  });
  return { response, cancel,
    emit: async (text, close = false) => act(async () => {
      if (text) stream.enqueue(new TextEncoder().encode(text));
      if (close) stream.close();
    }),
    fail: async () => act(async () => stream.error(new TypeError("Network failed"))) };
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollTo ||= () => {};
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn());
  handlers = Object.fromEntries(["onActivity", "onEditBatch", "onToken", "onError", "onDone", "onAbort"].map(name => [name, vi.fn()]));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Probe />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Labs stream failures", () => {
  it("times out pending fetch after 180 seconds with a recoverable timeout, not abort", async () => {
    await start(new Promise(() => {}));
    const signal = fetch.mock.calls.at(-1)[1].signal;
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(agent.isRunning).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(120000));
    await request;
    expect(signal.aborted).toBe(true);
    expect(agent.isRunning).toBe(false);
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "timeout", recoverable: true }));
    expect(handlers.onAbort).not.toHaveBeenCalled();
  });

  it("gives reasoning one new window without allowing activity-only stalls forever", async () => {
    const stream = streamResponse();
    await start(stream.response);
    await act(async () => vi.advanceTimersByTimeAsync(120000));
    await stream.emit(frame("activity", { state: "reasoning" }));
    await act(async () => vi.advanceTimersByTimeAsync(120000));
    expect(agent.isRunning).toBe(true);
    await stream.emit(frame("activity", { state: "reasoning" }) + frame("activity", { state: "thinking" }));
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    await request;
    expect(agent.isRunning).toBe(false);
    expect(handlers.onError.mock.calls[0][0].code).toBe("timeout");
    expect(stream.cancel).toHaveBeenCalledOnce();
  });

  it.each(["token", "edit"])("resets on %s progress and keeps applied output after timeout", async event => {
    const stream = streamResponse();
    await start(stream.response);
    await act(async () => vi.advanceTimersByTimeAsync(120000));
    await stream.emit(frame(event, event === "edit" ? edit : { text: "Keep this text" }));
    await act(async () => vi.advanceTimersByTimeAsync(120000));
    expect(agent.isRunning).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    await request;
    expect(handlers.onError).toHaveBeenCalledOnce();
    expect(handlers.onError.mock.calls[0][0].code).toBe("timeout");
    if (event === "edit") expect(handlers.onEditBatch).toHaveBeenCalledExactlyOnceWith([edit]);
    else expect(handlers.onToken).toHaveBeenCalledExactlyOnceWith({ text: "Keep this text" });
  });

  it.each(["done", "error"])("flushes edits before %s and finishes a held-open socket exactly once", async event => {
    const order = [];
    handlers.onEditBatch.mockImplementation(() => order.push("edit"));
    handlers.onDone.mockImplementation(() => order.push("done"));
    handlers.onError.mockImplementation(() => order.push("error"));
    const stream = streamResponse();
    await start(stream.response);
    await stream.emit(frame("edit", edit)
      + frame(event, event === "error" ? { code: "quota", message: "Quota exhausted.", recoverable: false } : { ok: true })
      + frame("edit", { ...edit, after: "Must not apply" })
      + frame("done", { ok: true }) + frame("error", { message: "Must not finalize twice" }));
    await request;
    expect(order).toEqual(["edit", event]);
    expect(handlers.onEditBatch).toHaveBeenCalledExactlyOnceWith([edit]);
    expect(agent.isRunning).toBe(false);
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("finalizes empty/truncated EOF with onError: %s", async partial => {
    const stream = streamResponse();
    await start(stream.response);
    await stream.emit(partial ? frame("edit", edit) + frame("token", { text: "Partial" }) : "", true);
    await request;
    expect(agent.isRunning).toBe(false);
    expect(handlers.onError).toHaveBeenCalledOnce();
    expect(handlers.onError.mock.calls[0][0]).toMatchObject({ code: "network", recoverable: true });
    expect(handlers.onError.mock.calls[0][0].message).toContain(partial ? "interrupted" : "empty response");
    expect(handlers.onDone).not.toHaveBeenCalled();
    if (partial) expect(handlers.onEditBatch).toHaveBeenCalledExactlyOnceWith([edit]);
  });

  it("finalizes network failure with onError while preserving earlier edits", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stream = streamResponse();
    await start(stream.response);
    await stream.emit(frame("edit", edit));
    await stream.fail();
    await request;
    expect(handlers.onError).toHaveBeenCalledOnce();
    expect(handlers.onEditBatch).toHaveBeenCalledExactlyOnceWith([edit]);
    expect(agent.isRunning).toBe(false);
  });

  it.each([429, 503])("preserves supplied safe HTTP %s error and retry metadata", async status => {
    const error = { code: "rate_limit", message: "Gemma requests are limited. Wait before retrying.", recoverable: true, retryAfterSeconds: 42 };
    await start(new Response(JSON.stringify(error), { status, headers: { "content-type": "application/json" } }));
    await request;
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(agent.isRunning).toBe(false);
  });

  it("preserves quota instead of replacing it with AI busy", async () => {
    const error = { code: "quota", message: "Daily Gemma quota exhausted.", recoverable: false };
    await start(new Response(JSON.stringify(error), { status: 429 }));
    await request;
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(error));
  });

  it("retains status-specific legacy fallbacks without displaying non-string JSON errors", async () => {
    await start(new Response(JSON.stringify({ error: "Document too large." }), { status: 413 }));
    await request;
    expect(handlers.onError.mock.calls[0][0]).toMatchObject({ code: "too_large", message: "Document too large.", recoverable: false });
    await start(new Response(JSON.stringify({ error: { internal: "Do not display this" } }), { status: 400 }));
    await request;
    expect(handlers.onError.mock.calls[1][0].message).toBe("The request was rejected (400).");
  });

  it("times out a pending HTTP error body", async () => {
    await start({ ok: false, status: 503, headers: new Headers(), json: () => new Promise(() => {}) });
    await act(async () => vi.advanceTimersByTimeAsync(180000));
    await request;
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "timeout", recoverable: true }));
    expect(agent.isRunning).toBe(false);
  });

  it("does not wait for pending socket cancellation after a terminal event", async () => {
    const cancel = vi.fn(() => new Promise(() => {}));
    await start(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(frame("done", { ok: true }))); }, cancel
    }), { headers: { "content-type": "text/event-stream" } }));
    await request;
    expect(handlers.onDone).toHaveBeenCalledExactlyOnceWith({ ok: true });
    expect(agent.isRunning).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("Stop cancels a held-open stream, preserves edits and permits another run", async () => {
    const stream = streamResponse();
    await start(stream.response);
    await stream.emit(frame("edit", edit));
    await act(async () => agent.stop());
    await request;
    expect(handlers.onAbort).toHaveBeenCalledOnce();
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(handlers.onEditBatch).toHaveBeenCalledExactlyOnceWith([edit]);
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(agent.isRunning).toBe(false);
    await start(new Response(frame("done", { ok: true }), { headers: { "content-type": "text/event-stream" } }));
    await request;
    expect(handlers.onDone).toHaveBeenCalledOnce();
  });

  it("aborts pending fetch and clears timers on unmount", async () => {
    await start(new Promise(() => {}));
    const signal = fetch.mock.calls.at(-1)[1].signal;
    await act(async () => root.unmount());
    await request;
    expect(signal.aborted).toBe(true);
    expect(handlers.onAbort).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("AssistantPane error messages", () => {
  async function show(error) {
    await act(async () => root.render(<AssistantPane chat={[]} run={{ status: "error", error }}
      instruction="" setInstruction={() => {}} onDismissError={vi.fn()} />));
  }

  it.each(["quota", "auth", "rate_limit"])("shows the supplied %s message without blanket AI busy text", async code => {
    await show({ code, message: "Specific provider guidance.", recoverable: false });
    expect(host.textContent).toContain("Specific provider guidance.");
    expect(host.textContent).not.toContain("The AI is busy");
    expect(host.textContent).not.toContain("GEMINI_API_KEY");
    if (code === "quota") expect(host.textContent).not.toContain("Dismiss");
  });

  it("does not offer quota retry even if recoverable metadata is supplied", async () => {
    await show({ code: "quota", message: "Quota exhausted.", recoverable: true, retryAfterSeconds: 2 });
    expect(host.textContent).not.toContain("Dismiss");
    expect(host.textContent).not.toContain("Try again in");
  });

  it("keeps rate-limit guidance visible as the retry countdown expires", async () => {
    await show({ code: "rate_limit", message: "Too many Gemma requests.", recoverable: true, retryAfterSeconds: 2 });
    expect(host.textContent).toContain("Too many Gemma requests. Try again in 2s.");
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(host.textContent).toContain("Try again in 1s.");
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(host.textContent).toContain("Too many Gemma requests.");
    expect(host.textContent).not.toContain("Try again in");
  });

  it("uses a friendly rate-limit fallback when the server omits a message", async () => {
    await show({ code: "rate_limit", retryAfterSeconds: 3, recoverable: true });
    expect(host.textContent).toContain("Too many requests. Please try again shortly. Try again in 3s.");
  });
});
