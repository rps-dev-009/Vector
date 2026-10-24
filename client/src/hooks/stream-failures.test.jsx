import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSession } from "./useChatSession.js";

let root, host, chat, request;
const model = { id: "gemma", name: "Gemma", thinking: { levels: ["high"], defaultLevel: "high" } };
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const assistant = () => chat.activeSession.messages.at(-1);

function Probe() {
  chat = useChatSession();
  return null;
}

async function send(response) {
  fetch.mockImplementationOnce(() => response);
  await act(async () => chat.setMessage("Help me"));
  await act(async () => { request = chat.handleSend(); });
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
    }) };
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ models: [model] }) })));
  localStorage.clear();
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
});

describe("chat stream failures", () => {
  it("times out a pending fetch before the first token after 180 seconds", async () => {
    await send(new Promise(() => {}));
    const signal = fetch.mock.calls.at(-1)[1].signal;
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(chat.isStreaming).toBe(true);
    expect(signal.aborted).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(120000));
    await request;
    expect(signal.aborted).toBe(true);
    expect(chat.isStreaming).toBe(false);
    expect(assistant()).toMatchObject({ errorOnly: true, error: { code: "timeout" } });
    expect(assistant().content).toContain("timed out");
  });

  it("gives first reasoning activity a new window but repeated activity cannot hold it busy", async () => {
    const stream = streamResponse();
    await send(stream.response);
    await act(async () => vi.advanceTimersByTimeAsync(120000));
    await stream.emit(frame("activity", { state: "reasoning" }));
    await act(async () => vi.advanceTimersByTimeAsync(120000));
    expect(chat.isStreaming).toBe(true);
    await stream.emit(frame("activity", { state: "reasoning" }) + frame("activity", { state: "thinking" }));
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    await request;
    expect(chat.isStreaming).toBe(false);
    expect(assistant().error.code).toBe("timeout");
    expect(stream.cancel).toHaveBeenCalledOnce();
  });

  it("resets on real tokens and preserves unflushed output on timeout", async () => {
    const stream = streamResponse();
    await send(stream.response);
    await act(async () => vi.advanceTimersByTimeAsync(120000));
    await stream.emit(frame("token", { text: "Partial answer" }));
    await act(async () => vi.advanceTimersByTimeAsync(120000));
    expect(chat.isStreaming).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    await request;
    expect(assistant().content).toMatch(/^Partial answer\n\nRequest timed out/);
    expect(assistant().errorOnly).toBe(false);
    expect(chat.isStreaming).toBe(false);
  });

  it.each(["done", "error"])("ends %s exactly once and cancels a held-open socket", async event => {
    const stream = streamResponse();
    await send(stream.response);
    await stream.emit(frame("token", { text: "Buffered answer" })
      + frame(event, event === "error" ? { code: "quota", message: "Quota exhausted.", recoverable: false } : { ok: true })
      + frame("token", { text: "Must be ignored" })
      + frame("error", { message: "Duplicate failure" }));
    await request;
    expect(chat.isStreaming).toBe(false);
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(assistant().content).toBe(event === "error" ? "Buffered answer\n\nQuota exhausted." : "Buffered answer");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("reports explicit EOF failure and keeps partial output: %s", async partial => {
    const stream = streamResponse();
    await send(stream.response);
    await stream.emit(partial ? frame("token", { text: "Saved partial" }) : "", true);
    await request;
    expect(chat.isStreaming).toBe(false);
    expect(assistant().error.code).toBe(partial ? "interrupted" : "empty_response");
    expect(assistant().content).toContain(partial ? "Saved partial\n\nResponse was interrupted" : "empty response");
  });

  it("reports a done event with no answer instead of leaving a blank record", async () => {
    const stream = streamResponse();
    await send(stream.response);
    await stream.emit(frame("done", { ok: true }));
    await request;
    expect(assistant().error.code).toBe("empty_response");
    expect(chat.isStreaming).toBe(false);
  });

  it("shows safe HTTP JSON messages and excludes error-only answers from subsequent history", async () => {
    await send(new Response(JSON.stringify({ code: "quota", message: "Daily quota exhausted.", recoverable: false }), { status: 429 }));
    await request;
    expect(assistant().content).toBe("Daily quota exhausted.");
    expect(assistant().error).toMatchObject({ code: "quota", recoverable: false });
    await send(new Response(frame("token", { text: "Success" }) + frame("done", { ok: true })));
    await request;
    const history = JSON.parse(fetch.mock.calls.at(-1)[1].body).messages;
    expect(history).toEqual([{ role: "user", content: "Help me" }]);
  });

  it("uses an HTTP fallback rather than showing raw non-JSON bodies", async () => {
    await send(new Response("Internal provider details", { status: 503 }));
    await request;
    expect(assistant().content).toBe("Request failed (503)");
  });

  it("also times out a pending HTTP error body", async () => {
    await send({ ok: false, status: 503, json: () => new Promise(() => {}) });
    await act(async () => vi.advanceTimersByTimeAsync(180000));
    await request;
    expect(assistant().error.code).toBe("timeout");
    expect(chat.isStreaming).toBe(false);
  });

  it("does not wait for transport cancellation to settle after done", async () => {
    const cancel = vi.fn(() => new Promise(() => {}));
    await send(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame("token", { text: "Complete" }) + frame("done", { ok: true })));
      }, cancel
    })));
    await request;
    expect(assistant().content).toBe("Complete");
    expect(chat.isStreaming).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("Stop releases a pending request and allows another send", async () => {
    await send(new Promise(() => {}));
    await act(async () => chat.handleStop());
    await request;
    expect(chat.isStreaming).toBe(false);
    expect(assistant().content).toContain("stopped");
    await send(new Response(frame("token", { text: "Next answer" }) + frame("done", { ok: true })));
    await request;
    expect(assistant().content).toBe("Next answer");
  });

  it("aborts an active request on unmount", async () => {
    await send(new Promise(() => {}));
    const signal = fetch.mock.calls.at(-1)[1].signal;
    await act(async () => root.unmount());
    await request;
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
