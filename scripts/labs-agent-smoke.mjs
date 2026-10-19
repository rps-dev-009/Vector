#!/usr/bin/env node
/**
 * Labs agent smoke harness (Phase 1).
 *
 * POSTs scenarios to a running server's POST /labs/agent endpoint, prints the
 * event stream, applies edit events to a local copy of the document, and
 * asserts simple expectations.
 *
 * Usage:
 *   node scripts/labs-agent-smoke.mjs
 *   node scripts/labs-agent-smoke.mjs --only 1,4
 *   node scripts/labs-agent-smoke.mjs --base http://localhost:3000
 *
 * Requires the server to be running with a valid GEMINI_API_KEY for the
 * model-dependent scenarios (7 and 8 do not need the model).
 */

import { createParser } from "eventsource-parser";

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}
const BASE = argValue("--base") || process.env.SMOKE_BASE_URL || "http://localhost:3000";
const only = argValue("--only") ? argValue("--only").split(",").map((n) => Number(n.trim())) : null;
const pauseSeconds = Math.max(0, Number(argValue("--pause") || 0));
const RAW_STREAM_FOR = new Set([1, 4]); // scenarios whose raw streams are printed
const SCENARIO_TIMEOUT_MS = 180000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── Sample document (~30 blocks) ─────────────────────────────────────────── */

