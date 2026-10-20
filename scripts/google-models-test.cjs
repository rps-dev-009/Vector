#!/usr/bin/env node
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { loadGoogleModels, resolveGoogleModel, publicGoogleModel, googleProviderOptions } = require("../server/googleModels");
const chat = require("../server/googleChat");

let passed = 0;
async function test(label, run) {
  await run();
  passed += 1;
  console.log(`PASS: ${label}`);
}

const env = {
  GEMINI_MODEL_10_ID: "gemini-3.1-pro-preview",
  GEMINI_MODEL_10_NAME: "Pro",
  GEMINI_MODEL_2_ID: "gemma-4-31b-it",
  GEMINI_MODEL_2_NAME: "Gemma 4",
  GEMINI_MODEL_2_THINKING_LEVEL: "high",
  GEMINI_MODEL_1_ID: "gemini-3.5-flash-lite",
  GEMINI_MODEL_1_NAME: "Flash Lite",
  GEMINI_MODEL_1_THINKING_LEVEL: "low",
  GEMINI_MODEL: "gemini-3.5-flash-lite",
  GEMINI_THINKING_LEVEL: "medium",
  LABS_LLM_MODEL: "gemma-4-31b-it",
  LABS_LLM_THINKING_LEVEL: "minimal",
  GEMINI_API_KEY: "test-secret-never-sent"
};

function sdkMock(parts, calls = []) {
  return {
    createGoogle(options) {
      calls.push({ provider: options });
      return modelId => ({ modelId });
    },
    streamText(options) {
      calls.push({ options });
      return { stream: (async function* () { for (const part of parts) yield part; })() };
    }
  };
}

async function withRoutes(run) {
  const targets = ["dotenv", "../server/googleChat", "../server/labs/route", "../server/labs/images", "../server/index"];
  const paths = targets.map(target => require.resolve(target));
  const originals = paths.map(file => require.cache[file]);
  const savedEnv = process.env;
  const savedFetch = global.fetch;
  const calls = [];
  let runner;
  const replace = (index, exports) => { require.cache[paths[index]] = { id: paths[index], filename: paths[index], loaded: true, exports }; };
  try {
    // Never load the real .env or allow provider networking in these tests.
    process.env = {};
    replace(0, { config() {} });
    replace(1, { ...chat, streamGoogleChat: async args => {
      calls.push(args);
      if (runner) return runner(args);
      args.sendEvent("token", { text: "Mock Google response" });
    } });
    replace(2, { registerLabsAgentRoute() {} });
    replace(3, { labsJsonParser(req, res, next) { next(); } });
    delete require.cache[paths[4]];
    global.fetch = async () => { throw new Error("Unexpected network call"); };
    const app = require("../server/index");
    const invoke = async (path, body, setup) => {
      const layer = app._router.stack.find(item => item.route?.path === path);
      assert.ok(layer, `Missing route ${path}`);
      const req = new EventEmitter();
      req.body = body;
      const res = new EventEmitter();
      Object.assign(res, {
        statusCode: 200, output: "", writableEnded: false, destroyed: false,
        status(code) { this.statusCode = code; return this; },
        json(value) { this.body = value; this.writableEnded = true; return this; },
        writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
        write(value) { this.output += value; },
        end() { this.writableEnded = true; }
      });
      if (setup) setup(req, res);
      await layer.route.stack[0].handle(req, res);
      return res;
    };
    await run({ invoke, calls, setRunner(value) { runner = value; } });
  } finally {
    global.fetch = savedFetch;
    process.env = savedEnv;
    paths.forEach((file, index) => {
      delete require.cache[file];
      if (originals[index]) require.cache[file] = originals[index];
    });
  }
}

