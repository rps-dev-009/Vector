// Run with Vite on :5178 and an isolated Edge/Chrome profile exposing CDP :9228.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const targets = await (await fetch("http://127.0.0.1:9228/json")).json();
const target = targets.find(target => target.type === "page" && !target.url.startsWith("edge://"));
assert(target, "An isolated browser with CDP :9228 is required");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0;
const pending = new Map();
const exceptions = [];
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Runtime.exceptionThrown" && !message.params.exceptionDetails.url?.startsWith("chrome-extension://")) exceptions.push(message.params.exceptionDetails.text);
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const wait = expression => evaluate(`new Promise((resolve,reject)=>{
  const start=Date.now(); const timer=setInterval(()=>{
    if(${expression}) {clearInterval(timer);resolve(true);}
    else if(Date.now()-start>45000) {clearInterval(timer);reject(new Error('UI wait timed out'));}
  },100);
})`);
const paragraph = (id, text) => ({ type: "paragraph", attrs: { blockId: id }, content: [{ type: "text", text }] });
const content = { type: "doc", content: [paragraph("before", "Keep this explanation exactly as written."),
  { type: "spacer", attrs: { blockId: "blank", heightPt: 216 } }, paragraph("after", "The next section remains unchanged.")] };
const project = { id: "spacer-browser-fixture", name: "Blank diagram spaces", sessionId: "spacer-browser-fixture",
  createdAt: 1, updatedAt: 1, document: "Keep this explanation exactly as written.\n\nThe next section remains unchanged.", content, chat: [] };
