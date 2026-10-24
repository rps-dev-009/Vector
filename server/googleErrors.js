// Provider error bodies are inspected only for classification, never echoed.
function googleFailure(error, modelId = "") {
  let source = error;
  for (let depth = 0; depth < 5; depth += 1) {
    const nested = source?.lastError || source?.cause;
    if (!nested || nested === source) break;
    source = nested;
  }
  const status = Number(source?.statusCode || error?.statusCode) || 0;
  const raw = typeof source?.responseBody === "string" ? source.responseBody : "";
  let body;
  try { body = JSON.parse(raw)?.error; } catch {}
  const details = Array.isArray(body?.details) ? body.details : [];
  const description = `${source?.message || ""}\n${raw}`;
  const model = /^(gemini|gemma)[a-z0-9._-]{1,120}$/.test(modelId) ? modelId : "the selected model";
  const violations = details.flatMap(detail => Array.isArray(detail?.violations) ? detail.violations : []);
  if (status === 429 || /RESOURCE_EXHAUSTED/.test(description)) {
    const unavailable = violations.some(item => String(item.quotaValue) === "0");
    const daily = violations.some(item => /perday|daily/i.test(`${item.quotaId || ""} ${item.quotaMetric || ""}`));
    const retry = details.map(detail => String(detail.retryDelay || "").match(/^(\d+(?:\.\d+)?)s$/)).find(Boolean)
      || description.match(/retry in (\d+(?:\.\d+)?)\s*s/i);
    if (unavailable || daily) {
      return { code: "quota", status, retryable: false, recoverable: false,
        message: unavailable
          ? `Google has no available quota for ${model} on this API project. Check model access and quota in Google AI Studio, or select another model.`
          : `The daily Google quota for ${model} is exhausted. Wait for the quota reset, review your quota in Google AI Studio, or select another model.` };
    }
    return { code: "rate_limit", status, retryable: false, recoverable: true,
      retryAfterSeconds: retry ? Math.max(1, Math.ceil(Number(retry[1]))) : null,
      message: `Google rate limit reached for ${model}. ${retry ? `Try again in ${Math.max(1, Math.ceil(Number(retry[1])))} seconds` : "Wait before retrying"}, or select another model.` };
  }
  if (status === 401 || status === 403 || /API_KEY_INVALID|UNAUTHENTICATED|PERMISSION_DENIED/.test(description)) {
    return { code: "auth", status, retryable: false, recoverable: false,
      message: `Google denied access to ${model}. Check the server API key and model access in Google AI Studio.` };
  }
  if (status === 404) return { code: "provider", status, retryable: false, recoverable: false,
    message: `Google could not find ${model} for this API project. Check the configured model ID and availability.` };
  if (status === 400) return { code: "provider", status, retryable: false, recoverable: false,
    message: `Google rejected the request for ${model}. Check its supported thinking level and attachments.` };
  if (source?.name === "TimeoutError" || /timeout|timed out/i.test(description)) {
    return { code: "timeout", status, retryable: false, recoverable: true,
      message: `Google took too long to respond with ${model}. Retry, select minimal thinking for a faster response, or switch models.` };
  }
  const retryable = [500, 502, 503, 504].includes(status);
  return { code: "provider", status, retryable, recoverable: true,
    message: retryable ? `Google's ${model} service is temporarily unavailable (HTTP ${status}). Retry or select another model.`
      : `Google could not complete the response from ${model}. Retry or select another model.` };
}

function googleErrorPayload(error, modelId) {
  const { status, retryable, ...payload } = googleFailure(error, modelId);
  return payload;
}

module.exports = { googleFailure, googleErrorPayload };