function makeSampleDoc() {
  const blocks = [
    { id: "b01", type: "heading", level: 1, text: "Remote Work Playbook" },
    {
      id: "b02", type: "paragraph",
      text: "Welcome to the Remote Work Playbook, a practical and reasonably comprehensive guide that was written to help teams of every size make the transition to remote work in a way that is deliberate, sustainable, and genuinely pleasant for everyone who is involved in the process of working from somewhere other than a traditional office."
    },
    {
      id: "b03", type: "paragraph",
      text: "Over the course of the last several years, and especially since the events that reshaped how knowledge work happens around the world, a very large number of organizations have discovered, sometimes accidentally and sometimes on purpose, that their people can be trusted to do great work from their kitchens, their home offices, their co-working spaces, and occasionally even from a van down by the river."
    },
    {
      id: "b04", type: "paragraph",
      text: "This playbook gathers the lessons those teams learned the hard way so that you do not have to rediscover them one painful mistake at a time."
    },
    { id: "b05", type: "heading", level: 2, text: "1. Why remote work matters" },
    {
      id: "b06", type: "paragraph",
      text: "Their is many benefits to remote work, from reclaiming the commute to having quiet focus time, and studies consistently show that remote employees report higher job satisfaction then their office-based peers."
    },
    {
      id: "b07", type: "paragraph",
      text: "Companies benefit too: access to a wider talent pool, lower real-estate costs, and often better retention. The key is treating remote work as a system to design, not a perk to hand out."
    },
    {
      id: "b08", type: "bulletList",
      text: "- Autonomy over your own schedule\n- Fewer interruptions from passers-by\n- Time and money saved on commuting\n- Flexibility for family and personal needs\n- The freedom to design your own workspace"
    },
    {
      id: "b09", type: "paragraph",
      text: "None of this is automatic. Remote work amplifies whatever already exists: good communication becomes great, poor communication becomes silence. The rest of this guide is about keeping the good side of that trade."
    },
    { id: "b10", type: "heading", level: 2, text: "2. Setting up your workspace" },
    {
      id: "b11", type: "paragraph",
      text: "He don't need a fancy office to be productive, but a dedicated desk, a chair that support your back, and good lighting makes a real difference. Keep your work equipment in one place so you can find it easy."
    },
    {
      id: "b12", type: "paragraph",
      text: "Make sure your internet connection are stable enough for video calls, and keep a backup option such as a phone hotspot. A pair of comfortable headphones with a decent microphone will save you from repeating yourself."
    },
    {
      id: "b13", type: "orderedList",
      text: "1. Choose a quiet spot with a door if you can\n2. Invest in an ergonomic chair before anything else\n3. Put your desk near a window for daylight\n4. Hide the cables; future you will be grateful"
    },
    {
      id: "b14", type: "paragraph",
      text: "Treat the setup as an ongoing experiment for the first month rather than a one-time purchase. Small adjustments, where the monitor sits or how the light falls, compound into real comfort."
    },
    { id: "b15", type: "heading", level: 2, text: "3. Communication and meetings" },
    {
      id: "b16", type: "paragraph",
      text: "In a remote team, writing is not a nice-to-have skill that some people happen to possess; writing is the primary medium through which decisions get made, context gets shared, and work gets coordinated across time zones and calendars."
    },
    {
      id: "b17", type: "paragraph",
      text: "Meetings still matter, but they should be treated as an expensive luxury rather than a default reaction to any question, because a meeting that could have been a message taxes the entire team's calendar at the exact same moment."
    },
    {
      id: "b18", type: "blockquote",
      text: "The best remote teams over-communicate by default. When in doubt, share more, not less."
    },
    {
      id: "b19", type: "paragraph",
      text: "Practical habits that work well: agendas before meetings, written summaries after them, and a shared place where decisions live so nobody has to reconstruct history from a chat scroll."
    },
    { id: "b20", type: "heading", level: 2, text: "4. Tools of the trade" },
    {
      id: "b21", type: "paragraph",
      text: "The tool stack matters far less than the habits around it, but a small reliable stack beats a large fragile one every single time:"
    },
    {
      id: "b22", type: "table",
      text: "| Tool | Purpose | Notes |\n| --- | --- | --- |\n| Chat | Daily coordination | Prefer threads over channels |\n| Docs | Decisions and specs | One link beats five attachments |\n| Calls | Complex discussions | Camera on when energy allows |\n| Tracker | Who is doing what | Update it, or it lies to you |"
    },
    {
      id: "b23", type: "paragraph",
      text: "Whatever you pick, document how the tools are supposed to be used. A tool without an agreement about its purpose becomes a second inbox, and a second inbox is where momentum goes to die."
    },
    {
      id: "b24", type: "codeBlock", language: "bash",
      text: "# Quick daily setup ritual\nmute_notifications() {\n  echo \"Focus block until $1\"\n  pomodoro 50m \"$1\"\n}\n\nmute_notifications \"lunch\""
    },
    {
      id: "b25", type: "paragraph",
      text: "Review the stack quarterly and remove anything nobody has opened in a month."
    },
    { id: "b26", type: "heading", level: 2, text: "5. Wellbeing and boundaries" },
    {
      id: "b27", type: "paragraph",
      text: "When the office is the home and the home is the office, boundaries do not happen on their own. They have to be built deliberately, defended politely, and revisited whenever the calendar starts winning arguments against your calendar."
    },
    {
      id: "b28", type: "taskList",
      text: "- [ ] Take a full lunch break away from the desk\n- [ ] End work at a fixed time and log off\n- [ ] Walk outside at least once a day\n- [ ] Keep one day a week meeting-light"
    },
    {
      id: "b29", type: "paragraph",
      text: "Managers set the real policy here: a leader who sends messages at midnight teaches the team that midnight is working time, whatever the handbook says about balance."
    },
    {
      id: "b30", type: "paragraph",
      text: "In conclusion, remote work is not about where people sit; it is about how clearly a team communicates, how deliberately it designs its rituals, and how seriously it protects focus and boundaries. Get those right and the office becomes optional rather than foundational."
    },
    { id: "b31", type: "horizontalRule", text: "" }
  ];

  return blocks.map(({ id, type, text, ...rest }) => ({
    id,
    type,
    text,
    attrs: type === "heading"
      ? { level: rest.level }
      : type === "codeBlock"
        ? { language: rest.language }
        : {}
  }));
}

const INTRO_IDS = ["b02", "b03", "b04"];
const SECTION2_IDS = ["b10", "b11", "b12", "b13", "b14"];
const SELECTION_IDS = ["b16", "b17"];
const TITLE_ID = "b01";
const CONCLUSION_IDS = ["b30", "b31"];

function totalChars(blocks) {
  return blocks.reduce((n, b) => n + b.text.length, 0);
}

/* ── SSE client ───────────────────────────────────────────────────────────── */