const selector = '.ProseMirror [data-type="labs-spacer"]';
const openLabs = async () => {
  await wait("Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Labs'||b.getAttribute('aria-label')==='Labs')");
  await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Labs'||b.getAttribute('aria-label')==='Labs').click()");
  await wait(`document.querySelector(${JSON.stringify(selector)})`);
};
const inspect = () => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),css=getComputedStyle(el);return {
  height:el.getBoundingClientRect().height,text:el.textContent,label:el.getAttribute('aria-label'),
  border:css.borderTopWidth,overflow:document.querySelector('.labs-page').scrollWidth>document.querySelector('.labs-page').clientWidth+2
};})()`);
try {
  await send("Runtime.enable"); await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `if(location.origin==='http://127.0.0.1:5178'&&!localStorage.getItem('labs_spacer_fixture')) {
    localStorage.setItem('labs_projects_global',${JSON.stringify(JSON.stringify([project]))});localStorage.setItem('labs_spacer_fixture','1');}` });
  await send("Page.navigate", { url: "http://127.0.0.1:5178" });
  await openLabs();
  const desktop = await inspect();
  assert(Math.abs(desktop.height - 288) < 1, JSON.stringify(desktop));
  assert.equal(desktop.text, ""); assert.equal(desktop.border, "0px"); assert(desktop.label);
  assert.equal(desktop.overflow, false);
  await send("Page.reload"); await openLabs();
  assert.equal((await inspect()).height, desktop.height);
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await wait("document.querySelector('.labs-segment')");
  const mobile = await inspect();
  assert.equal(mobile.height, desktop.height); assert.equal(mobile.overflow, false);
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await wait("!document.querySelector('.labs-segment')");
  const point = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.x+20,y:r.y+20};})()`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
  await wait(`document.querySelector(${JSON.stringify(selector + ".ProseMirror-selectednode")})`);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await wait(`!document.querySelector(${JSON.stringify(selector)})`);
  await wait("!JSON.parse(localStorage.getItem('labs_projects_global'))[0].content.content.some(node=>node.type==='spacer')");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: 2 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: 2 });
  await wait(`document.querySelector(${JSON.stringify(selector)})`);
  assert.equal((await inspect()).height, desktop.height);
  await wait("JSON.parse(localStorage.getItem('labs_projects_global'))[0].content.content.some(node=>node.type==='spacer')");
  const printHtml = await evaluate(`(async()=>{const {buildLabsPrintHtml}=await import('/src/utils/exportToPdf.js');
    return buildLabsPrintHtml(JSON.parse(localStorage.getItem('labs_projects_global'))[0].content);})()`);
  const paginationCases = await evaluate(`(async()=>{
    const {buildLabsPrintHtml}=await import('/src/utils/exportToPdf.js');
    return [
      {name:'baseline',fill:0,heights:[]},
      {name:'fits-current-page',fill:156,heights:[144]},
      {name:'default-gap',fill:312,heights:[144]},
      {name:'sample-large-gap',fill:312,heights:[180]},
      {name:'maximum-gap',fill:312,heights:[360]},
      {name:'fractional-gap',fill:310,heights:[212.53]},
      {name:'little-room-left',fill:358,heights:[144]},
      {name:'exact-fit',fill:216,heights:[144]},
      {name:'consecutive',fill:312,heights:[144,180]},
      {name:'consecutive-crossing',fill:144,heights:[216,180]},
      {name:'leading',fill:0,heights:[144]}
    ].map((test,index)=>{
      const marker='AFTER'+index;
      const content={type:'doc',content:[...test.heights.map(heightPt=>({type:'spacer',attrs:{heightPt}})),
        {type:'paragraph',attrs:{fontFamily:'Arial',fontSizePt:10,lineHeight:1,spaceBeforePt:0,spaceAfterPt:0},content:[{type:'text',text:marker}]}]};
      const html=buildLabsPrintHtml(content).replace('</style>',
        '@page{size:400pt 400pt;margin:20pt;@top-left{content:none}@bottom-center{content:none}}</style>')
        .replace('<body>','<body><div style="height:'+test.fill+'pt;margin:0;padding:0;border:0"></div>');
      return {...test,marker,html};
    });
  })()`);
  await send("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(printHtml)}` });
  await wait("document.querySelector('[data-type=\"labs-spacer\"]')");
  const printed = await evaluate("(()=>{const el=document.querySelector('[data-type=\"labs-spacer\"]');return {height:el.getBoundingClientRect().height,text:el.textContent,border:getComputedStyle(el).borderTopWidth};})()");
  assert.equal(printed.height, desktop.height); assert.equal(printed.text, ""); assert.equal(printed.border, "0px");
  const pdf = await send("Page.printToPDF", { printBackground: true, preferCSSPageSize: true });
  const output = join(tmpdir(), "kilo", "labs-blank-space-print.pdf");
  await writeFile(output, Buffer.from(pdf.data, "base64"));
  const locateMarker = async (html, marker) => {
    await send("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });
    await wait(`document.body?.textContent.includes(${JSON.stringify(marker)})`);
    const printed = await send("Page.printToPDF", { printBackground: true, preferCSSPageSize: true });
    const task = getDocument({ data: new Uint8Array(Buffer.from(printed.data, "base64")), verbosity: 0 });
    try {
      const pdf = await task.promise;
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number);
        const text = await page.getTextContent();
        const item = text.items.find(item => item.str === marker);
        if (item) return { page: number, y: page.view[3] - item.transform[5] };
      }
      throw new Error(`Missing printed marker ${marker}`);
    } finally { await task.destroy(); }
  };
  let baseline;
  for (const test of paginationCases) {
    const actual = await locateMarker(test.html, test.marker);
    if (test.name === "baseline") { baseline = actual.y; continue; }
    let expected = test.fill;
    for (const height of test.heights) {
      const remaining = 360 - expected % 360;
      if (height > remaining) expected += remaining;
      expected += height;
    }
    const measured = (actual.page - 1) * 360 + actual.y - baseline;
    // Chromium rounds fractional point heights to CSS-pixel layout coordinates.
    assert(Math.abs(measured - expected) < 0.8, JSON.stringify({ test: test.name, expected, measured, actual }));
    assert.equal(actual.page, Math.floor(expected / 360) + 1, `${test.name}: region must fit or move in full`);
    console.log(`PASS: PDF image-like reservation ${test.name}, expected progress ${expected.toFixed(2)}pt, rendered ${measured.toFixed(2)}pt`);
  }
  assert.deepEqual(exceptions, []);
  console.log("PASS: blank-space height, no text/border, desktop/mobile, reload, keyboard delete/undo, saved geometry and browser PDF.", output);
} finally { socket.close(); }
