// Uses the isolated browser on :9228 and Vite on :5178. --live also verifies
// Gemini vision against an ephemeral Labs-only Express server in this process.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const targets = await (await fetch("http://127.0.0.1:9228/json")).json();
const target = targets.find(t => t.type === "page" && !t.url.startsWith("edge://"));
assert(target, "An isolated browser with CDP on :9228 is required");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0;
const requests = new Map();
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data), pending = requests.get(message.id);
  if (!pending) return;
  requests.delete(message.id);
  message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; requests.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const wait = expression => evaluate(`new Promise((resolve,reject)=>{const start=Date.now();const t=setInterval(()=>{if(${expression}){clearInterval(t);resolve(true);}else if(Date.now()-start>60000){clearInterval(t);reject(new Error('UI wait timed out'));}},100);})`);
let server;
try {
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `if(location.origin==='http://127.0.0.1:5178') {
    localStorage.setItem('labs_projects_global',JSON.stringify([{id:'image-fixture',sessionId:'image-fixture',name:'Image check',document:'Reference document',content:{type:'doc',content:[{type:'paragraph',attrs:{blockId:'p'},content:[{type:'text',text:'Reference document'}]}]},chat:[],createdAt:1,updatedAt:1}]));
    localStorage.setItem('labs_assistant_open','1');
  }` });
  await send("Page.navigate", { url: "http://127.0.0.1:5178" });
  await wait("Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Labs')");
  await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Labs').click()");
  await wait("document.querySelector('button[aria-label=\"Attach images\"]')");
  await evaluate(`(()=>{
    window.__imageRequests=[];
    const original=window.fetch;
    window.fetch=async (url,options)=>{
      if(url==='/labs/agent'){
        const body=JSON.parse(options.body);window.__imageRequests.push(body);
        if(window.__imageFailure) return new Response('{"error":"Rejected image test"}',{status:400,headers:{'Content-Type':'application/json'}});
        const count=(body.images?.length||0)+(body.messages||[]).reduce((n,m)=>n+(m.images?.length||0),0);
        return new Response('event: done\\ndata: {"ok":true,"summary":"The image says VISION CHECK.","editCount":0,"steps":1}\\n\\n',{headers:{'Content-Type':'text/event-stream',...(!window.__outdatedServer ? {'X-Labs-Image-Count':String(count)} : {})}});
      }
      return original(url,options);
    };
  })()`);
  await evaluate(`(async()=>{
    const canvas=document.createElement('canvas');canvas.width=3000;canvas.height=1500;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,3000,1500);
    ctx.fillStyle='#112244';ctx.font='bold 240px Arial';ctx.fillText('VISION CHECK',250,400);
    ctx.fillStyle='#ee8800';ctx.beginPath();ctx.arc(800,1000,250,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#3366cc';ctx.fillRect(1800,800,500,500);
    const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));
    window.__imageFile=new File([blob],'vision-check.png',{type:'image/png'});
    const dt=new DataTransfer();dt.items.add(window.__imageFile);
    const input=document.querySelector('input[aria-label="Choose images to attach"]');
    input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await wait("document.querySelector('[aria-label=\"Attached images\"] img') && !document.querySelector('button[title=\"Send (Enter)\"]').disabled");
  const previewSize = await evaluate("(()=>{const img=document.querySelector('[aria-label=\"Attached images\"] img');return [img.naturalWidth,img.naturalHeight]})()");
  assert.deepEqual(previewSize, [2048, 1024]);
  await evaluate("document.querySelector('button[aria-label=\"Remove vision-check.png\"]').click()");
  assert.equal(await evaluate("!!document.querySelector('[aria-label=\"Attached images\"]')"), false);
  // Verify clipboard paste uses the same preparation path.
  await evaluate(`(()=>{const dt=new DataTransfer();dt.items.add(window.__imageFile);const e=new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true});document.querySelector('.labs-assistant textarea').dispatchEvent(e);})()`);
  await wait("document.querySelector('[aria-label=\"Attached images\"] img') && !document.querySelector('button[title=\"Send (Enter)\"]').disabled");
  await evaluate("document.querySelector('button[title=\"Send (Enter)\"]').click()");
  await wait("window.__imageRequests.length===1 && document.querySelector('.labs-assistant-messages').textContent.includes('The image says')");
  const first = await evaluate("window.__imageRequests[0]");
  assert.equal(first.images.length, 1);
  assert.equal(first.images[0].mediaType, "image/png");
  assert(first.images[0].data && !first.images[0].data.startsWith("data:"));
  assert(first.instruction.includes("Do not edit the document"));
  await wait("JSON.parse(localStorage.getItem('labs_projects_global'))[0].chat.length>=2");
  const saved = await evaluate("localStorage.getItem('labs_projects_global')");
  assert(saved.includes("vision-check.png"));
  assert(!saved.includes(first.images[0].data), "Image bytes must never go into project storage");
  await evaluate(`(()=>{const textarea=document.querySelector('.labs-assistant textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(textarea,'What colors are in the image?');textarea.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await wait("!document.querySelector('button[title=\"Send (Enter)\"]').disabled");
  await evaluate("document.querySelector('button[title=\"Send (Enter)\"]').click()");
  await wait("window.__imageRequests.length===2");
  const followup = await evaluate("window.__imageRequests[1]");
  assert.equal(followup.images.length, 0);
  assert.equal(followup.messages.find(m => m.images?.length).images[0].data, first.images[0].data);
  await evaluate(`(()=>{window.__imageFailure=true;const dt=new DataTransfer();dt.items.add(window.__imageFile);document.querySelector('.labs-assistant textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));})()`);
  await wait("document.querySelector('[aria-label=\"Attached images\"] img') && !document.querySelector('button[title=\"Send (Enter)\"]').disabled");
  await evaluate("document.querySelector('button[title=\"Send (Enter)\"]').click()");
  await wait("window.__imageRequests.length===3 && document.querySelector('.labs-assistant').textContent.includes('Rejected image test')");
  assert.equal(await evaluate("!!document.querySelector('[aria-label=\"Attached images\"] img')"), true);
  await evaluate("window.__imageFailure=false;document.querySelector('button[title=\"Send (Enter)\"]').click()");
  await wait("window.__imageRequests.length===4 && !document.querySelector('[aria-label=\"Attached images\"]')");
  console.log("PASS: browser upload, resize, removal, paste, image-only send, follow-up image context, and metadata-only persistence.");
  console.log("PASS: rejected requests restore image attachments for retry.");
  await evaluate(`(()=>{window.__outdatedServer=true;const dt=new DataTransfer();dt.items.add(window.__imageFile);document.querySelector('.labs-assistant textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));})()`);
  await wait("document.querySelector('[aria-label=\"Attached images\"] img') && !document.querySelector('button[title=\"Send (Enter)\"]').disabled");
  await evaluate("document.querySelector('button[title=\"Send (Enter)\"]').click()");
  await wait("document.querySelector('.labs-assistant').textContent.includes('Restart the Vector server')");
  assert.equal(await evaluate("!!document.querySelector('[aria-label=\"Attached images\"] img')"), true);
  console.log("PASS: an outdated server is blocked instead of silently ignoring images; attachments remain available.");

  if (process.argv.includes("--live")) {
    let base = process.argv.find(arg => arg.startsWith("--base="))?.slice(7);
    if (!base) {
      const require = createRequire(import.meta.url);
      require("dotenv").config();
      const express = require("express");
      const { labsJsonParser } = require("../server/labs/images.js");
      const { registerLabsAgentRoute } = require("../server/labs/route.js");
      const app = express(); app.post("/labs/agent", labsJsonParser); app.use(express.json({ limit: "2mb" }));
      registerLabsAgentRoute(app);
      server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
      base = `http://127.0.0.1:${server.address().port}`;
    }
    const response = await fetch(`${base}/labs/agent`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ ...first, messages: [{ role: "assistant", content: "I cannot see any attached image in our chat." }],
        instruction: "Can you see this image? If you can, read the uppercase words at the top. Do not edit the document. Reply with those words only." })
    });
    assert(response.ok, `HTTP ${response.status}`);
    assert.equal(response.headers.get("X-Labs-Image-Count"), "1");
    const stream = await response.text();
    const frames = stream.split(/\r?\n\r?\n/).map(frame => {
      const event = frame.match(/^event: (.+)$/m)?.[1], data = frame.match(/^data: (.+)$/m)?.[1];
      return event && data ? { event, data: JSON.parse(data) } : null;
    }).filter(Boolean);
    assert.equal(frames.filter(f => f.event === "error").length, 0, JSON.stringify(frames.filter(f => f.event === "error")));
    assert.equal(frames.filter(f => f.event === "edit").length, 0);
    const done = frames.find(f => f.event === "done")?.data;
    assert(done?.ok && /VISION\s+CHECK/i.test(done.summary), `Unexpected vision response: ${done?.summary}`);
    console.log(`PASS: live Gemini at ${base} read VISION CHECK from the attached image with no document edits, despite an earlier no-image reply.`);
  }
} finally { socket.close(); if (server) await new Promise(resolve => server.close(resolve)); }