async function postAgent(body, opts = {}) {
  const res = await fetch(`${BASE}/labs/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal
  });
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    const json = await res.json().catch(() => null);
    return { status: res.status, sse: false, json, contentType };
  }

  const events = [];
  const parser = createParser((ev) => {
    if (ev.type !== "event") return;
    let data = ev.data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      /* keep raw string */
    }
    events.push({ event: ev.event || "message", data });
    if (opts.abortOn && opts.abortOn(events)) {
      opts.abortOn = null; // abort once
      opts.controller?.abort();
    }
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
  } catch (err) {
    if (err?.name !== "AbortError") throw err;
    // Client-side abort: return the events received so far.
  }
  return { status: res.status, sse: true, events, contentType };
}

/* ── Local edit applier (mirrors the Phase 2 client contract) ─────────────── */

function applyEdits(doc, edits) {
  const issues = [];
  for (const e of edits) {
    switch (e.op) {
      case "replace":
      case "replace_in_block": {
        const b = doc.find((x) => x.id === e.blockId);
        if (!b) { issues.push(`edit ${e.editId}: block ${e.blockId} not found`); break; }
        b.text = e.after;
        if (e.attrs) b.attrs = { ...b.attrs, ...e.attrs };
        break;
      }
      case "insert": {
        let idx = 0;
        if (e.afterId != null) {
          const at = doc.findIndex((x) => x.id === e.afterId);
          if (at === -1) issues.push(`edit ${e.editId}: afterId ${e.afterId} not found`);
          idx = at === -1 ? doc.length : at + 1;
        }
        doc.splice(idx, 0, { id: e.blockId, type: e.type, text: e.after, attrs: e.attrs || {} });
        break;
      }
      case "delete": {
        const i = doc.findIndex((x) => x.id === e.blockId);
        if (i === -1) { issues.push(`edit ${e.editId}: block ${e.blockId} not found`); break; }
        doc.splice(i, 1);
        break;
      }
      case "set_attrs": {
        const b = doc.find((x) => x.id === e.blockId);
        if (!b) { issues.push(`edit ${e.editId}: block ${e.blockId} not found`); break; }
        // `after` is the COMPLETE post-edit attrs map: replace, don't merge,
        // so attrs cleared with null disappear (Phase 2 Step 0a).
        b.attrs = { ...(e.after || e.attrs || {}) };
        break;
      }
      default:
        issues.push(`edit ${e.editId}: unknown op ${e.op}`);
    }
  }
  return issues;
}

function touchedIds(edits) {
  const ids = new Set();
  for (const e of edits) {
    ids.add(e.blockId);
    if (e.op === "insert" && e.afterId != null) ids.add(e.afterId);
  }
  return ids;
}

/* ── Scenario plumbing ────────────────────────────────────────────────────── */

function baseBody(blocks, instruction, extra = {}) {
  return {
    projectId: "smoke-" + Math.random().toString(36).slice(2, 8),
    blocks,
    instruction,
    messages: [],
    selection: null,
    ...extra
  };
}

function doneEvent(events) {
  const d = events.filter((e) => e.event === "done").pop();
  return d ? d.data : null;
}

function editsFrom(events) {
  return events.filter((e) => e.event === "edit").map((e) => e.data);
}

function firstErrorEvent(events) {
  const e = events.find((ev) => ev.event === "error");
  return e ? e.data : null;
}

async function serverAliveCheck() {
  try {
    const res = await fetch(`${BASE}/labs/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "health-check" }) // missing instruction -> 400
    });
    const json = await res.json().catch(() => null);
    return res.status === 400 && json && typeof json.error === "string";
  } catch {
    return false;
  }
}

/* ── Scenarios ────────────────────────────────────────────────────────────── */

