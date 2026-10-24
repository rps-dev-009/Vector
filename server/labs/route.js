/**
 * POST /labs/agent — Labs v2 agent editor endpoint.
 *
 * Request body:
 *   { projectId, blocks: [{id,type,text,attrs}], instruction,
 *     images?: [{id?, name, mediaType, data}],
 *     messages: [{role, content, images?}], selection: {blockIds, text} | null,
 *     continuation?: {targetWords: {min,max,source}|null, failedOperations: [{tool,blockId?,message,code?}]},
 *     documentStyle?: {preset, fontFamily?, fontSizePt?, lineHeight?, spaceAfterPt?, marginMm?} }
 *
 * Validation failures return a clear JSON error (not a stream).
 * Valid requests get an SSE stream of activity/token/edit/error/done events
 * produced by the agent engine.
 */

const { runLabsAgent, sendEvent } = require("./engine");
const { validateIncomingBlocks, validateDocumentStyle } = require("./blocks");
const { validateImages, IMAGE_SPEC } = require("./images");
const { resolveGoogleModel } = require("../googleModels");
const { z } = require("zod");

const MAX_INSTRUCTION_CHARS = 10000;
const MAX_MESSAGES = 10;
const MAX_MESSAGE_CHARS = 100000;
const MAX_PROJECT_ID_CHARS = 128;
const continuationSchema = z.object({
  targetWords: z.object({
    min: z.number().int().min(0).max(200000),
    max: z.number().int().min(1).max(200000).nullable(),
    source: z.enum(["words", "pages", "default"])
  }).strict().refine(target => target.max === null || target.max >= target.min).nullable().optional(),
  failedOperations: z.array(z.object({
    tool: z.string().min(1).max(40).regex(/^[a-z_]+$/),
    blockId: z.string().min(1).max(128).optional(),
    message: z.string().min(1).max(360),
    code: z.string().min(1).max(40).optional()
  }).strict()).max(8).optional()
}).strict();

function validateContinuation(value) {
  if (value == null) return { ok: true, continuation: null };
  const parsed = continuationSchema.safeParse(value);
  return parsed.success ? { ok: true, continuation: { targetWords: null, failedOperations: [], ...parsed.data } }
    : { ok: false, error: "continuation must contain a valid targetWords range and at most 8 failedOperations with messages up to 360 characters." };
}

function jsonError(res, status, message) {
  return res.status(status).json({ error: message });
}

function validateMessages(messages, imageBudget) {
  if (messages == null) return { ok: true, messages: [] };
  if (!Array.isArray(messages)) {
    return { ok: false, error: "messages must be an array of {role, content} objects." };
  }
  const retained = [];
  // Discard old attachments before validation/counting; only these turns are sent.
  for (const m of messages.slice(-MAX_MESSAGES)) {
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      return { ok: false, error: "Each message must be an object {role, content}." };
    }
    if (m.role !== "user" && m.role !== "assistant") {
      return {
        ok: false,
        error: 'Message role must be "user" or "assistant".'
      };
    }
    if (typeof m.content !== "string" || m.content.length === 0 || m.content.length > MAX_MESSAGE_CHARS) {
      return { ok: false, error: `Message content must be a non-empty string of at most ${MAX_MESSAGE_CHARS} characters.` };
    }
    if (m.role !== "user" && m.images !== undefined) {
      return { ok: false, error: "Only user messages may contain images." };
    }
    const checkedImages = validateImages(m.images, imageBudget);
    if (!checkedImages.ok) return checkedImages;
    imageBudget = checkedImages;
    retained.push({ role: m.role, content: m.content, ...(checkedImages.images.length ? { images: checkedImages.images } : {}) });
  }
  return { ok: true, messages: retained };
}

function validateSelection(selection) {
  if (selection == null) return { ok: true, selection: null };
  if (typeof selection !== "object" || Array.isArray(selection)) {
    return { ok: false, error: "selection must be null or an object {blockIds, text}." };
  }
  if (
    !Array.isArray(selection.blockIds) ||
    selection.blockIds.length === 0 ||
    selection.blockIds.some((id) => typeof id !== "string" || id.trim() === "")
  ) {
    return { ok: false, error: "selection.blockIds must be a non-empty array of block ids." };
  }
  if (typeof selection.text !== "string") {
    return { ok: false, error: "selection.text must be a string (may be empty)." };
  }
  return { ok: true, selection: { blockIds: selection.blockIds, text: selection.text } };
}

