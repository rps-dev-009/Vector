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
    } finally {
      require.cache[routePath] = savedRoute;
      require.cache[enginePath] = savedEngine;
    }
    console.log("\n4 Labs model tests passed (mocked Google responses, no .env reads or external calls).");
  } finally {
    global.fetch = savedFetch;
    process.env = savedEnv;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