const SCENARIOS = [
  {
    id: 1,
    name: "Make the introduction shorter",
    build: () => ({ body: baseBody(makeSampleDoc(), "Make the introduction shorter") }),
    check: (events, appliedDoc) => {
      const done = doneEvent(events);
      const edits = editsFrom(events);
      if (!done) return "FAIL: no done event";
      if (done.editCount < 1) return `FAIL: expected >=1 edit, got ${done.editCount} (summary: ${JSON.stringify(done.summary || "")})`;
      const touched = touchedIds(edits);
      const outside = [...touched].filter((id) => !INTRO_IDS.includes(id));
      if (outside.length > 0) return `FAIL: edits outside the intro: ${outside.join(", ")}`;
      const ops = {};
      for (const e of edits) ops[e.op] = (ops[e.op] || 0) + 1;
      const comp = Object.entries(ops).map(([o, c]) => `${c}x ${o}`).join(", ");
      return `PASS (${done.editCount} edit${done.editCount === 1 ? "" : "s"}: ${comp}; only intro blocks touched)`;
    }
  },
  {
    id: 2,
    name: "Fix grammar in the second section",
    build: () => ({ body: baseBody(makeSampleDoc(), "Fix the grammar mistakes in the second section") }),
    check: (events, appliedDoc) => {
      const done = doneEvent(events);
      const edits = editsFrom(events);
      if (!done) return "FAIL: no done event";
      if (done.editCount < 1) return `FAIL: expected >=1 edit, got ${done.editCount}`;
      const touched = touchedIds(edits);
      const outside = [...touched].filter((id) => !SECTION2_IDS.includes(id));
      if (outside.length > 0) return `FAIL: edits outside section 2: ${outside.join(", ")}`;
      const orig = makeSampleDoc();
      const b06 = appliedDoc.find((b) => b.id === "b06");
      const b06Orig = orig.find((b) => b.id === "b06");
      if (b06 && b06.text !== b06Orig.text) {
        return "FAIL: section 1 planted error (b06) was also changed";
      }
      return "PASS";
    }
  },
  {
    id: 3,
    name: "Change the title color to blue",
    build: () => ({ body: baseBody(makeSampleDoc(), "Change the title color to blue") }),
    check: (events, appliedDoc) => {
      const done = doneEvent(events);
      const edits = editsFrom(events);
      if (!done) return "FAIL: no done event";
      if (done.editCount < 1) return `FAIL: expected >=1 edit, got ${done.editCount}`;
      const nonAttrs = edits.filter((e) => e.op !== "set_attrs");
      if (nonAttrs.length > 0) return `FAIL: expected only set_attrs ops, got ${nonAttrs.map((e) => e.op).join(", ")}`;
      const wrongBlocks = edits.filter((e) => e.blockId !== TITLE_ID);
      if (wrongBlocks.length > 0) return `FAIL: styled blocks other than the title: ${wrongBlocks.map((e) => e.blockId).join(", ")}`;
      const title = appliedDoc.find((b) => b.id === TITLE_ID);
      if (!title || title.attrs.textColor !== "blue") {
        return `FAIL: title textColor is ${JSON.stringify(title?.attrs?.textColor)}, expected "blue"`;
      }
      return "PASS";
    }
  },
  {
    id: 4,
    name: "Empty document + one-page brief",
    build: () => ({ body: baseBody([], "Write a one-page brief about remote work") }),
    check: (events, appliedDoc) => {
      const done = doneEvent(events);
      const edits = editsFrom(events);
      if (!done) return "FAIL: no done event";
      if (done.editCount < 3) return `FAIL: expected several inserts, got ${done.editCount}`;
      const nonInserts = edits.filter((e) => e.op !== "insert");
      if (nonInserts.length > 0) return `FAIL: expected only insert ops, got ${nonInserts.map((e) => e.op).join(", ")}`;
      const seen = new Set();
      const ids = new Set();
      let first = true;
      for (const e of edits) {
        if (first && e.afterId !== null) return `FAIL: first insert afterId was ${JSON.stringify(e.afterId)}, expected null`;
        if (e.afterId !== null && !seen.has(e.afterId)) {
          return `FAIL: insert ${e.editId} afterId ${e.afterId} was not inserted earlier`;
        }
        if (ids.has(e.blockId)) return `FAIL: duplicate inserted id ${e.blockId}`;
        ids.add(e.blockId);
        seen.add(e.blockId);
        first = false;
      }
      if (appliedDoc.length !== edits.length) {
        return `FAIL: applied doc has ${appliedDoc.length} blocks for ${edits.length} inserts`;
      }
      // No inserted block text may contain a literal backslash-n.
      const withLiteral = edits.filter(
        (e) => typeof e.after === "string" && e.after.includes("\\n")
      );
      if (withLiteral.length > 0) {
        return `FAIL: inserted block${withLiteral.length > 1 ? "s" : ""} contain literal \\n: ${withLiteral.map((e) => e.blockId).join(", ")}`;
      }
      // The inserted bullet list must have real lines.
      const list = appliedDoc.find((b) => b.type === "bulletList");
      if (!list) return "FAIL: no bulletList block was inserted";
      const lines = list.text.split("\n").filter((l) => l.trim() !== "");
      if (lines.length < 3) {
        return `FAIL: bullet list has ${lines.length} real line${lines.length === 1 ? "" : "s"}, expected >= 3`;
      }
      return `PASS (${done.editCount} ordered inserts; bulletList has ${lines.length} real lines)`;
    }
  },
  {
    id: 5,
    name: "Selection scenario",
    build: () => {
      const doc = makeSampleDoc();
      const sel = SELECTION_IDS.map((id) => doc.find((b) => b.id === id).text).join("\n\n");
      return {
        body: baseBody(doc, "Rewrite this selection to be more concise.", {
          selection: { blockIds: SELECTION_IDS, text: sel }
        })
      };
    },
    check: (events, appliedDoc) => {
      const done = doneEvent(events);
      const edits = editsFrom(events);
      if (!done) return "FAIL: no done event";
      if (done.editCount < 1) return `FAIL: expected >=1 edit, got ${done.editCount}`;
      const touched = touchedIds(edits);
      const outside = [...touched].filter((id) => !SELECTION_IDS.includes(id));
      if (outside.length > 0) return `FAIL: edits outside the selection: ${outside.join(", ")}`;
      return "PASS";
    }
  },
  {
    id: 6,
    name: "References a block that does not exist",
    build: () => ({ body: baseBody(makeSampleDoc(), "Rewrite block b99 from scratch") }),
    check: (events) => {
      const done = doneEvent(events);
      if (!done) return "FAIL: no done event (stream hung or crashed)";
      if (done.editCount !== 0) {
        return `FAIL: expected 0 edits on a nonexistent block, got ${done.editCount}`;
      }
      const err = firstErrorEvent(events);
      if (err) return `FAIL: server error: ${err.message}`;
      return "PASS";
    }
  },
  {
    id: 7,
    name: "Abort mid-stream",
    build: () => ({
      body: baseBody(makeSampleDoc(), "Fix every grammar mistake in the whole document"),
      controller: new AbortController(),
      abortAfterFirstEvent: true
    }),
    check: async (events, appliedDoc, ctx) => {
      if (ctx.clientThrew) return `FAIL: client threw: ${ctx.clientThrew}`;
      await new Promise((r) => setTimeout(r, 1500)); // let the server finish aborting
      const alive = await serverAliveCheck();
      if (!alive) return "FAIL: server did not respond to the post-abort health check";
      return "PASS (aborted; server alive and responsive)";
    }
  },
  {
    id: 8,
    name: "Document over the size limit",
    build: () => ({
      body: baseBody(
        [
          { id: "big1", type: "paragraph", text: "x".repeat(110000), attrs: {} },
          { id: "big2", type: "paragraph", text: "y".repeat(110000), attrs: {} }
        ],
        "Do anything"
      )
    }),
    check: (events, appliedDoc, ctx) => {
      if (ctx.result.sse) return "FAIL: expected JSON error, got an event stream";
      if (ctx.result.status !== 413) return `FAIL: expected HTTP 413, got ${ctx.result.status}`;
      const msg = ctx.result.json?.error || "";
      if (!msg || !/too large/i.test(msg)) return `FAIL: unclear 413 message: ${JSON.stringify(msg)}`;
      return "PASS";
    }
  },
  {
    id: 9,
    name: "Remove the conclusion",
    build: () => ({ body: baseBody(makeSampleDoc(), "Remove the conclusion") }),
    check: (events, appliedDoc) => {
      const done = doneEvent(events);
      if (!done) return "FAIL: no done event";
      const edits = editsFrom(events);
      if (done.editCount < 1) return `FAIL: expected >=1 delete, got ${done.editCount} edits`;
      const nonDelete = edits.filter((e) => e.op !== "delete");
      if (nonDelete.length > 0) {
        return `FAIL: non-delete ops: ${nonDelete.map((e) => `${e.op}@${e.blockId}`).join(", ")}`;
      }
      const outside = edits.filter((e) => !CONCLUSION_IDS.includes(e.blockId));
      if (outside.length > 0) {
        return `FAIL: deleted non-conclusion blocks: ${outside.map((e) => e.blockId).join(", ")}`;
      }
      if (appliedDoc.find((b) => b.id === "b30")) {
        return "FAIL: conclusion paragraph b30 is still present";
      }
      return `PASS (deleted: ${edits.map((e) => e.blockId).join(", ")})`;
    }
  },
  {
    id: 10,
    name: "Make the document more concise (informational)",
    build: () => ({ body: baseBody(makeSampleDoc(), "Make the document more concise") }),
    check: (events) => {
      const done = doneEvent(events);
      if (!done) return "FAIL: no done event";
      const err = firstErrorEvent(events);
      if (err) return `FAIL: server error (${err.code || "?"}): ${String(err.message).slice(0, 60)}`;
      const edits = editsFrom(events);
      const byOp = {};
      for (const e of edits) byOp[e.op] = (byOp[e.op] || 0) + 1;
      const comp = Object.entries(byOp).map(([o, c]) => `${c}x ${o}`).join(", ") || "no edits";
      const deletes = byOp.delete || 0;
      return `PASS (informational: ${done.editCount} edits — ${comp}; ${deletes} deletion${deletes === 1 ? "" : "s"})`;
    }
  },
  {
    id: 11,
    name: "Null-clear the title color",
    build: () => {
      const doc = makeSampleDoc();
      const title = doc.find((b) => b.id === TITLE_ID);
      title.attrs = { ...title.attrs, textColor: "blue" };
      return { body: baseBody(doc, "Remove the color from the title") };
    },
    check: (events, appliedDoc) => {
      const done = doneEvent(events);
      if (!done) return "FAIL: no done event";
      const edits = editsFrom(events);
      if (done.editCount < 1) return `FAIL: expected >=1 set_attrs, got ${done.editCount} edits`;
      const nonAttrs = edits.filter((e) => e.op !== "set_attrs");
      if (nonAttrs.length > 0) return `FAIL: non-set_attrs ops: ${nonAttrs.map((e) => e.op).join(", ")}`;
      const wrongBlocks = edits.filter((e) => e.blockId !== TITLE_ID);
      if (wrongBlocks.length > 0) return `FAIL: styled blocks other than the title: ${wrongBlocks.map((e) => e.blockId).join(", ")}`;
      const title = appliedDoc.find((b) => b.id === TITLE_ID);
      if (!title) return "FAIL: title block missing after run";
      if (title.attrs.textColor !== undefined) {
        return `FAIL: title textColor is ${JSON.stringify(title.attrs.textColor)}, expected cleared`;
      }
      if (title.attrs.level !== 1) return "FAIL: heading level was lost during the clear";
      return "PASS (textColor cleared, level preserved)";
    }
  }
];

