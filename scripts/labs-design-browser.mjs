// Browser regression check against an isolated Edge/Chrome CDP profile.
// Start Vite on :5178 and the browser with --remote-debugging-port=9228.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const targets = await (await fetch("http://127.0.0.1:9228/json")).json();
const target = targets.find(t => t.type === "page" && !t.url.startsWith("edge://"));
assert(target, "Launch an isolated browser with CDP on port 9228 first");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0;
const requests = new Map();
const exceptions = [];
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.text);
  const pending = requests.get(message.id);
  if (!pending) return;
  requests.delete(message.id);
  message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  requests.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const wait = expression => evaluate(`new Promise((resolve,reject) => {
  const start=Date.now(); const timer=setInterval(()=>{
    if (${expression}) {clearInterval(timer); resolve(true);}
    else if(Date.now()-start>60000){clearInterval(timer);reject(new Error('UI wait timed out'));}
  },100);
})`);
const resize = (width, height = 1000) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 768 });
const para = text => ({ type: "paragraph", content: [{ type: "text", text }] });
const doc = { type: "doc", attrs: { documentStyle: { preset: "editorial" } }, content: [
  { type: "heading", attrs: { level: 1, blockId: "title" }, content: [{ type: "text", text: "Connected fields.\nClearer decisions." }] },
  { ...para("A practical guide to agricultural extension communication, where good information becomes confident action."), attrs: { blockId: "intro" } },
  { type: "heading", attrs: { level: 2, blockId: "section" }, content: [{ type: "text", text: "Communication that reaches people" }] },
  { ...para("Effective extension begins with listening. The right channel connects research with local knowledge, translating evidence into decisions that farmers can use."), attrs: { blockId: "body" } },
  { type: "blockquote", attrs: { blockId: "quote" }, content: [para("Build trust first. Information becomes useful when people can question it, understand it, and act on it.")] },
  { type: "table", attrs: { blockId: "table" }, content: [
    { type: "tableRow", content: ["Channel", "Best used for", "Strength"].map(text => ({ type: "tableHeader", content: [para(text)] })) },
    ...[["Field visit", "Individual advice", "Personal trust"], ["Demonstration", "Practical skills", "Learning by doing"], ["Community radio", "Local updates", "Shared reach"]].map(row => ({ type: "tableRow", content: row.map(text => ({ type: "tableCell", content: [para(text)] })) }))
  ] },
  { ...para("Choose the format around the audience, not the other way around."), attrs: { blockId: "last" } }
] };
const project = { id: "design-browser-fixture", name: "Extension communication", sessionId: "design-browser-fixture", createdAt: 1, updatedAt: 1, document: "Fixture", content: doc, chat: [] };

