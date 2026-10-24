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

const REQUEST_TIMEOUT_MS = 180000;

function errorForHttpStatus(status, json) {
  let fallback;
  if (status === 503) {
    fallback = { code: "auth", message: "AI is not configured.", recoverable: false };
  } else if (status === 413) {
    fallback = { code: "too_large", message: "The document is too large for the AI to edit.", recoverable: false };
  } else if (status === 429) {
    fallback = { code: "rate_limit", message: "Too many requests. Please try again shortly.", retryAfterSeconds: null, recoverable: true };
  } else {
    fallback = { code: "invalid_request", message: `The request was rejected (${status}).`, recoverable: false };
  }
  return {
    ...fallback,
    code: typeof json?.code === "string" && json.code ? json.code : fallback.code,
    message: typeof json?.message === "string" && json.message ? json.message
      : typeof json?.error === "string" && json.error ? json.error : fallback.message,
    recoverable: typeof json?.recoverable === "boolean" ? json.recoverable : fallback.recoverable,
    retryAfterSeconds: Number.isFinite(json?.retryAfterSeconds) ? json.retryAfterSeconds : fallback.retryAfterSeconds
  };
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
    let terminal = false;
    let timedOut = false;
    let timeout;
    let reader;
    let hasReceivedData = false;
    let hasReasoningActivity = false;
    const editQueue = [];
    const flushEdits = () => {
      if (editQueue.length) h.onEditBatch?.(editQueue.splice(0));
    };
    const finish = (kind, data) => {
      if (terminal) return;
      terminal = true;
      clearTimeout(timeout);
      flushEdits();
      if (kind === "done") h.onDone?.(data);
      else if (kind === "abort") h.onAbort?.();
      else h.onError?.(data);
    };
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, REQUEST_TIMEOUT_MS);
    };
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(new DOMException("Request aborted", "AbortError"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    resetTimeout();

    try {
      const body = buildBody();
      const imageCount = (body.images?.length || 0) + (body.messages || []).slice(-10)
        .reduce((count, message) => count + (message.images?.length || 0), 0);
      const response = await Promise.race([fetch("/labs/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      }), aborted]);

      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !contentType.includes("text/event-stream")) {
        const json = await Promise.race([response.json().catch(() => null), aborted]);
        finish("error", errorForHttpStatus(response.status, json));
        return;
      }
      if (!response.body) {
        finish("error", { code: "network", message: "The AI service returned an empty response.", recoverable: true });
        return;
      }

      if (imageCount > 0) {
        const acceptedCount = response.headers.get(IMAGE_LIMITS.receiptHeader);
        if (acceptedCount !== String(imageCount)) {
          response.body.cancel().catch(() => {});
          finish("error", { code: "image_delivery", recoverable: true,
            message: acceptedCount == null
              ? "The running Labs server has not confirmed image support. Restart the Vector server and send the images again. Your attachments have been kept."
              : "The Labs server did not accept all image attachments. Your images have been kept; retry after restarting the server." });
          return;
        }
        h.onImageReceipt?.({ count: imageCount });
      }

      const parser = createParser((event) => {
        if (event.type !== "event" || terminal || controller.signal.aborted) return;
        let data = event.data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return; // ignore malformed frames
        }
        if (!data || typeof data !== "object") return;
        switch (event.event) {
          case "activity":
            if (data.state === "reasoning" && !hasReasoningActivity) {
              hasReasoningActivity = true;
              resetTimeout();
            }
            h.onActivity?.(data);
            break;
          case "token":
            if (typeof data.text === "string" && data.text) {
              hasReceivedData = true;
              resetTimeout();
            }
            h.onToken?.(data);
            break;
          case "edit":
            hasReceivedData = true;
            resetTimeout();
            editQueue.push(data);
            break;
          case "error":
            finish("error", data);
            break;
          case "done":
            // The final edits may share this chunk with done. Capture their
            // before-state while review is still active, before finalizing.
            finish("done", data);
            break;
          default:
            break;
        }
      });

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (!terminal) {
        const { value, done } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
        // Edits that arrived in this network chunk apply as one transaction.
        flushEdits();
      }
      if (!terminal) {
        finish("error", { code: "network", recoverable: true,
          message: hasReceivedData
            ? "The AI response was interrupted before completion. Changes already applied have been kept."
            : "The AI service returned an empty response." });
      }
    } catch (err) {
      if (timedOut) {
        finish("error", { code: "timeout", message: "The AI request timed out. Changes already applied have been kept. Please try again.", recoverable: true });
      } else if (err?.name === "AbortError" || controller.signal.aborted) {
        finish("abort");
      } else {
        console.error("[Labs] agent request failed:", err?.message || err);
        finish("error", { code: "network", message: "Could not reach the AI service.", recoverable: true });
      }
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", onAbort);
      reader?.cancel().catch(() => {});
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setIsRunning(false);
      }
    }
  }, []);

  const stop = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  useEffect(() => () => controllerRef.current?.abort(), []);

  return { isRunning, start, stop };
}