/* ── Runner ───────────────────────────────────────────────────────────────── */

async function runScenario(sc) {
  const t0 = Date.now();
  const { body, controller, abortAfterFirstEvent } = sc.build();
  const timeoutSignal = AbortSignal.timeout(SCENARIO_TIMEOUT_MS);
  const signal = controller
    ? AbortSignal.any([timeoutSignal, controller.signal])
    : timeoutSignal;

  const ctx = { clientThrew: null, result: null };
  const events = [];
  let result;
  try {
    result = await postAgent(body, {
      signal,
      controller,
      abortOn: abortAfterFirstEvent ? () => true : null
    });
  } catch (err) {
    ctx.clientThrew = err?.name === "TimeoutError" ? `scenario timed out after ${SCENARIO_TIMEOUT_MS}ms` : String(err?.message || err);
    result = { status: 0, sse: false, json: null, contentType: "" };
  }
  ctx.result = result;

  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  let appliedDoc = [];
  const edits = result.sse ? editsFrom(result.events) : [];
  if (result.sse) {
    appliedDoc = body.blocks.map((b) => ({ ...b, attrs: { ...b.attrs } }));
    const issues = applyEdits(appliedDoc, edits);
    if (issues.length > 0) ctx.applyIssues = issues;
  }

  const done = result.sse ? doneEvent(result.events) : null;
  const tokens = done?.usage
    ? `${done.usage.inputTokens ?? 0}/${done.usage.outputTokens ?? 0}`
    : "-";

  let verdict;
  try {
    verdict = await sc.check(result.sse ? result.events : [], appliedDoc, ctx);
  } catch (err) {
    verdict = `FAIL: check threw ${String(err?.message || err)}`;
  }
  if (ctx.applyIssues && ctx.applyIssues.length) {
    verdict += ` [applier issues: ${ctx.applyIssues.join("; ")}]`;
  }

  if (RAW_STREAM_FOR.has(sc.id) && result.sse) {
    console.log(`\n──────── raw event stream: scenario ${sc.id} (${sc.name}) ────────`);
    for (const e of result.events) {
      console.log(`event: ${e.event}`);
      console.log(`data: ${JSON.stringify(e.data)}`);
    }
    console.log("──────── end of stream ────────");
  }

  const errEvent = result.sse ? firstErrorEvent(result.events) : null;
  const noteBits = [];
  if (errEvent) {
    noteBits.push(`error(${errEvent.code || "?"}): ${String(errEvent.message).slice(0, 60)}`);
  }
  if (done?.newlineNormalized) noteBits.push(`norm=${done.newlineNormalized}`);
  if (done?.repairs) {
    const repTotal = Object.values(done.repairs).reduce((a, b) => a + (Number(b) || 0), 0);
    if (repTotal > 0) {
      const detail = Object.entries(done.repairs).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(",");
      noteBits.push(`repairs=${repTotal}(${detail})`);
    }
  }
  if (Array.isArray(done?.warnings) && done.warnings.length > 0) {
    noteBits.push(`warnings=${done.warnings.length}(${done.warnings.map((w) => w.code).join(",")})`);
  }

  return {
    id: sc.id,
    name: sc.name,
    verdict,
    pass: verdict.startsWith("PASS"),
    steps: done?.steps ?? "-",
    edits: done?.editCount ?? (result.sse ? edits.length : "-"),
    toolCalls: done?.toolCalls ?? "-",
    parallel: done?.parallelToolCalls ?? "-",
    tokens,
    seconds,
    notes: noteBits.join(" | ")
  };
}