function registerLabsAgentRoute(app) {
  app.post("/labs/agent", async (req, res) => {
    const { projectId, blocks, documentStyle, instruction, images, messages, selection, modelId, thinkingLevel, continuation } = req.body || {};

    // ── Validation (JSON errors, no stream) ──
    if (typeof projectId !== "string" || projectId.trim() === "" || projectId.length > MAX_PROJECT_ID_CHARS) {
      return jsonError(res, 400, `projectId is required (non-empty string, max ${MAX_PROJECT_ID_CHARS} chars).`);
    }
    if (typeof instruction !== "string" || instruction.trim() === "" || instruction.length > MAX_INSTRUCTION_CHARS) {
      return jsonError(res, 400, `instruction is required (non-empty string, max ${MAX_INSTRUCTION_CHARS.toLocaleString("en-US")} chars).`);
    }
    const checkedBlocks = validateIncomingBlocks(blocks);
    if (!checkedBlocks.ok) {
      return jsonError(res, checkedBlocks.tooLarge ? 413 : 400, checkedBlocks.error);
    }
    const checkedStyle = validateDocumentStyle(documentStyle);
    if (!checkedStyle.ok) return jsonError(res, 400, checkedStyle.error);
    const checkedImages = validateImages(images);
    if (!checkedImages.ok) return jsonError(res, checkedImages.tooLarge ? 413 : 400, checkedImages.error);
    const checkedMessages = validateMessages(messages, checkedImages);
    if (!checkedMessages.ok) return jsonError(res, checkedMessages.tooLarge ? 413 : 400, checkedMessages.error);
    const checkedSelection = validateSelection(selection);
    if (!checkedSelection.ok) return jsonError(res, 400, checkedSelection.error);
    const checkedContinuation = validateContinuation(continuation);
    if (!checkedContinuation.ok) return jsonError(res, 400, checkedContinuation.error);
    const imageCount = checkedImages.images.length + checkedMessages.messages.reduce((count, m) => count + (m.images?.length || 0), 0);
    const hasImages = imageCount > 0;

    const selected = resolveGoogleModel(process.env, modelId, thinkingLevel, "labs");
    if (selected.error) return jsonError(res, 400, selected.error);
    if (!selected.model.supportsTools) {
      return jsonError(res, 400, "This model does not support Labs document-editing tools. Select a Gemini or Gemma 4 model.");
    }
    if (hasImages && !selected.model.supportsUploads) {
      return jsonError(res, 400, "The selected model does not support image attachments.");
    }

    const apiKey = (process.env.GEMINI_API_KEY || "").trim();
    if (!apiKey) {
      return jsonError(res, 503, "Labs AI is not configured: set GEMINI_API_KEY in the server environment (.env).");
    }

    // ── SSE stream ──
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      // Let the client verify this running server accepted every attachment.
      // Older processes must not silently downgrade vision requests to text.
      [IMAGE_SPEC.receiptHeader]: String(imageCount)
    });

    const controller = new AbortController();
    req.on("aborted", () => controller.abort());
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    sendEvent(res, "activity", { label: hasImages
      ? `Reading document and inspecting ${imageCount} image${imageCount === 1 ? "" : "s"}`
      : "Reading document" });

    try {
      await runLabsAgent({
        res,
        doc: checkedBlocks.blocks,
        documentStyle: checkedStyle.style,
        instruction: instruction.trim(),
        images: checkedImages.images,
        history: checkedMessages.messages,
        selection: checkedSelection.selection,
        continuation: checkedContinuation.continuation,
        projectId,
        model: selected.model,
        signal: controller.signal
      });
    } catch (err) {
      const message = hasImages ? "Labs could not process the attached images. Please try again."
        : String((err && err.message) || err || "Unexpected server error").slice(0, 500);
      // Safety net: the engine handles its own errors, but never hang.
      if (!controller.signal.aborted && !res.writableEnded) {
        sendEvent(res, "error", {
          code: "internal",
          message,
          recoverable: false
        });
        sendEvent(res, "done", {
          ok: false,
          summary: "",
          editCount: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
          steps: 0,
          toolCalls: 0,
          parallelToolCalls: 0,
          newlineNormalized: 0
        });
      }
      console.error(`[Labs Agent] route error: ${message.slice(0, 160)}`);
    } finally {
      if (!res.writableEnded) res.end();
    }
  });
}

module.exports = { registerLabsAgentRoute, validateContinuation };
