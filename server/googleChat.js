const { googleProviderOptions } = require("./googleModels");

function validateChatHistory(messages) {
  if (messages === undefined) return { messages: [], error: null };
  if (!Array.isArray(messages)) return { messages: [], error: "Invalid conversation history" };
  const history = [];
  for (const item of messages.slice(-20)) {
    if (!item || !["user", "assistant"].includes(item.role) || typeof item.content !== "string") {
      return { messages: [], error: "Invalid conversation history" };
    }
    if (item.content.trim()) history.push({ role: item.role, content: item.content.slice(0, 20000) });
  }
  return { messages: history, error: null };
}

function buildGoogleChatMessages({ model, message, messages = [], uploads = [] }) {
  const content = [{ type: "text", text: message }];
  if (uploads.length > 4) throw new Error("At most 4 attachments are supported");
  let totalBytes = 0;
  for (const upload of uploads) {
    if (!model.supportsUploads) throw new Error("This model does not support attachments");
    const mime = upload.mime.trim().toLowerCase();
    const match = /^data:([^;,]+);base64,([a-z0-9+/]*={0,2})$/i.exec(upload.data);
    if (!match || match[1].toLowerCase() !== mime || !match[2] || match[2].length % 4 !== 0) {
      throw new Error("Attachments must contain valid base64 data, not URLs");
    }
    const data = Buffer.from(match[2], "base64");
    if (data.toString("base64") !== match[2]) throw new Error("Invalid attachment data");
    totalBytes += data.length;
    if (data.length > 1024 * 1024 || totalBytes > 1536 * 1024) throw new Error("Attachments are too large");
    if (["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"].includes(mime)) {
      content.push({ type: "image", image: data, mediaType: mime });
    } else if (["text/plain", "text/csv", "text/markdown"].includes(mime)) {
      content.push({ type: "text", text: `Attachment ${JSON.stringify(upload.name.slice(0, 160))}:\n${data.toString("utf8")}` });
    } else if (mime === "application/pdf" && !model.modelId.startsWith("gemma")) {
      content.push({ type: "file", data, mediaType: mime, filename: upload.name.slice(0, 160) });
    } else {
      throw new Error("Unsupported attachment type for this model");
    }
  }
  return [...messages, { role: "user", content: uploads.length ? content : message }];
}

let sdkPromise;
function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = Promise.all([import("ai"), import("@ai-sdk/google")]).then(([ai, google]) => ({
      streamText: ai.streamText,
      createGoogle: google.createGoogle
    }));
  }
  return sdkPromise;
}

function googleChatError(error) {
  const status = error?.statusCode || error?.cause?.statusCode;
  if (status === 401 || status === 403) return "Google authentication failed. Check the server API key and model access.";
  if (status === 429) return "Google rate limit reached. Please try again later.";
  if (status === 404) return "The configured Google model is unavailable for this API key.";
  if (status === 400) return "Google rejected this request. Check the model, thinking level, and attachments.";
  return "Google could not complete the response. Please try again.";
}

async function streamGoogleChat({ model, apiKey, messages, signal, sendEvent }, sdk) {
  signal?.throwIfAborted();
  const { streamText, createGoogle } = sdk || await loadSdk();
  signal?.throwIfAborted();
  const google = createGoogle({ apiKey });
  const result = streamText({
    model: google(model.modelId),
    messages,
    providerOptions: googleProviderOptions(model),
    abortSignal: signal,
    maxRetries: 0,
    onError() {} // The error stream part is handled below without exposing provider details.
  });
  let sawText = false;
  for await (const part of result.stream) {
    signal?.throwIfAborted();
    if (part.type === "error") throw part.error || new Error("Google stream failed");
    if (part.type === "abort") throw new DOMException("Request cancelled", "AbortError");
    if (part.type === "text-delta" && part.text) {
      sawText = true;
      sendEvent("token", { text: part.text });
    }
    if (part.type === "finish" && ["error", "content-filter"].includes(part.finishReason)) {
      throw new Error("Google did not complete the response");
    }
  }
  signal?.throwIfAborted();
  if (!sawText) throw new Error("Google returned an empty response");
}

module.exports = { validateChatHistory, buildGoogleChatMessages, streamGoogleChat, googleChatError };