async function main() {
  const sample = makeSampleDoc();
  console.log(`Labs agent smoke harness`);
  console.log(`  server:  ${BASE}`);
  console.log(`  sample doc: ${sample.length} blocks, ${totalChars(sample).toLocaleString()} chars (inline threshold 12000)`);
  console.log(`  pause between scenarios: ${pauseSeconds}s`);
  console.log(`  GEMINI_API_KEY note: model-dependent scenarios require a valid key on the server.\n`);

  const rows = [];
  const selected = SCENARIOS.filter((sc) => !only || only.includes(sc.id));
  for (let i = 0; i < selected.length; i++) {
    const sc = selected[i];
    process.stdout.write(`Running scenario ${sc.id}: ${sc.name} ... `);
    const row = await runScenario(sc);
    rows.push(row);
    console.log(row.verdict.split(" [")[0]);
    if (pauseSeconds > 0 && i < selected.length - 1) {
      await sleep(pauseSeconds * 1000);
    }
  }

  console.log(`\n${"=".repeat(118)}`);
  console.log("SUMMARY");
  console.log("=".repeat(118));
  const header = ["#", "Scenario", "Result", "Steps", "Edits", "TC", "Par", "TokIn/Out", "Sec", "Notes"];
  const widths = [3, 36, 6, 6, 6, 4, 4, 12, 6, 42];
  const line = (cells) =>
    cells.map((c, i) => String(c ?? "").padEnd(widths[i])).join(" | ").trimEnd();
  console.log(line(header));
  console.log("-".repeat(118));
  for (const r of rows) {
    console.log(line([r.id, r.name, r.pass ? "PASS" : "FAIL", r.steps, r.edits, r.toolCalls, r.parallel, r.tokens, r.seconds, r.notes]));
  }
  const passed = rows.filter((r) => r.pass).length;
  console.log("-".repeat(110));
  console.log(`${passed}/${rows.length} scenarios passed\n`);

  process.exitCode = passed === rows.length ? 0 : 1;
}

main().catch((err) => {
  console.error("Harness crashed:", err);
  process.exitCode = 2;
});
