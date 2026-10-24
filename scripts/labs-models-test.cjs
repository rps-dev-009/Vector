const assert = require("node:assert/strict");
const { runLabsAgent } = require("../server/labs/engine");
const { resolveGoogleModel } = require("../server/googleModels");

async function main() {
  const savedFetch = global.fetch;
  const savedEnv = process.env;
  const env = {
    GEMINI_API_KEY: "mock-not-real",
    GEMINI_MODEL_1_ID: "gemini-3.5-flash-lite",
    GEMINI_MODEL_2_ID: "gemma-4-31b-it",
    LABS_LLM_MODEL: "gemini-3.5-flash-lite"
  };
  process.env = env;
  try {
    for (const [modelId, level] of [["gemma-4-31b-it", "high"], ["gemma-4-31b-it", "minimal"], ["gemini-3.5-flash-lite", "medium"]]) {
      const requests = [];
      global.fetch = async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        const part = requests.length === 1
          ? { functionCall: { name: "replace_block", args: { blockId: "b1", text: "Updated by the selected model" } } }
          : { text: "Document updated." };
        const data = {
          candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
        };
        return new Response(`data: ${JSON.stringify(data)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
      };
      const frames = [];
      const doc = [{ id: "b1", type: "paragraph", text: "Original document", attrs: {} }];
      await runLabsAgent({
        res: { writableEnded: false, write: frame => frames.push(frame) },
        model: resolveGoogleModel(env, modelId, level, "labs").model,
        doc,
        instruction: "Update the document",
        history: [{ role: "user", content: "Keep my project context" }, { role: "assistant", content: "Noted" }],
        selection: null,
        projectId: "same-project",
        signal: new AbortController().signal
      });
      assert.equal(requests.length, 2, "native tool loop should execute then summarize");
      for (const request of requests) {
        assert.ok(request.url.includes(modelId));
        assert.deepEqual(request.body.generationConfig.thinkingConfig, { thinkingLevel: level });
        assert.ok(request.body.tools[0].functionDeclarations.some(tool => tool.name === "replace_block"));
        assert.ok(JSON.stringify(request.body.contents).includes("Keep my project context"));
      }
      assert.equal(doc[0].text, "Updated by the selected model");
      const stream = frames.join("");
      assert.ok(stream.includes("event: edit"));
      assert.ok(stream.includes("event: token"));
      assert.ok(stream.includes('"ok":true'));
      assert.ok(!stream.includes("event: error"));
      console.log(`PASS: Labs ${modelId} / ${level} preserves history, uses native tools, emits edits`);
    }

    for (const status of [429, 400, 401, 500]) {
      let calls = 0;
      global.fetch = async () => {
        calls += 1;
        if (status === 500 && calls > 1) {
          return new Response('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Recovered"}]},"finishReason":"STOP"}]}\n\n',
            { headers: { "Content-Type": "text/event-stream" } });
        }
        return new Response(JSON.stringify({ error: { code: status, message: "private-provider-message",
          status: status === 429 ? "RESOURCE_EXHAUSTED" : "INTERNAL",
          ...(status === 429 ? { details: [{ violations: [{ quotaValue: "0", quotaId: "PerMinute" }] }] } : {}) } }),
          { status, headers: { "Content-Type": "application/json" } });
      };
      const frames = [];
      await runLabsAgent({ res: { writableEnded: false, write: frame => frames.push(frame) },
        model: resolveGoogleModel(env, "gemma-4-31b-it", "minimal", "labs").model,
        doc: [], instruction: "Say hello", history: [], selection: null, projectId: "failure-test",
        signal: new AbortController().signal });
      const output = frames.join("");
      assert.equal(calls, status === 500 ? 2 : 1);
      assert.ok(!output.includes("private-provider-message"));
      assert.ok(output.includes(status === 500 ? '"ok":true' : '"ok":false'));
      if (status === 429) assert.ok(output.includes('"code":"quota"'));
      console.log(`PASS: Labs handles HTTP ${status} without unsafe output or unnecessary retries`);
    }

    global.fetch = async () => new Response('data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}]}\n\n',
      { headers: { "Content-Type": "text/event-stream" } });
    const emptyFrames = [];
    await runLabsAgent({ res: { writableEnded: false, write: frame => emptyFrames.push(frame) },
      model: resolveGoogleModel(env, "gemma-4-31b-it", "minimal", "labs").model,
      doc: [], instruction: "Say hello", history: [], selection: null, projectId: "empty-test",
      signal: new AbortController().signal });
    assert.ok(emptyFrames.join("").includes('"ok":false'));
    console.log("PASS: empty Labs output is a visible failure, not silent success");

    let stepCalls = 0;
    global.fetch = async () => {
      stepCalls += 1;
      if (stepCalls === 2) return new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED",
        details: [{ retryDelay: "0.01s" }] } }), { status: 429 });
      const part = stepCalls === 1
        ? { functionCall: { name: "replace_block", args: { blockId: "b1", text: "Applied exactly once" } } }
        : { text: "Finished after waiting" };
      return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP" }] })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } });
    };
    const rateFrames = [];
    await runLabsAgent({ res: { writableEnded: false, write: frame => rateFrames.push(frame) },
      model: resolveGoogleModel(env, "gemma-4-31b-it", "minimal", "labs").model,
      doc: [{ id: "b1", type: "paragraph", text: "Original", attrs: {} }], instruction: "Replace b1", history: [],
      selection: null, projectId: "rate-after-edit-test", signal: new AbortController().signal });
    assert.equal(stepCalls, 3);
    assert.equal(rateFrames.filter(frame => frame === "event: edit\n").length, 1);
    assert.ok(rateFrames.join("").includes('"ok":true'));
    console.log("PASS: short rate limit after an edit retries only the summary step, never the edit");

    const routePath = require.resolve("../server/labs/route");
    const enginePath = require.resolve("../server/labs/engine");
    const savedRoute = require.cache[routePath];
    const savedEngine = require.cache[enginePath];
    let forwarded;
    try {
      require.cache[enginePath] = { ...savedEngine, exports: { ...savedEngine.exports, runLabsAgent: async body => { forwarded = body; } } };
      delete require.cache[routePath];
      let handler;
      require("../server/labs/route").registerLabsAgentRoute({ post: (path, run) => { handler = run; } });
      async function invoke(overrides) {
        const req = { body: { projectId: "project", blocks: [], instruction: "Write a brief", ...overrides }, on() {} };
        const res = { statusCode: 200, writableEnded: false, status(code) { this.statusCode = code; return this; },
          json(body) { this.body = body; }, writeHead() {}, write() {}, on() {}, end() { this.writableEnded = true; } };
        await handler(req, res);
        return res;
      }
      assert.equal((await invoke({ modelId: "gemma-4-31b-it", thinkingLevel: "medium" })).statusCode, 400);
      assert.equal((await invoke({ modelId: "gemini-not-configured" })).statusCode, 400);
      assert.equal(forwarded, undefined);
      assert.equal((await invoke({ modelId: "gemma-4-31b-it", thinkingLevel: "minimal" })).statusCode, 200);
      assert.equal(forwarded.model.modelId, "gemma-4-31b-it");
      assert.equal(forwarded.model.thinkingLevel, "minimal");
      console.log("PASS: Labs route validates model/level before SSE and forwards selection");
      const previous = forwarded;
      assert.equal((await invoke({ continuation: { targetWords: { min: 200, max: 100, source: "words" } } })).statusCode, 400);
      assert.equal(forwarded, previous, "invalid continuation must never start the engine");
      const continuation = { targetWords: null, failedOperations: [{ tool: "insert_block", blockId: "s1", message: "Invalid height", code: "tool_error" }] };
      const instruction = "dont wrie anything i want blank spaces wherever we can add diagrams";
      const selection = { blockIds: ["s1"], text: "" };
      assert.equal((await invoke({ instruction, continuation, selection,
        blocks: [{ id: "s1", type: "spacer", text: "", attrs: { heightPt: 144 } }] })).statusCode, 200);
      assert.equal(forwarded.instruction, instruction);
      assert.deepEqual(forwarded.continuation, continuation);
      assert.deepEqual(forwarded.selection, selection);
      assert.equal(forwarded.doc[0].type, "spacer");
      console.log("PASS: Labs route validates and forwards scoped continuation with empty spacer selections");
    } finally {
      require.cache[routePath] = savedRoute;
      require.cache[enginePath] = savedEngine;
    }
    console.log("\n11 Labs model tests passed (mocked Google responses, no .env reads or external calls).");
  } finally {
    global.fetch = savedFetch;
    process.env = savedEnv;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
