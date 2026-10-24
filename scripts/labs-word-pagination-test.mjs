// Windows + installed Word only. No app build, installs, or original-document writes.
// node scripts/labs-word-pagination-test.mjs [--full] [--sample test-outputs/test2-spaces.docx]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { Packer } from "docx";
import JSZip from "jszip";

assert.equal(process.platform, "win32", "Native Microsoft Word on Windows is required");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp("C:\\Users\\hp\\AppData\\Local\\Temp\\kilo\\labs-word-pagination-");
const paragraphs = xml => [...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map(match => match[0]);
const spacing = paragraph => paragraph.match(/<w:spacing\b[^>]*\/>/)?.[0];
const attr = (xml, name) => xml?.match(new RegExp(`w:${name}="([^"]*)"`))?.[1];
const isGap = p => !/<w:(?:r|t|drawing|pict)\b/.test(p) && attr(spacing(p), "lineRule") === "exact";
// Independent OOXML control, not the exporter or a shared slicing helper.
const atomic = twips => `<w:p><w:pPr><w:keepLines/><w:keepNext w:val="false"/><w:widowControl w:val="false"/><w:spacing w:before="0" w:after="0" w:line="${twips}" w:lineRule="exact"/></w:pPr></w:p>`;
const flag = (p, name) => {
  const tag = p.match(new RegExp(`<w:${name}\\b[^>]*\\/>`))?.[0];
  assert(tag, `Missing explicit ${name}: ${p}`);
  return !["false", "0", "off"].includes(attr(tag, "val"));
};
const paragraph = text => ({ type: "paragraph", content: [{ type: "text", text }] });
const cases = [
  { name: "baseline", heights: [], remaining: null },
  { name: "fits-144", heights: [144], remaining: 240 },
  { name: "moves-144", heights: [undefined], remaining: 48 },
  ...(process.argv.includes("--full") ? [
    { name: "sample-180", heights: [180], remaining: 48 },
    { name: "maximum-360", heights: [360], remaining: 48 },
    { name: "fractional-212.53", heights: [212.53], remaining: 48 },
    { name: "exact-fit", heights: [144], remaining: 144 },
    { name: "sub-slice-room", heights: [144], remaining: 2 },
    { name: "leading", heights: [144], remaining: null },
    { name: "consecutive", heights: [144, 180], remaining: 48 }
  ] : [])
];
const entries = [];
const server = await createServer({ root: join(root, "client"), configFile: false, logLevel: "error",
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, watch: null, hmr: false } });
try {
  const { buildLabsWordDocument } = await server.ssrLoadModule("/src/utils/exportToWord.js");
  for (const test of cases) {
    test.marker = `AFTER_${test.name.replaceAll(/[^a-z0-9]/g, "_")}`;
    const content = { type: "doc", content: [
      ...(test.remaining == null ? [] : [paragraph("BOUNDARY_FILLER")]),
      ...test.heights.map(heightPt => ({ type: "spacer", attrs: heightPt == null ? {} : { heightPt } })),
      paragraph(test.marker)
    ] };
    const zip = await JSZip.loadAsync(await Packer.toBuffer(buildLabsWordDocument(content,
      { fontFamily: "Arial", fontSizePt: 10, lineHeight: 1, spaceAfterPt: 0 })));
    let xml = await zip.file("word/document.xml").async("string");
    const gaps = paragraphs(xml).filter(isGap);
    test.heightsTwips = test.heights.map(h => Math.round((h ?? 144) * 20));
    test.requestedTwips = test.heightsTwips.reduce((sum, h) => sum + h, 0);
    assert.equal(gaps.length, test.heights.length, `${test.name}: each full gap must be ONE paragraph, with no fragments`);
    assert.deepEqual(gaps.map(p => Number(attr(spacing(p), "line"))), test.heightsTwips, `${test.name}: unchanged exact height, including fractional twips rounding`);
    assert.equal(paragraphs(xml).length, test.heights.length + (test.remaining == null ? 1 : 2), `${test.name}: no extra body paragraphs`);
    for (const p of gaps) {
      assert.equal(attr(spacing(p), "before"), "0");
      assert.equal(attr(spacing(p), "after"), "0");
      assert.equal(flag(p, "keepLines"), true);
      assert.equal(flag(p, "keepNext"), false);
      assert.equal(flag(p, "widowControl"), false);
      assert.doesNotMatch(p, /<w:(?:r|t|drawing|pict|pBdr|shd|br)\b/, `${test.name}: blank region has no text, drawing, border, shading or breaks`);
    }
    const page = xml.match(/<w:pgSz\b[^>]*\/>/)[0];
    const margin = xml.match(/<w:pgMar\b[^>]*\/>/)[0];
    test.bodyPt = (Number(attr(page, "h")) - Number(attr(margin, "top")) - Number(attr(margin, "bottom"))) / 20;
    test.fillPt = test.remaining == null ? 0 : Math.round((test.bodyPt - test.remaining) * 20) / 20;
    // Deterministic boundary setup only. Exported spacers, styles, header/footer and page geometry stay untouched.
    if (test.fillPt) {
      const filler = paragraphs(xml).find(p => p.includes("BOUNDARY_FILLER"));
      xml = xml.replace(filler, filler.replace(spacing(filler), `<w:spacing w:before="0" w:after="0" w:line="${Math.round(test.fillPt * 20)}" w:lineRule="exact"/>`));
    }
    assert.deepEqual(paragraphs(xml).filter(isGap), gaps, "Boundary setup must not change exported gaps");
    const path = join(output, `${test.name}-current.docx`);
    zip.file("word/document.xml", xml);
    await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
    entries.push({ id: test.name, variant: "current", path, marker: test.marker });
    if (gaps.length) {
      // Only the region changes; text, styles, geometry and headers/footers stay identical.
      const joined = gaps.join("");
      assert(xml.includes(joined), "Fixture gaps must be consecutive");
      const controlXml = xml.replace(joined, test.heightsTwips.map(atomic).join(""));
      const controlPath = join(output, `${test.name}-atomic.docx`);
      zip.file("word/document.xml", controlXml);
      await writeFile(controlPath, await zip.generateAsync({ type: "nodebuffer" }));
      entries.push({ id: test.name, variant: "atomic", path: controlPath, marker: test.marker });
      if (test.name === "moves-144") {
        // Negative control: old 6pt fragments consume the preceding page's tail.
        const split = Array.from({ length: test.requestedTwips / 120 }, () => atomic(120).replace("<w:keepLines/>", '<w:keepLines w:val="false"/>')).join("");
        const splitPath = join(output, `${test.name}-split-control.docx`);
        zip.file("word/document.xml", xml.replace(joined, split));
        await writeFile(splitPath, await zip.generateAsync({ type: "nodebuffer" }));
        entries.push({ id: test.name, variant: "split-control", path: splitPath, marker: test.marker });
      }
    }
  }
} finally { await server.close(); }

