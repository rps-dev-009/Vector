const { setTimeout: wait } = require("node:timers/promises");
const { googleFailure } = require("./googleErrors");

// Retry only the failed HTTP step, never restart an agent that has applied edits.
function createGoogleFetch({ modelId, onRetry, signal }, fetchImpl = fetch, delay = wait) {
  let rateRetries = 0;
  return async (url, options) => {
    const response = await fetchImpl(url, options);
    if (response.status !== 429 || rateRetries >= 2) return response;
    const raw = await response.clone().text().catch(() => "");
    const failure = googleFailure({ statusCode: 429, responseBody: raw }, modelId);
    const seconds = failure.retryAfterSeconds;
    if (failure.code !== "rate_limit" || !seconds || seconds > 60) return response;
    rateRetries += 1;
    const requestSignal = options?.signal || signal;
    requestSignal?.throwIfAborted();
    onRetry?.(seconds);
    await response.body?.cancel();
    await delay(seconds * 1000, undefined, { signal: requestSignal });
    requestSignal?.throwIfAborted();
    return fetchImpl(url, options);
  };
}

module.exports = { createGoogleFetch };