try {
  await send("Page.enable"); await send("Runtime.enable");
  await resize(1440);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `if(location.origin==='http://127.0.0.1:5178') {localStorage.setItem('labs_assistant_width','400'); if(!localStorage.getItem('labs_design_fixture')) {localStorage.setItem('labs_projects_global',${JSON.stringify(JSON.stringify([project]))});localStorage.setItem('labs_design_fixture','1');localStorage.setItem('flowise_theme','dark');}}` });
  await send("Page.navigate", { url: "http://127.0.0.1:5178" });
  await wait("Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Labs')");
  await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Labs').click()");
  await wait("document.querySelector('.labs-page .ProseMirror table')");
  const original = await evaluate("document.querySelector('.ProseMirror').textContent");
  const inspect = () => evaluate(`(()=>{const page=document.querySelector('.labs-page'), shell=document.querySelector('.labs-shell'), assistant=document.querySelector('.labs-assistant'), table=page.querySelector('table'); return {
    preset:page.dataset.documentTheme, pageRight:page.getBoundingClientRect().right, shellRight:shell.getBoundingClientRect().right,
    viewport:innerWidth, assistantRight:assistant.getBoundingClientRect().right,
    overflow:page.scrollWidth>page.clientWidth+2, tableOverflow:table.scrollWidth>table.clientWidth+2,
    headingFont:getComputedStyle(page.querySelector('h1')).fontFamily,
    headerFill:getComputedStyle(table.querySelector('th')).backgroundColor,
    headerInk:getComputedStyle(table.querySelector('th')).color
  };})()`);
  const initial = await inspect();
  assert(!initial.overflow && !initial.tableOverflow, JSON.stringify(initial));
  assert(initial.assistantRight <= 1440, "Assistant must stay inside viewport");
  await evaluate("document.querySelector('[aria-controls=\"labs-design-panel\"]').click()");
  await wait("document.querySelectorAll('.labs-theme-choice').length===5");
  await evaluate("Array.from(document.querySelectorAll('.labs-theme-choice')).find(b=>b.textContent.includes('Botanical')).click()");
  await wait("document.querySelector('.labs-page').dataset.documentTheme==='botanical'");
  assert.equal(await evaluate("document.querySelector('.ProseMirror').textContent"), original);
  await evaluate("document.querySelector('[aria-controls=\"labs-design-panel\"]').click()");
  const image = await send("Page.captureScreenshot", { format: "png" });
  const imagePath = join(tmpdir(), "kilo", "labs-botanical-desktop.png");
  await writeFile(imagePath, Buffer.from(image.data, "base64"));
  console.log("Desktop:", JSON.stringify(await inspect()), "Screenshot:", imagePath);

  // Drag well beyond maximum width with the application sidebar open.
  const handle = await evaluate("(()=>{const r=document.querySelector('.labs-resizer').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+100};})()");
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: handle.x, y: handle.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 300, y: handle.y, button: "left", buttons: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 300, y: handle.y, button: "left", clickCount: 1 });
  await wait("document.querySelector('.labs-assistant').getBoundingClientRect().width>=600");
  const expanded = await inspect();
  assert(!expanded.overflow && expanded.assistantRight <= 1440, JSON.stringify(expanded));
  console.log("Expanded assistant:", JSON.stringify(expanded));
  await evaluate("document.documentElement.classList.add('light')");
  assert.equal((await inspect()).headerFill, "rgb(45, 99, 76)");
  await resize(390, 844);
  await wait("document.querySelector('.labs-segment') && !document.querySelector('.labs-resizer')");
  assert.equal(await evaluate("document.querySelector('.labs-page').scrollWidth > document.querySelector('.labs-page').clientWidth+2"), false);
  const mobile = await send("Page.captureScreenshot", { format: "png" });
  const mobilePath = join(tmpdir(), "kilo", "labs-botanical-mobile.png");
  await writeFile(mobilePath, Buffer.from(mobile.data, "base64"));
  await wait("JSON.parse(localStorage.getItem('labs_projects_global'))[0].content.attrs.documentStyle.preset==='botanical'");
  assert.deepEqual(exceptions, []);
  console.log("PASS: themes, text preservation, saved styles, sidebar-open resize, mobile, light/dark. Screenshot:", mobilePath);
  await evaluate("document.querySelector('button[title=\"Export document\"]').click()");
  await wait("document.querySelector('input[value=\"rounded\"]')");
  const dialogBounds = await evaluate(`(()=>{const r=document.querySelector('[role=dialog]').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};})()`);
  assert(dialogBounds.left >= 0 && dialogBounds.right <= 390 && dialogBounds.top >= 0 && dialogBounds.bottom <= 844, JSON.stringify(dialogBounds));
  assert.equal(await evaluate("document.querySelector('input[value=\"editable\"]').checked"), true);
  await evaluate("document.querySelector('input[value=\"rounded\"]').click()");
  assert.equal(await evaluate("document.querySelector('input[value=\"rounded\"]').checked"), true);
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
  const rounded = await evaluate(`(async()=>{
    const {renderRoundedWordTables}=await import('/src/utils/roundedWordTables.js');
    const content=JSON.parse(localStorage.getItem('labs_projects_global'))[0].content;
    const images=await renderRoundedWordTables(content);
    const first=images[0][0];
    const image=new Image(); image.src=first.data; await image.decode();
    const canvas=document.createElement('canvas'); canvas.width=image.naturalWidth; canvas.height=image.naturalHeight;
    const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
    return {data:first.data, width:first.width, height:first.height, pixels:image.naturalWidth,
      cornerAlpha:ctx.getImageData(0,0,1,1).data[3], centerAlpha:ctx.getImageData(canvas.width/2,10,1,1).data[3],
      leakedFrames:document.querySelectorAll('iframe[title="Preparing rounded Word tables"]').length};
  })()`);
  assert.equal(rounded.cornerAlpha, 0, "Rounded PNG corners must be transparent");
  assert.equal(rounded.centerAlpha, 255, "Table contents must remain opaque");
  assert.equal(rounded.leakedFrames, 0, "Rendering must clean up its frame");
  assert(rounded.pixels >= rounded.width * 2.9, "Rounded images must render at 3x resolution");
  const roundedPath = join(tmpdir(), "kilo", "labs-rounded-word-table.png");
  await writeFile(roundedPath, Buffer.from(rounded.data.split(",")[1], "base64"));
  console.log("PASS: rounded Word table PNG, 3x resolution, transparent corners, frame cleanup:", roundedPath);
  const longTable = await evaluate(`(async()=>{
    const {renderRoundedWordTables}=await import('/src/utils/roundedWordTables.js');
    const source=JSON.parse(localStorage.getItem('labs_projects_global'))[0].content;
    const table=source.content.find(n=>n.type==='table');
    const head=table.content[0];
    table.content=[head,...Array.from({length:60},(_,i)=>({type:'tableRow',content:[
      {type:'tableCell',content:[{type:'paragraph',content:[{type:'text',text:'Entry '+i}]}]},
      ...table.content[1].content.slice(1)
    ]}))];
    const images=await renderRoundedWordTables({type:'doc',attrs:source.attrs,content:[table]});
    return {count:images[0].length,heights:images[0].map(p=>p.height),
      headers:images[0].every(p=>p.alt.startsWith('Channel |')),
      entries:images[0].flatMap(p=>p.alt.match(/Entry \\d+/g)||[])};
  })()`);
  assert(longTable.count > 1, "Long tables must paginate");
  assert(longTable.headers, "Each table panel must repeat the header");
  assert.deepEqual(longTable.entries, Array.from({ length: 60 }, (_, i) => `Entry ${i}`));
  console.log("PASS: 60 table rows preserved across rounded image panels:", JSON.stringify(longTable.heights));
  const printHtml = await evaluate(`(async()=>{
    const {buildLabsPrintHtml}=await import('/src/utils/exportToPdf.js');
    const project=JSON.parse(localStorage.getItem('labs_projects_global'))[0];
    return buildLabsPrintHtml(project.content, undefined, undefined, project.name);
  })()`);
  await resize(1100, 1000);
  await send("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(printHtml)}` });
  await wait("document.querySelector('table th')");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('th')).backgroundColor"), "rgb(45, 99, 76)");
  const pdf = await send("Page.printToPDF", { printBackground: true, preferCSSPageSize: true });
  const pdfPath = join(tmpdir(), "kilo", "labs-botanical-print.pdf");
  await writeFile(pdfPath, Buffer.from(pdf.data, "base64"));
  console.log("PASS: real browser paginated PDF generated:", pdfPath);
} finally { socket.close(); }