let sample;
const sampleIndex = process.argv.indexOf("--sample");
if (sampleIndex !== -1) {
  assert(process.argv[sampleIndex + 1], "--sample needs a DOCX path");
  const source = resolve(process.argv[sampleIndex + 1]);
  const bytes = await readFile(source);
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml").async("string");
  const gaps = paragraphs(xml).filter(p => isGap(p) && [2880, 3600].includes(Number(attr(spacing(p), "line"))) && /<w:keepLines\s*\/>/.test(p));
  assert(gaps.length > 0, "Sample has no original atomic empty 144/180pt spacers");
  const path = join(output, "sample-original-atomic.docx");
  await writeFile(path, bytes);
  assert.deepEqual(await readFile(path), bytes, "Sample temp copy must be byte-identical, not patched");
  sample = { source, sha256: createHash("sha256").update(bytes).digest("hex"), atomicSpacers: gaps.length,
    totalTwips: gaps.reduce((sum, p) => sum + Number(attr(spacing(p), "line")), 0) };
  entries.push({ id: "sample", variant: "original-atomic", path });
}

const manifest = join(output, "manifest.json");
await writeFile(manifest, JSON.stringify({ entries, cases, sample }, null, 2));
console.log(`Artifacts: ${output}`);
const script = join(root, "scripts", "labs-word-pagination-test.ps1");
const run = (args, timeoutMs) => new Promise((resolveRun, reject) => {
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args], { stdio: "inherit" });
  // The watchdog verifies Word's PID AND creation ticks from the worker's ownership receipt.
  const timer = setTimeout(async () => {
    if (!args.includes("-Cleanup")) {
      try { await run(["-Manifest", manifest, "-Cleanup"], 15000); } catch {}
    }
    child.kill();
    reject(new Error(`Native Word exceeded ${timeoutMs / 1000}s; owned-instance cleanup requested`));
  }, timeoutMs);
  child.on("error", error => { clearTimeout(timer); reject(error); });
  child.on("exit", code => { clearTimeout(timer); code === 0 ? resolveRun() : reject(new Error(`Word worker exited ${code}`)); });
});
try { await run(["-Manifest", manifest], 120000); }
finally {
  try { await run(["-Manifest", manifest, "-Cleanup"], 15000); }
  finally {
    if (sample) assert.equal(createHash("sha256").update(await readFile(sample.source)).digest("hex"), sample.sha256, "Original sample changed");
  }
}
const results = JSON.parse((await readFile(join(output, "word-results.json"), "utf8")).replace(/^\uFEFF/, ""));
const baseline = results.entries.find(e => e.id === "baseline").marker;
const measured = [];
for (const test of cases.filter(t => t.heights.length)) {
  const current = results.entries.find(e => e.id === test.name && e.variant === "current");
  const control = results.entries.find(e => e.id === test.name && e.variant === "atomic");
  const distance = entry => (entry.marker.page - 1) * test.bodyPt + entry.marker.yPt - baseline.yPt;
  const actualPt = distance(current);
  const atomicPt = distance(control);
  let page = 1;
  let cursorPt = test.fillPt;
  for (const heightTwips of test.heightsTwips) {
    const heightPt = heightTwips / 20;
    if (cursorPt + heightPt > test.bodyPt + 0.025) { page++; cursorPt = 0; }
    cursorPt += heightPt;
  }
  // Exact-fit consumes the last line of the page; following text starts on the next.
  if (cursorPt >= test.bodyPt - 0.025) { page++; cursorPt = 0; }
  const expectedPt = (page - 1) * test.bodyPt + cursorPt;
  const split = results.entries.find(e => e.id === test.name && e.variant === "split-control");
  const row = { name: test.name, expectedPt, actualPt, atomicPt, modeledMarker: { page, yPt: baseline.yPt + cursorPt },
    currentMarker: current.marker, atomicMarker: control.marker, fullGapParagraphs: test.heights.length,
    ...(split ? { splitMarker: split.marker, atomicVsSplitPt: actualPt - distance(split) } : {}) };
  measured.push(row);
  console.log(JSON.stringify(row));
}
await writeFile(join(output, "summary.json"), JSON.stringify({ word: results.word, measured, sample, entries: results.entries }, null, 2));
// Write all evidence before assertions so unexpected native layout remains diagnosable.
for (const row of measured) {
  assert.equal(row.currentMarker.page, row.modeledMarker.page, `${row.name}: atomic modeled page`);
  assert.equal(row.currentMarker.page, row.atomicMarker.page, `${row.name}: current/control page parity`);
  assert(Math.abs(row.currentMarker.yPt - row.atomicMarker.yPt) <= 0.15, `${row.name}: current must match independent atomic control`);
  assert(Math.abs(row.actualPt - row.expectedPt) <= 1.1, `${row.name}: unchanged atomic height (${JSON.stringify(row)})`);
  if (row.name === "moves-144") {
    assert.equal(row.currentMarker.page, 2);
    assert(Math.abs(row.currentMarker.yPt - baseline.yPt - 144) <= 0.15, "48pt left: entire 144pt region must begin on page 2");
    assert(row.atomicVsSplitPt >= 46 && row.atomicVsSplitPt <= 49, "Atomic marker must be about 47pt later than the incorrect split control");
  }
}
if (sample) {
  const original = results.entries.find(e => e.id === "sample" && e.variant === "original-atomic");
  assert(original.pages > 0, "Read-only original atomic sample paginated");
  console.log(`Sample: ${original.pages} pages; ${sample.atomicSpacers} original atomic spacers intact; no patch; original SHA-256 unchanged (${sample.sha256})`);
}
console.log(`PASS: ${measured.length} native Word atomic spacer cases, one full-height paragraph per gap, exact XML heights, atomic parity, split negative control; owned-instance cleanup completed. ${output}`);