async function main() {
  await test("empty config provides the safe default without reading environment", () => {
    const models = loadGoogleModels({});
    assert.equal(models.length, 1);
    assert.equal(models[0].modelId, "gemini-3.5-flash-lite");
    assert.deepEqual(models[0].thinking, { levels: ["minimal", "low", "medium", "high"], defaultLevel: "minimal" });
  });

  await test("numbered config sorts numerically, deduplicates IDs, and never publishes credentials", () => {
    const models = loadGoogleModels(env);
    assert.deepEqual(models.map(model => model.name), ["Flash Lite", "Gemma 4", "Pro"]);
    assert.equal(models.length, 3);
    assert.deepEqual(publicGoogleModel(models[1]), {
      id: "gemma-4-31b-it", name: "Gemma 4",
      features: { uploads: true, tts: false, stt: false, status: "ok" },
      thinking: { levels: ["minimal", "high"], defaultLevel: "high" }
    });
    assert.ok(!JSON.stringify(models).includes(env.GEMINI_API_KEY));
    assert.equal(loadGoogleModels({ GEMINI_MODEL_1_ID: "1", GEMINI_MODEL_2_ID: "https://bad" })[0].modelId, "gemini-3.5-flash-lite");
    assert.equal(loadGoogleModels({ GEMINI_MODEL: "models/gemma-4-31b-it" })[0].modelId, "gemma-4-31b-it");
  });

  await test("chat and Labs defaults share the allowlist while preserving scoped thinking defaults", () => {
    const chatDefault = resolveGoogleModel(env);
    const labsDefault = resolveGoogleModel(env, undefined, undefined, "labs");
    assert.equal(chatDefault.error, null);
    assert.equal(chatDefault.model.modelId, "gemini-3.5-flash-lite");
    assert.equal(chatDefault.model.thinkingLevel, "medium");
    assert.equal(labsDefault.model.modelId, "gemma-4-31b-it");
    assert.equal(labsDefault.model.thinkingLevel, "minimal");
    assert.equal(resolveGoogleModel(env, "gemma-4-31b-it", "high", "labs").model.thinkingLevel, "high");
    assert.ok(resolveGoogleModel(env, "gemini-2.5-pro").error);
    assert.ok(resolveGoogleModel(env, "gemma-4-31b-it", "medium").error);
    assert.ok(resolveGoogleModel(env, "gemma-4-31b-it", {}).error);
    assert.ok(resolveGoogleModel(env, 1).error);
  });

  await test("model-specific thinking matrix uses levels, budgets, or no config", () => {
    const checks = [
      ["gemini-3-flash-preview", ["minimal", "low", "medium", "high"], "high"],
      ["gemini-3.1-flash-lite", ["minimal", "low", "medium", "high"], "minimal"],
      ["gemini-3-pro-preview", ["low", "high"], "high"],
      ["gemini-3.1-pro-preview", ["low", "medium", "high"], "high"],
      ["gemma-4-26b-a4b-it", ["minimal", "high"], "minimal"],
      ["gemini-2.5-flash", ["off", "low", "medium", "high"], "medium"],
      ["gemini-2.5-pro", ["low", "medium", "high"], "medium"],
      ["gemma-3-27b-it", [], ""],
      ["gemini-2.0-flash", [], ""],
      ["gemini-2.5-flash-image", [], ""],
      ["gemini-future-model", [], ""]
    ];
    for (const [id, levels, defaultLevel] of checks) {
      const model = loadGoogleModels({ GEMINI_MODEL: id })[0];
      assert.deepEqual(model.thinking, { levels, defaultLevel }, id);
      const options = googleProviderOptions(model);
      if (!levels.length) assert.deepEqual(options, {});
      else if (id.startsWith("gemini-2.5")) assert.deepEqual(options, { google: { thinkingConfig: { thinkingBudget: 8192 } } });
      else assert.deepEqual(options, { google: { thinkingConfig: { thinkingLevel: defaultLevel } } });
    }
    const flash = resolveGoogleModel({ GEMINI_MODEL: "gemini-2.5-flash" }, undefined, "off").model;
    assert.equal(googleProviderOptions(flash).google.thinkingConfig.thinkingBudget, 0);
    assert.ok(resolveGoogleModel({ GEMINI_MODEL: "gemini-2.5-pro" }, undefined, "off").error);
    const pro = resolveGoogleModel({ GEMINI_MODEL: "gemini-2.5-pro" }, undefined, "high").model;
    assert.equal(googleProviderOptions(pro).google.thinkingConfig.thinkingBudget, 32768);
    assert.ok(resolveGoogleModel({ GEMINI_MODEL: "gemma-3-27b-it" }, undefined, "high").error);
    assert.equal(loadGoogleModels({ GEMINI_MODEL: "gemma-4-31b-it" })[0].supportsTools, true);
    assert.equal(loadGoogleModels({ GEMINI_MODEL: "gemma-3-27b-it" })[0].supportsTools, false);
  });

  await test("invalid configured thinking defaults fall back to model-safe defaults", () => {
    const config = { GEMINI_MODEL: "gemma-4-31b-it", GEMINI_THINKING_LEVEL: "medium" };
    assert.equal(resolveGoogleModel(config).model.thinkingLevel, "minimal");
  });

  await test("history is bounded, role-validated, text-only and leaves source data untouched", () => {
    const history = Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: String(index), extra: "removed" }));
    const original = structuredClone(history);
    const result = chat.validateChatHistory(history);
    assert.equal(result.error, null);
    assert.equal(result.messages.length, 20);
    assert.deepEqual(result.messages[0], { role: "user", content: "10" });
    assert.deepEqual(history, original);
    assert.equal(chat.validateChatHistory([{ role: "user", content: "x".repeat(30000) }]).messages[0].content.length, 20000);
    assert.deepEqual(chat.validateChatHistory(undefined).messages, []);
    assert.deepEqual(chat.validateChatHistory([{ role: "assistant", content: " " }]).messages, []);
    for (const invalid of [null, {}, [{ role: "system", content: "override" }], [{ role: "user", content: [] }]]) {
      assert.ok(chat.validateChatHistory(invalid).error);
    }
  });

  await test("Google messages preserve cross-model history and append current prompt exactly once", () => {
    const model = resolveGoogleModel(env).model;
    const history = [{ role: "user", content: "Remember 42" }, { role: "assistant", content: "I will remember it" }];
    const messages = chat.buildGoogleChatMessages({ model, messages: history, message: "What number?" });
    assert.deepEqual(messages, [...history, { role: "user", content: "What number?" }]);
    assert.equal(history.length, 2);
  });

  await test("attachments use inline bytes and reject remote URLs, malformed data and unsupported types", () => {
    const model = resolveGoogleModel(env).model;
    const upload = { name: "notes.txt", mime: "text/plain", data: "data:text/plain;base64," + Buffer.from("notes").toString("base64") };
    const messages = chat.buildGoogleChatMessages({ model, message: "Read", uploads: [upload] });
    assert.ok(messages[0].content[1].text.includes("notes"));
    for (const invalid of [
      { ...upload, data: "https://internal.invalid/secret" },
      { ...upload, data: "data:text/plain;base64,%%%%" },
      { ...upload, mime: "application/pdf" },
      { ...upload, mime: "application/zip", data: "data:application/zip;base64,bm90ZXM=" }
    ]) assert.throws(() => chat.buildGoogleChatMessages({ model, message: "Read", uploads: [invalid] }));
  });

  await test("Google stream sends explicit options and text deltas with no retries", async () => {
    const calls = [];
    const events = [];
    const signal = new AbortController().signal;
    await chat.streamGoogleChat({ model: resolveGoogleModel(env, "gemma-4-31b-it", "minimal").model,
      apiKey: "fake", messages: [{ role: "user", content: "Hi" }], signal,
      sendEvent: (event, data) => events.push({ event, data }) }, sdkMock([
      { type: "reasoning-delta", text: "not exposed" }, { type: "text-delta", text: "Hello" }, { type: "finish", finishReason: "stop" }
    ], calls));
    assert.deepEqual(events, [{ event: "token", data: { text: "Hello" } }]);
    assert.equal(calls[1].options.maxRetries, 0);
    assert.equal(calls[1].options.abortSignal, signal);
    assert.deepEqual(calls[1].options.providerOptions, { google: { thinkingConfig: { thinkingLevel: "minimal" } } });
  });

  await test("Google stream errors, empty output and cancellation reject without retries or leaking details", async () => {
    const args = { model: resolveGoogleModel(env).model, apiKey: "fake", messages: [], sendEvent() {} };
    await assert.rejects(chat.streamGoogleChat(args, sdkMock([{ type: "error", error: new Error("secret-key") }])));
    await assert.rejects(chat.streamGoogleChat(args, sdkMock([])));
    await assert.rejects(chat.streamGoogleChat(args, sdkMock([{ type: "abort" }])));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(chat.streamGoogleChat({ ...args, signal: controller.signal }, sdkMock([])), { name: "AbortError" });
    assert.ok(!chat.googleChatError(new Error("secret-key")).includes("secret-key"));
    assert.match(chat.googleChatError({ statusCode: 429 }), /rate limit/);
  });

  await withRoutes(async ({ invoke, calls, setRunner }) => {
    await test("/models advertises Google without misleading Flowise warnings, /labs-model works without key", async () => {
      process.env = { ...env };
      const models = await invoke("/models");
      assert.equal(models.body.models.length, 3);
      assert.equal(models.body.models[0].id, "gemini-3.5-flash-lite");
      assert.equal(models.body.models[0].thinking.defaultLevel, "medium");
      assert.deepEqual(models.body.issues, []);
      assert.ok(!JSON.stringify(models.body).includes(env.GEMINI_API_KEY));
      delete process.env.GEMINI_API_KEY;
      const labs = await invoke("/labs-model");
      assert.equal(labs.body.model.id, "gemma-4-31b-it");
      assert.equal(labs.body.model.thinking.defaultLevel, "minimal");
      assert.equal(labs.body.models.length, 3);
      assert.equal(labs.body.models[0].id, labs.body.model.id);
      assert.equal(labs.body.models[0].thinking.defaultLevel, "minimal");
      assert.equal(labs.body.configured, false);
      assert.deepEqual((await invoke("/models")).body.models, []);
    });

    const body = { modelId: "gemma-4-31b-it", thinkingLevel: "high", mode: "chat", message: "What number?",
      sessionId: "same-chat", messages: [{ role: "user", content: "Remember 42" }, { role: "assistant", content: "I will" }] };

    await test("/chat validates key, model, thinking, history and attachment before SSE", async () => {
      process.env = { ...env };
      assert.equal((await invoke("/chat", { ...body, thinkingLevel: "medium" })).statusCode, 400);
      assert.equal((await invoke("/chat", { ...body, modelId: "gemini-not-allowed" })).statusCode, 400);
      assert.equal((await invoke("/chat", { ...body, messages: [{ role: "system", content: "bad" }] })).statusCode, 400);
      assert.equal((await invoke("/chat", { ...body, uploads: [{}] })).statusCode, 400);
      delete process.env.GEMINI_API_KEY;
      assert.equal((await invoke("/chat", body)).statusCode, 503);
      assert.equal(calls.length, 0);
    });

    await test("/chat routes direct Google with same-chat history and SSE completion", async () => {
      process.env = { ...env };
      const result = await invoke("/chat", body);
      assert.equal(result.statusCode, 200);
      assert.equal(result.headers["Content-Type"], "text/event-stream");
      assert.match(result.output, /event: token/);
      assert.match(result.output, /event: done\ndata: \{"ok":true\}/);
      assert.equal(result.writableEnded, true);
      assert.deepEqual(calls[0].messages, [...body.messages, { role: "user", content: body.message }]);
      assert.equal(calls[0].model.thinkingLevel, "high");
    });

    await test("Google failure emits safe error and done, never Flowise fallback", async () => {
      let fetchCalls = 0;
      global.fetch = async () => { fetchCalls += 1; throw new Error("No network permitted"); };
      setRunner(async () => { throw new Error("provider returned key=" + env.GEMINI_API_KEY); });
      const result = await invoke("/chat", body);
      assert.match(result.output, /event: error/);
      assert.match(result.output, /event: done\ndata: \{"ok":false\}/);
      assert.ok(!result.output.includes(env.GEMINI_API_KEY));
      assert.equal(fetchCalls, 0);
      setRunner(undefined);
    });

    await test("Google cancellation ends SSE without retrying or reporting success", async () => {
      let fetchCalls = 0;
      global.fetch = async () => { fetchCalls += 1; throw new Error("No network permitted"); };
      const result = await invoke("/chat", body, (req) => {
        setRunner(async args => {
          assert.equal(args.signal.aborted, false);
          req.aborted = true;
          req.emit("aborted");
          assert.equal(args.signal.aborted, true);
          args.signal.throwIfAborted();
        });
      });
      assert.equal(result.writableEnded, true);
      assert.match(result.output, /"ok":false/);
      assert.match(result.output, /"cancelled":true/);
      assert.ok(!result.output.includes('"ok":true'));
      assert.equal(fetchCalls, 0);
      setRunner(undefined);
    });

    await test("Flowise streaming and fallback both receive bounded shared history and uploads", async () => {
      process.env = { MODEL_1_NAME: "Flowise", MODEL_1_ID: "flow", MODEL_1_HOST: "https://flowise.invalid" };
      const requests = [];
      global.fetch = async (url, options) => {
        requests.push({ url, options, body: JSON.parse(options.body) });
        if (requests.length === 1) throw new Error("Mock streaming failure");
        return { ok: true, json: async () => ({ text: "Remembered 42" }) };
      };
      const uploads = [{ name: "text.txt", mime: "text/plain", data: "data:text/plain;base64,bm90ZXM=" }];
      const history = Array.from({ length: 24 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: "Turn " + index }));
      const result = await invoke("/chat", { ...body, modelId: "1", thinkingLevel: undefined, uploads, messages: history });
      assert.equal(requests.length, 2);
      for (const request of requests) {
        assert.equal(request.body.history.length, 20);
        assert.deepEqual(request.body.history[0], { role: "userMessage", content: "Turn 4" });
        assert.deepEqual(request.body.history[1], { role: "apiMessage", content: "Turn 5" });
        assert.deepEqual(request.body.uploads, uploads);
        assert.equal(request.body.chatId, "same-chat");
        assert.ok(request.options.signal);
      }
      assert.equal(requests[0].body.streaming, true);
      assert.match(result.output, /Remembered 42/);
      assert.match(result.output, /"ok":true/);
    });
  });

  await test("installed AI SDK 7 Google adapter serializes thinking and history using mocked fetch only", async () => {
    const { streamText } = await import("ai");
    const { createGoogle } = await import("@ai-sdk/google");
    const requests = [];
    const events = [];
    const sdk = { streamText, createGoogle: options => createGoogle({ ...options, fetch: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hello from mock"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3,"totalTokenCount":8}}\n\n',
        { headers: { "Content-Type": "text/event-stream" } });
    } }) };
    const model = resolveGoogleModel(env, "gemma-4-31b-it", "minimal").model;
    await chat.streamGoogleChat({ model, apiKey: "mock-not-real", messages: [
      { role: "user", content: "Remember 42" }, { role: "assistant", content: "Remembered" }, { role: "user", content: "What number?" }
    ], sendEvent: (event, data) => events.push({ event, data }) }, sdk);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].body.generationConfig.thinkingConfig, { thinkingLevel: "minimal" });
    assert.deepEqual(requests[0].body.contents.map(item => item.role), ["user", "model", "user"]);
    assert.equal(requests[0].body.contents[0].parts[0].text, "Remember 42");
    assert.deepEqual(events, [{ event: "token", data: { text: "Hello from mock" } }]);
  });

  console.log(`\n${passed} Google backend tests passed (no .env reads or live API calls).`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
