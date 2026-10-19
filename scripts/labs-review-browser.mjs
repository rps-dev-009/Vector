// Real pointer-click checks against an isolated Edge/Chrome CDP profile (:9228)
// and Vite (:5178). Agent SSE is deterministic; no external API calls are made.
import assert from "node:assert/strict";
const targets = await (await fetch("http://127.0.0.1:9228/json")).json();
const target = targets.find(t => t.type === "page" && !t.url.startsWith("edge://"));
assert(target, "Start an isolated browser with CDP on :9228 first");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0;
const pending = new Map();
const browserErrors = [];
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data), request = pending.get(message.id);
  if (message.method === "Runtime.exceptionThrown") browserErrors.push(message.params.exceptionDetails);
  if (message.method === "Network.loadingFailed") browserErrors.push(message.params);
  if (message.method === "Network.responseReceived" && message.params.response.status >= 400) browserErrors.push({ status: message.params.response.status, url: message.params.response.url });
  if (!request) return;
  pending.delete(message.id);
  message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const wait = expression => evaluate(`new Promise((resolve,reject)=>{const start=Date.now();const t=setInterval(()=>{if(${expression}){clearInterval(t);resolve(true);}else if(Date.now()-start>60000){clearInterval(t);reject(new Error('UI wait timed out'));}},50);})`);
const move = (x, y) => send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
const click = async expression => {
  const point = await evaluate(`(()=>{const el=${expression};if(!el)throw new Error('Missing click target');el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await move(point.x, point.y);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
};
const button = text => `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)})`;
const emit = (events, close = true) => evaluate(`(()=>{window.__reviewStream.enqueue(new TextEncoder().encode(${JSON.stringify(events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join(""))}));${close ? "window.__reviewStream.close();" : ""}})()`);
const startRun = async () => {
  await evaluate(`(()=>{const el=document.querySelector('.labs-assistant textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Review verification');el.dispatchEvent(new Event('input',{bubbles:true}));window.__reviewStream=null;})()`);
  await wait("!document.querySelector('button[title=\"Send (Enter)\"]').disabled");
  await click("document.querySelector('button[title=\"Send (Enter)\"]')");
  await wait("window.__reviewStream");
};
const done = ["done", { ok: true, summary: "Updated.", editCount: 1 }];
const originalDoc = { type: "doc", content: [
  { type: "heading", attrs: { blockId: "title", level: 1 }, content: [{ type: "text", text: "Review verification" }] },
  { type: "paragraph", attrs: { blockId: "p1" }, content: [{ type: "text", text: "Original first paragraph.", marks: [{ type: "bold" }] }] },
  { type: "paragraph", attrs: { blockId: "p2" }, content: [{ type: "text", text: "Original second paragraph.", marks: [{ type: "italic" }] }] },
  { type: "paragraph", attrs: { blockId: "p3" }, content: [{ type: "text", text: "Original third paragraph." }] },
  { type: "paragraph", attrs: { blockId: "last" }, content: [{ type: "text", text: "Unchanged last paragraph." }] }
] };
try {
  await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `if(location.origin==='http://127.0.0.1:5178') {
    localStorage.setItem('labs_projects_global',JSON.stringify([{id:'review-fixture',sessionId:'review-fixture',name:'Review verification',document:'Original',content:${JSON.stringify(originalDoc)},chat:[],createdAt:1,updatedAt:1}]));
    localStorage.setItem('labs_assistant_open','1');localStorage.setItem('labs_assistant_width','400');
  }` });
  await send("Page.navigate", { url: "http://127.0.0.1:5178" });
  await wait("Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Labs')");
  // Navigation animates on initial load; review buttons below use real input.
  await evaluate(`${button("Labs")}.click()`);
  await wait("document.querySelector('.ProseMirror [data-block-id=\"p1\"]')");
  await evaluate(`(()=>{const original=window.fetch;window.fetch=async(url,options)=>url==='/labs/agent'?new Response(new ReadableStream({start(c){window.__reviewStream=c;}}),{headers:{'Content-Type':'text/event-stream'}}):original(url,options);})()`);

  await startRun();
  await emit([["edit", { op: "replace", blockId: "p1", after: "First AI version." }]], false);
  await wait("document.querySelector('[data-block-id=\"p1\"]').textContent==='First AI version.'");
  const point = await evaluate("(()=>{const r=document.querySelector('[data-block-id=\"p1\"]').getBoundingClientRect();return {x:r.x+20,y:r.y+10};})()");
  await move(point.x, point.y);
  assert.equal(await evaluate("!!document.querySelector('.labs-block-actions')"), false);
  await emit([done]);
  await wait("Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Accept all')");
  await click(button("Accept all"));
  await wait("!document.querySelector('.labs-review-modified')");
  assert.equal(await evaluate("document.querySelector('[data-block-id=\"p1\"]').textContent"), "First AI version.");
  console.log("PASS: real Accept all click keeps text and clears review; no per-block controls during streaming.");

  await startRun();
  await emit([["edit", { op: "replace", blockId: "p1", after: "Second AI version." }], done]);
  await wait("Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Reject all')");
  await move(point.x, point.y);
  await wait("document.querySelector('.labs-reject')");
  const destination = await evaluate("(()=>{const r=document.querySelector('.labs-reject').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
  for (let i = 1; i <= 8; i++) await move(point.x + (destination.x - point.x) * i / 8, point.y + (destination.y - point.y) * i / 8);
  await click("document.querySelector('.labs-reject')");
  await wait("document.querySelector('[data-block-id=\"p1\"]').textContent==='First AI version.'");
  console.log("PASS: real pointer movement and per-block Reject restore the accepted original.");

  await startRun();
  await emit([
    ["edit", { op: "delete", blockId: "p2" }], ["edit", { op: "delete", blockId: "p3" }],
    ["edit", { op: "insert", blockId: "added", afterId: "title", type: "paragraph", after: "Temporary AI addition." }],
    ["edit", { op: "replace", blockId: "p1", after: "Third AI version." }], done
  ]);
  await wait("Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Reject all')");
  await startRun(); await emit([done]);
  await wait("Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Reject all')");
  await click(button("Reject all"));
  await wait("!document.querySelector('.labs-review-modified,.labs-review-added')");
  const ids = await evaluate("Array.from(document.querySelector('.ProseMirror').children).map(n=>n.dataset.blockId)");
  assert.deepEqual(ids, ["title", "p1", "p2", "p3", "last"]);
  assert.equal(await evaluate("document.querySelector('[data-block-id=\"p1\"]').textContent"), "First AI version.");
  assert.equal(await evaluate("document.querySelector('[data-block-id=\"p2\"] em').textContent"), "Original second paragraph.");
  await wait("JSON.parse(localStorage.getItem('labs_projects_global'))[0].content.content.some(n=>n.attrs?.blockId==='p2')");
  console.log("PASS: Reject all restores mixed edits/deletions in order after a follow-up, preserves marks and saves restored content.");
} catch (error) {
  console.error("Browser state:", await evaluate("({url:location.href,text:document.body.innerText.slice(0,1800)})").catch(() => null));
  console.error("Browser errors:", JSON.stringify(browserErrors));
  throw error;
} finally { socket.close(); }
