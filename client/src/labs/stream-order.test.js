import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { it, expect, vi } from "vitest";
import { useLabsAgent } from "./hooks/useLabsAgent.js";

it("flushes styling edits before done in the same SSE chunk", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const order = [];
  const edit = { op: "set_document_style", blockId: "__labs_document_style__", after: { preset: "botanical" } };
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
    `event: edit\ndata: ${JSON.stringify(edit)}\n\nevent: done\ndata: {"ok":true,"editCount":1}\n\n`,
    { headers: { "content-type": "text/event-stream" } }
  ));
  const host = document.createElement("div");
  const root = createRoot(host);
  let agent;
  function Probe() {
    agent = useLabsAgent({ onEditBatch: batch => order.push(["edit", batch]), onDone: done => order.push(["done", done]) });
    return null;
  }
  try {
    await act(async () => root.render(React.createElement(Probe)));
    await act(async () => agent.start(() => ({ projectId: "test", blocks: [], instruction: "Style document" })));
    expect(order.map(e => e[0])).toEqual(["edit", "done"]);
    expect(order[0][1]).toEqual([edit]);
  } finally {
    await act(async () => root.unmount());
    fetchMock.mockRestore();
  }
});

async function runImageResponse(body, headers) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const events = [];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
    'event: token\ndata: {"text":"I cannot see an image"}\n\nevent: done\ndata: {"ok":true}\n\n',
    { headers: { "content-type": "text/event-stream", ...headers } }
  ));
  const root = createRoot(document.createElement("div"));
  let agent;
  function Probe() {
    agent = useLabsAgent({
      onImageReceipt: data => events.push(["receipt", data]),
      onToken: data => events.push(["token", data]),
      onDone: data => events.push(["done", data]),
      onError: data => events.push(["error", data]),
      onAbort: () => events.push(["abort"])
    });
    return null;
  }
  try {
    await act(async () => root.render(React.createElement(Probe)));
    await act(async () => agent.start(() => body));
    return events;
  } finally {
    await act(async () => root.unmount());
    fetchMock.mockRestore();
  }
}

it("rejects an old server that silently ignores current image attachments", async () => {
  const events = await runImageResponse({ images: [{ data: "test" }], messages: [] }, {});
  expect(events.map(e => e[0])).toEqual(["error"]);
  expect(events[0][1].code).toBe("image_delivery");
  expect(events[0][1].message).toContain("Restart the Vector server");
  expect(events[0][1].recoverable).toBe(true);
});

it("also verifies attachments resent in follow-up history", async () => {
  const events = await runImageResponse({ images: [], messages: [{ role: "user", images: [{ data: "test" }] }] }, {});
  expect(events.map(e => e[0])).toEqual(["error"]);
});

it("accepts multimodal responses only after the exact image count is confirmed", async () => {
  const body = { images: [{ data: "new" }], messages: [{ role: "user", images: [{ data: "old" }] }] };
  const accepted = await runImageResponse(body, { "X-Labs-Image-Count": "2" });
  expect(accepted.map(e => e[0])).toEqual(["receipt", "token", "done"]);
  expect(accepted[0][1]).toEqual({ count: 2 });
  const partial = await runImageResponse(body, { "X-Labs-Image-Count": "1" });
  expect(partial.map(e => e[0])).toEqual(["error"]);
  expect(partial[0][1].message).toContain("did not accept all image attachments");
});

it("leaves text-only requests compatible with servers without an image receipt", async () => {
  const events = await runImageResponse({ images: [], messages: [] }, {});
  expect(events.map(e => e[0])).toEqual(["token", "done"]);
});
