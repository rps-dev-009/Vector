/**
 * useLabsAgent — client for POST /labs/agent.
 *
 * - SSE parsed with eventsource-parser (never hand-rolled).
 * - Edit events are buffered per network chunk and flushed as ONE batch so
 *   the applier can apply them in a single transaction.
 * - Non-SSE JSON errors (400/413/503), empty responses and network failures
 *   surface as structured error objects with friendly codes.
 * - stop() aborts the request; edits already applied stay applied.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createParser } from "eventsource-parser";
import { IMAGE_LIMITS } from "../imageAttachments.js";

function errorForHttpStatus(status, json) {
  if (status === 503) {
    return { code: "auth", message: "AI is not configured.", recoverable: false };
  }
  if (status === 413) {
    return { code: "too_large", message: json?.error || "The document is too large for the AI to edit.", recoverable: false };
  }
  if (status === 429) {
    return { code: "rate_limit", message: "The AI is busy right now. Try again in a few seconds.", retryAfterSeconds: null, recoverable: true };
  }
  return { code: "invalid_request", message: json?.error || `The request was rejected (${status}).`, recoverable: false };
}

/**
 * @param {Object} handlers { onActivity, onEditBatch, onToken, onError, onDone, onAbort, onImageReceipt }
 */
export function useLabsAgent(handlers) {
  const [isRunning, setIsRunning] = useState(false);
  const controllerRef = useRef(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const start = useCallback(async (buildBody) => {
    if (controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setIsRunning(true);

    const h = handlersRef.current;
    let aborted = false;
    const editQueue = [];
    const flushEdits = () => {
      if (editQueue.length) h.onEditBatch?.(editQueue.splice(0));
    };

    try {
      const body = buildBody();
      const imageCount = (body.images?.length || 0) + (body.messages || []).slice(-10)
        .reduce((count, message) => count + (message.images?.length || 0), 0);
      const response = await fetch("/labs/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream")) {
        const json = await response.json().catch(() => null);
        h.onError?.(errorForHttpStatus(response.status, json));
        return;
      }
      if (!response.body) {
        h.onError?.({ code: "network", message: "The AI service returned an empty response.", recoverable: true });
        return;
      }

      if (imageCount > 0) {
        const acceptedCount = response.headers.get(IMAGE_LIMITS.receiptHeader);
        if (acceptedCount !== String(imageCount)) {
          await response.body.cancel().catch(() => {});
          h.onError?.({ code: "image_delivery", recoverable: true,
            message: acceptedCount == null
              ? "The running Labs server has not confirmed image support. Restart the Vector server and send the images again. Your attachments have been kept."
              : "The Labs server did not accept all image attachments. Your images have been kept; retry after restarting the server." });
          return;
        }
        h.onImageReceipt?.({ count: imageCount });
      }

      const parser = createParser((event) => {
        if (event.type !== "event") return;
        let data = event.data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return; // ignore malformed frames
        }
        switch (event.event) {
          case "activity":
            h.onActivity?.(data);
            break;
          case "token":
            h.onToken?.(data);
            break;
          case "edit":
            editQueue.push(data);
            break;
          case "error":
            flushEdits();
            h.onError?.(data);
            break;
          case "done":
            // The final edits may share this chunk with done. Capture their
            // before-state while review is still active, before finalizing.
            flushEdits();
            h.onDone?.(data);
            break;
          default:
            break;
        }
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
        // Edits that arrived in this network chunk apply as one transaction.
        if (editQueue.length > 0) {
          const batch = editQueue.splice(0, editQueue.length);
          h.onEditBatch?.(batch);
        }
      }
      if (editQueue.length > 0) {
        h.onEditBatch?.(editQueue.splice(0, editQueue.length));
      }
    } catch (err) {
      if (err?.name === "AbortError" || controller.signal.aborted) {
        aborted = true;
      } else {
        console.error("[Labs] agent request failed:", err?.message || err);
        h.onError?.({ code: "network", message: "Could not reach the AI service.", recoverable: true });
      }
    } finally {
      controllerRef.current = null;
      setIsRunning(false);
      if (aborted) h.onAbort?.();
    }
  }, []);

  const stop = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  useEffect(() => () => controllerRef.current?.abort(), []);

  return { isRunning, start, stop };
}
