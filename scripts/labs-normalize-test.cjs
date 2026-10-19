#!/usr/bin/env node
/**
 * Unit tests for Labs tool newline normalization
 * (server/labs/tools.js -> normalizeEscapedNewlines and its applications).
 *
 * Run: node scripts/labs-normalize-test.cjs
 * Exits 0 when all checks pass, 1 otherwise.
 */

const assert = require("assert");
const { createLabsTools, normalizeEscapedNewlines } = require("../server/labs/tools");

let passed = 0;
let failed = 0;
function check(cond, label) {
  if (cond) {
    passed += 1;
    console.log(`PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL: ${label}`);
  }
}

function freshHarness(doc) {
  const edits = [];
  const { tools, state } = createLabsTools({
    doc,
    emitEdit: (e) => edits.push(e),
    emitActivity: () => {},
    limits: { maxEdits: 40, maxBlockChars: 20000 }
  });
  return { tools, state, edits };
}

async function main() {
  /* ── Direct helper checks ──────────────────────────────────────────────── */

  check(
    normalizeEscapedNewlines("- one\\n- two\\n- three", "bulletList") === "- one\n- two\n- three",
    "helper converts literal \\n to real newlines"
  );
  check(
    normalizeEscapedNewlines("- one\\r\\n- two", "bulletList") === "- one\n- two",
    "helper converts literal \\r\\n to real newlines"
  );
  check(
    normalizeEscapedNewlines("echo hi\\nexit", "codeBlock") === "echo hi\\nexit",
    "helper never alters codeBlock content"
  );
  check(
    normalizeEscapedNewlines("- one\n- two", "bulletList") === "- one\n- two",
    "helper leaves text with real newlines untouched"
  );
  check(
    normalizeEscapedNewlines("plain paragraph", "paragraph") === "plain paragraph",
    "helper leaves plain text untouched"
  );
  check(
    normalizeEscapedNewlines("mixed \\n and real\nnewline", "paragraph") === "mixed \\n and real\nnewline",
    "helper leaves mixed text (already has real newline) untouched"
  );

  /* ── Tool-level checks ─────────────────────────────────────────────────── */

  // 1. List insert with literal \n gets real newlines.
  {
    const doc = [{ id: "b1", type: "paragraph", text: "Intro.", attrs: {} }];
    const { tools, state, edits } = freshHarness(doc);
    const r = await tools.insert_block.execute({
      afterId: "b1",
      type: "bulletList",
      text: "- one\\n- two\\n- three",
      attrs: {}
    });
    const inserted = doc.find((b) => b.id === r.blockId);
    check(r && r.ok, "list insert with literal \\n succeeds");
    check(
      inserted && inserted.text === "- one\n- two\n- three",
      "list insert stores real newlines"
    );
    check(
      edits[0] && edits[0].after === "- one\n- two\n- three",
      "insert edit event carries normalized text"
    );
    check(state.newlineNormalized === 1, "normalization counter incremented (insert)");
  }

  // 2. A code block containing literal \n is untouched.
  {
    const doc = [{ id: "b1", type: "paragraph", text: "Intro.", attrs: {} }];
    const { tools, state } = freshHarness(doc);
    const r = await tools.insert_block.execute({
      afterId: "b1",
      type: "codeBlock",
      text: "echo hi\\nexit 0",
      attrs: { language: "bash" }
    });
    const inserted = doc.find((b) => b.id === r.blockId);
    check(r && r.ok, "codeBlock insert succeeds");
    check(
      inserted && inserted.text === "echo hi\\nexit 0",
      "codeBlock keeps literal \\n characters untouched"
    );
    check(state.newlineNormalized === 0, "normalization counter NOT incremented (codeBlock)");
  }

  // 3. Text that already has real newlines is untouched.
  {
    const doc = [{ id: "b1", type: "paragraph", text: "Intro.", attrs: {} }];
    const { tools, state } = freshHarness(doc);
    const text = "- one\n- two\n- three";
    const r = await tools.insert_block.execute({ afterId: "b1", type: "bulletList", text, attrs: {} });
    const inserted = doc.find((b) => b.id === r.blockId);
    check(r && r.ok, "list insert with real newlines succeeds");
    check(inserted && inserted.text === text, "text with real newlines stored unchanged");
    check(state.newlineNormalized === 0, "normalization counter NOT incremented (real newlines)");
  }

  // 4. replace_in_block: find with literal \n rescued via normalization.
  {
    const doc = [{ id: "b1", type: "bulletList", text: "- alpha\n- beta\n- gamma", attrs: {} }];
    const { tools, state } = freshHarness(doc);
    const r = await tools.replace_block.execute({ blockId: "b1", text: "- keep\n- me", attrs: {} });
    assert(r.ok);
    const r2 = await tools.replace_in_block.execute({
      blockId: "b1",
      find: "- keep\\n- me", // model sent literal \n
      replace: "- kept\\n- me"
    });
    check(r2 && r2.ok, "replace_in_block rescues find via normalization");
    check(doc[0].text === "- kept\n- me", "replace_in_block applied the normalized edit");
    check(state.newlineNormalized === 2, "counter counts find-rescue and replace normalization");
  }

  // 5. replace_block with literal \n on a list block normalizes.
  {
    const doc = [{ id: "b1", type: "orderedList", text: "1. old", attrs: {} }];
    const { tools, state } = freshHarness(doc);
    const r = await tools.replace_block.execute({ blockId: "b1", text: "1. a\\n2. b", attrs: {} });
    check(r && r.ok && doc[0].text === "1. a\n2. b", "replace_block normalizes literal \\n in lists");
    check(state.newlineNormalized === 1, "counter incremented (replace_block)");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test harness crashed:", err);
  process.exit(2);
});
