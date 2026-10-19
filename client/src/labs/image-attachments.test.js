import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import AssistantPane from "./AssistantPane.jsx";
import { IMAGE_LIMITS, validateImageFile, imageForRequest, imageMetadata, imageHistory, rememberImages, prepareImage } from "./imageAttachments.js";

const image = id => ({ id, name: `${id}.png`, mediaType: "image/png", data: "aGVsbG8=", preview: "data:image/png;base64,aGVsbG8=", bytes: 5, width: 20, height: 10 });
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollTo ||= () => {};
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe("image attachment preparation", () => {
  it("accepts JPEG, PNG and WebP but rejects unsupported or oversized inputs", () => {
    for (const type of IMAGE_LIMITS.mediaTypes) expect(() => validateImageFile({ type, size: 100 })).not.toThrow();
    for (const type of ["image/svg+xml", "image/gif", "image/heic", "text/plain", ""]) expect(() => validateImageFile({ type, size: 100 })).toThrow("PNG");
    expect(() => validateImageFile({ type: "image/png", size: 0 })).toThrow("empty");
    expect(() => validateImageFile({ type: "image/png", size: IMAGE_LIMITS.maxSourceBytes + 1 })).toThrow("10 MB");
  });

  it("keeps persisted metadata separate from request bytes and preview data", () => {
    expect(imageMetadata(image("a"))).toEqual({ id: "a", name: "a.png" });
    expect(imageForRequest(image("a"))).toEqual({ id: "a", name: "a.png", mediaType: "image/png", data: "aGVsbG8=" });
    expect(JSON.stringify(imageMetadata(image("a")))).not.toContain("base64");
  });

  it("resizes before encoding and removes source metadata instead of sending the original", async () => {
    vi.stubGlobal("Image", class {
      naturalWidth = 4096; naturalHeight = 2048;
      set src(value) { if (value) queueMicrotask(() => this.onload()); }
    });
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ fillStyle: "", fillRect: vi.fn(), drawImage });
    let encodedWidth;
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function(callback, type) {
      encodedWidth = this.width;
      callback(new Blob(["re-encoded content"], { type }));
    });
    const result = await prepareImage(new File(["original metadata"], "photo.jpg", { type: "image/jpeg" }));
    expect(encodedWidth).toBe(2048);
    expect(result.width).toBe(2048);
    expect(result.height).toBe(1024);
    expect(result.mediaType).toBe("image/jpeg");
    expect(atob(result.data)).toBe("re-encoded content");
    expect(drawImage).toHaveBeenCalled();
  });

  it("reports corrupt images before sending a request", async () => {
    vi.stubGlobal("Image", class { set src(value) { if (value) queueMicrotask(() => this.onerror()); } });
    await expect(prepareImage(new File(["not an image"], "bad.png", { type: "image/png" }))).rejects.toThrow("not a readable image");
  });
});

describe("bounded session image context", () => {
  it("retains only the newest four image bodies", () => {
    const cache = rememberImages(new Map(), ["a", "b", "c", "d", "e"].map(image));
    expect([...cache.keys()]).toEqual(["b", "c", "d", "e"]);
  });

  it("resends available earlier images for follow-up questions", () => {
    const cache = rememberImages(new Map(), [image("a")]);
    const messages = imageHistory([{ role: "user", text: "What is this?", images: [imageMetadata(image("a"))] }, { role: "assistant", text: "A diagram." }], cache);
    expect(messages[0].images).toEqual([imageForRequest(image("a"))]);
    expect(messages[1]).toEqual({ role: "assistant", content: "A diagram." });
  });

  it("keeps current images within the shared total count and omits older ones explicitly", () => {
    const cache = rememberImages(new Map(), [image("a"), image("b"), image("c"), image("d")]);
    const chat = [...cache.values()].map(img => ({ role: "user", text: img.id, images: [imageMetadata(img)] }));
    const messages = imageHistory(chat, cache, [image("e"), image("f")]);
    expect(messages.flatMap(m => m.images || [])).toHaveLength(2);
    expect(messages[0].content).toContain("not included");
    expect(messages.at(-1).images[0].id).toBe("d");
  });

  it("does not pretend a persisted filename is an available image after reopening", () => {
    const messages = imageHistory([{ role: "user", text: "Inspect this", images: [{ id: "gone", name: "diagram.png" }] }], new Map());
    expect(messages[0].images).toBeUndefined();
    expect(messages[0].content).toContain("ask for reattachment");
  });

  it("does not duplicate an image reattached after a failed send", () => {
    const img = image("a");
    const messages = imageHistory([{ role: "user", text: "Inspect", images: [imageMetadata(img)] }], new Map([[img.id, img]]), [img]);
    expect(messages[0].images).toBeUndefined();
  });
});

describe("attachment composer", () => {
  it("supports picking, pasting, removing and image-only sending", async () => {
    const onAddImages = vi.fn(), onRemoveImage = vi.fn(), onSend = vi.fn();
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(React.createElement(AssistantPane, {
        chat: [], run: { status: "idle" }, instruction: "", setInstruction: vi.fn(),
        attachments: [image("a")], onAddImages, onRemoveImage, onSend
      })));
      expect(host.querySelector('button[aria-label="Attach images"]')).toBeTruthy();
      expect(host.querySelector('input[type="file"]').accept).toBe("image/png,image/jpeg,image/webp");
      expect(host.querySelector('button[title="Send (Enter)"]').disabled).toBe(false);
      await act(async () => host.querySelector('button[title="Send (Enter)"]').click());
      expect(onSend).toHaveBeenCalledOnce();
      await act(async () => host.querySelector('button[aria-label="Remove a.png"]').click());
      expect(onRemoveImage).toHaveBeenCalledWith("a");
      const file = new File(["image"], "pasted.png", { type: "image/png" });
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", { value: { items: [{ kind: "file", getAsFile: () => file }] } });
      await act(async () => host.querySelector("textarea").dispatchEvent(paste));
      expect(onAddImages).toHaveBeenCalledWith([file]);
      expect(paste.defaultPrevented).toBe(true);
    } finally { await act(async () => root.unmount()); }
  });

  it("disables sending while images are being prepared and explains expired images", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(React.createElement(AssistantPane, {
        chat: [{ id: "message", role: "user", text: "Inspect", images: [{ id: "gone", name: "diagram.png" }] }],
        run: { status: "idle" }, instruction: "Inspect", setInstruction: vi.fn(), imagesPreparing: true
      })));
      expect(host.querySelector('button[title="Send (Enter)"]').disabled).toBe(true);
      expect(host.textContent).toContain("Preparing images");
      expect(host.textContent).toContain("Reattach to inspect again");
    } finally { await act(async () => root.unmount()); }
  });
});
