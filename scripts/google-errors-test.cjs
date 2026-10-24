const assert = require("node:assert/strict");
const { googleFailure, googleErrorPayload } = require("../server/googleErrors");
const { streamGoogleChat } = require("../server/googleChat");
const { resolveGoogleModel } = require("../server/googleModels");
const { createGoogleFetch } = require("../server/googleTransport");

const modelId = "gemma-4-31b-it";
const model = resolveGoogleModel({ GEMINI_MODEL: modelId }).model;
function failure(status, details = []) {
  return { statusCode: status, message: "secret-provider-message",
    responseBody: JSON.stringify({ error: { status: status === 429 ? "RESOURCE_EXHAUSTED" : "INTERNAL", details } }) };
}

async function main() {
  const rate = googleFailure(failure(429, [{ retryDelay: "12.4s" }]), modelId);
  assert.equal(rate.code, "rate_limit");
  assert.equal(rate.retryAfterSeconds, 13);
  assert.equal(rate.retryable, false);
  const quota = googleErrorPayload(failure(429, [{ violations: [{ quotaValue: "0", quotaId: "PerMinute" }] }]), modelId);
  assert.equal(quota.code, "quota");
  assert.equal(quota.recoverable, false);
  assert.match(quota.message, /no available quota/);
  assert.equal(googleFailure(failure(429, [{ violations: [{ quotaId: "GenerateRequestsPerDay", quotaValue: "500" }] }]), modelId).code, "quota");
  assert.equal(googleFailure({ lastError: failure(503) }, modelId).retryable, true);
  assert.equal(googleFailure({ cause: failure(401) }, modelId).code, "auth");
  assert.equal(googleFailure(new DOMException("timeout", "TimeoutError"), modelId).code, "timeout");
  for (const status of [400, 401, 403, 404, 429, 500, 502, 503, 504]) {
    assert.ok(!JSON.stringify(googleErrorPayload(failure(status), modelId)).includes("secret-provider-message"));
  }
  console.log("PASS: quota, rate limits, nested failures and timeouts classified without secret leakage");

  for (const [status, expectedCalls] of [[500, 2], [503, 2], [429, 1], [400, 1], [401, 1]]) {
    let calls = 0;
    const events = [];
    const sdk = {
      createGoogle: () => () => ({}),
      streamText(options) {
        calls += 1;
        assert.equal(options.maxRetries, 0);
        assert.equal(options.timeout.firstChunkMs, 120000);
        const parts = calls === 1 ? [{ type: "error", error: failure(status) }] : [{ type: "text-delta", text: "OK" }];
        return { stream: (async function* () { yield* parts; })() };
      }
    };
    const promise = streamGoogleChat({ model, apiKey: "mock", messages: [], sendEvent: (event, data) => events.push({ event, data }) }, sdk);
    if (expectedCalls === 2) await promise;
    else await assert.rejects(promise);
    assert.equal(calls, expectedCalls);
    if (expectedCalls === 2) assert.equal(events[0].data.state, "retrying");
  }
  console.log("PASS: chat retries transient errors once, never quotas/auth/configuration failures");

  let calls = 0;
  await assert.rejects(streamGoogleChat({ model, apiKey: "mock", messages: [], sendEvent() {} }, {
    createGoogle: () => () => ({}),
    streamText() {
      calls += 1;
      return { stream: (async function* () { yield { type: "text-delta", text: "Partial" }; yield { type: "error", error: failure(500) }; })() };
    }
  }));
  assert.equal(calls, 1);
  console.log("PASS: partial answers are never duplicated by retries");

  let transportCalls = 0;
  const waits = [];
  const options = { method: "POST", body: "unchanged-step", signal: new AbortController().signal };
  const limited = () => new Response(failure(429, [{ retryDelay: "23s" }]).responseBody, { status: 429 });
  const transport = createGoogleFetch({ modelId }, async (url, request) => {
    transportCalls += 1;
    assert.equal(request, options);
    return transportCalls % 2 ? limited() : new Response("OK");
  }, async ms => waits.push(ms));
  assert.equal((await transport("https://google.invalid", options)).status, 200);
  assert.equal((await transport("https://google.invalid", options)).status, 200);
  assert.equal((await transport("https://google.invalid", options)).status, 429);
  assert.deepEqual(waits, [23000, 23000]);
  assert.equal(transportCalls, 5);
  console.log("PASS: short rate limits retry the same HTTP step with a bounded wait budget");

  const noWait = async () => { throw new Error("Quota must not be retried"); };
  const quotaTransport = createGoogleFetch({ modelId }, async () => new Response(
    failure(429, [{ retryDelay: "1s", violations: [{ quotaValue: "0" }] }]).responseBody, { status: 429 }), noWait);
  assert.equal((await quotaTransport("https://google.invalid", options)).status, 429);
  const controller = new AbortController();
  const abortTransport = createGoogleFetch({ modelId, signal: controller.signal }, async () => limited(), async () => controller.abort());
  await assert.rejects(abortTransport("https://google.invalid", {}), { name: "AbortError" });
  console.log("PASS: exhausted quotas and cancellation never trigger transport retries");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
