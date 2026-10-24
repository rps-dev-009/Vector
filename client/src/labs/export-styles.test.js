import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { Packer } from "docx";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import { buildLabsWordDocument, exportToWord } from "../utils/exportToWord.js";
import { buildLabsPrintHtml, exportToPdf } from "../utils/exportToPdf.js";
import { createLabsExportModel, safeLink } from "../utils/labsExportModel.js";
import { STYLE_SPEC, resolveBlockStyle, resolveDocumentStyle } from "./styles.js";

vi.mock("html2canvas", () => ({ default: vi.fn() }));
vi.mock("jspdf", () => ({ default: vi.fn() }));

const text = (value, marks) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const paragraph = (value, attrs = {}) => ({ type: "paragraph", attrs, content: typeof value === "string" ? [text(value)] : value });
const heading = (value, level = 1) => ({ type: "heading", attrs: { level }, content: [text(value)] });
const item = (...content) => ({ type: "listItem", content });
const cell = (value, header = false, attrs = {}) => ({ type: header ? "tableHeader" : "tableCell", attrs, content: [paragraph(value)] });
const row = (...content) => ({ type: "tableRow", content });
const doc = (content, documentStyle = {}) => ({ type: "doc", attrs: { documentStyle }, content });
const marked = text('Rich <text> & "quotes" **literal**', [
    { type: "bold" }, { type: "italic" }, { type: "underline" }, { type: "strike" },
    { type: "textStyle", attrs: { color: "purple", backgroundColor: "yellow", fontSize: "20px", fontFamily: "Georgia" } },
    { type: "link", attrs: { href: "https://example.com/report?q=one&mode=two" } }
]);
const fixture = () => doc([
    ...Array.from({ length: 6 }, (_, index) => heading(`Heading ${index + 1}`, index + 1)),
    paragraph([marked, { type: "hardBreak" }, text("Highlighted", [{ type: "highlight", attrs: { color: "#abc" } }])], {
        fontFamily: "Cambria", fontSizePt: 13, lineHeight: 1.8, spaceBeforePt: 5, spaceAfterPt: 12, textAlign: "justify"
    }),
    { type: "orderedList", attrs: { start: 3, textColor: "green" }, content: [
        item(paragraph("First"), { type: "bulletList", content: [
            item(paragraph([text("Nested", [{ type: "italic" }])]), { type: "orderedList", attrs: { start: 7 }, content: [item(paragraph("Deep"))] })
        ] }, paragraph("Continuation")), item(paragraph("Second"))
    ] },
    { type: "taskList", content: [ { type: "taskItem", attrs: { checked: true }, content: [paragraph("Complete")] } ] },
    { type: "blockquote", content: [paragraph("Quotation"), paragraph("Quote continuation")] },
    { type: "codeBlock", content: [text('const x = "<safe>";\nnext();')] },
    { type: "table", content: [
        row(cell("Label", true), cell("Value", true)),
        row(cell([text("Cell link", [{ type: "link", attrs: { href: "mailto:test@example.com" } }])]), cell("42")),
        row({ ...cell("More"), content: [paragraph("More"), paragraph([text("Cell italic", [{ type: "italic" }])])] }, cell("84"))
    ] },
    { type: "horizontalRule" }, paragraph("")
], { preset: "editorial", fontFamily: "Calibri", fontSizePt: 12, lineHeight: 1.6, spaceAfterPt: 11, marginMm: 24 });

const parseXml = value => new DOMParser().parseFromString(value, "application/xml");
const tags = (node, name) => [...node.getElementsByTagName(`w:${name}`)];
const attr = (node, name) => node?.getAttribute(`w:${name}`);
const wordText = node => tags(node, "t").map(t => t.textContent).join("");
const wordParagraph = (xml, value) => tags(xml, "p").find(p => wordText(p) === value);
const parseHtml = value => new DOMParser().parseFromString(value, "text/html");
async function unpack(content, style) {
    const buffer = await Packer.toBuffer(buildLabsWordDocument(content, style));
    const zip = await JSZip.loadAsync(buffer);
    const read = async path => zip.file(path).async("string");
    return {
        document: parseXml(await read("word/document.xml")),
        styles: parseXml(await read("word/styles.xml")),
        numbering: parseXml(await read("word/numbering.xml")),
        relationships: await read("word/_rels/document.xml.rels"),
        header: await read("word/header1.xml"),
        footer: await read("word/footer1.xml")
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.replaceChildren();
});

describe("Labs rich export model", () => {
    it("keeps canonical runs literal and immutable instead of reparsing Markdown", () => {
        const input = fixture();
        const before = JSON.stringify(input);
        const model = createLabsExportModel(input);
        const run = model.elements[6].runs[0];
        expect(run).toMatchObject({ text: marked.text, bold: true, italic: true, underline: true, strike: true,
            color: "#7E22CE", backgroundColor: "#FEF9C3", fontFamily: "Georgia", fontSizePt: 15,
            href: "https://example.com/report?q=one&mode=two" });
        expect(model.elements[6].attrs.align).toBe("justify");
        expect(JSON.stringify(input)).toBe(before);
    });

    it("uses the existing bridge only for block fallback and gives content precedence", () => {
        const blocks = [
            { type: "paragraph", text: "**Bold** and ~~strike~~", attrs: { fontFamily: "Cambria", spaceAfterPt: 18 } },
            { type: "bulletList", text: "- Parent\n  - *Nested*", attrs: {} },
            { type: "table", text: "| Head |\n| --- |\n| **Cell** |", attrs: { tableVariant: "grid" } }
        ];
        const model = createLabsExportModel(null, { preset: "academic" }, blocks);
        expect(model.elements[0].runs[0]).toMatchObject({ text: "Bold", bold: true });
        expect(model.elements[0].attrs).toMatchObject({ fontFamily: "Cambria", spaceAfterPt: 18 });
        expect(model.elements[1].children[0].children[1].children[0].children[0].runs[0].italic).toBe(true);
        expect(model.elements[2].children[1].children[0].children[0].runs[0].bold).toBe(true);
        expect(createLabsExportModel(doc([paragraph("Canonical")]), undefined, blocks).elements).toHaveLength(1);
        expect(() => createLabsExportModel({ type: "paragraph" })).toThrow("Tiptap document");
    });

    it.each(["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "//example.com", "https://example.com/\ninjection"])("rejects unsafe links: %s", value => {
        expect(safeLink(value)).toBeNull();
    });
});

describe("Labs DOCX", () => {
    it("shortens only the running header, never the actual title", async () => {
        const title = "Principles and Practices of Training and Pruning in Fruit Crops: An Undergraduate Horticulture Assignment";
        const input = doc([heading(title), paragraph("Body")]);
        const xml = await unpack(input);
        expect(wordText(xml.document)).toContain(title);
        expect(wordText(parseXml(xml.header)).length).toBeLessThanOrEqual(80);
        expect(wordText(parseXml(xml.header))).toMatch(/\.\.\.$/);
        const html = parseHtml(buildLabsPrintHtml(input));
        expect(html.querySelector("h1").textContent).toBe(title);
        expect(html.querySelector("style").textContent).not.toContain(title);
    });

    it("retains pasted RGB colors in both export formats", async () => {
        const input = doc([paragraph([text("Colored", [{ type: "textStyle", attrs: { color: "rgb(33, 79, 97)" } }])])]);
        const xml = await unpack(input);
        expect(attr(tags(wordParagraph(xml.document, "Colored"), "color")[0], "val")).toBe("214F61");
        expect(buildLabsPrintHtml(input)).toContain("color:#214F61");
    });

    it("packs A4, named semantic styles, exact units, local fonts, running header and page footer", async () => {
        const xml = await unpack(fixture());
        expect(xml.document.querySelector("parsererror")).toBeNull();
        const size = tags(xml.document, "pgSz")[0];
        expect([attr(size, "w"), attr(size, "h")]).toEqual(["11906", "16838"]);
        const margin = tags(xml.document, "pgMar")[0];
        expect(["top", "right", "bottom", "left"].map(key => attr(margin, key))).toEqual(Array(4).fill("1361"));
        expect(attr(tags(xml.styles, "rFonts")[0], "ascii")).toBe("Calibri");
        const bodyStyle = tags(xml.styles, "style").find(style => attr(style, "styleId") === "LabsBody");
        expect(attr(tags(bodyStyle, "sz")[0], "val")).toBe("24");
        expect(attr(tags(bodyStyle, "spacing")[0], "line")).toBe("384");
        for (let level = 1; level <= 6; level++) {
            const p = wordParagraph(xml.document, `Heading ${level}`);
            expect(attr(tags(p, "pStyle")[0], "val")).toBe(`Heading${level}`);
            expect(attr(tags(p, "outlineLvl")[0], "val")).toBe(String(level - 1));
            expect(tags(p, "keepNext")).toHaveLength(1);
        }
        const rich = wordParagraph(xml.document, `${marked.text}Highlighted`);
        const spacing = tags(rich, "spacing")[0];
        expect(["before", "after", "line", "lineRule"].map(key => attr(spacing, key))).toEqual(["100", "240", "432", "auto"]);
        expect(attr(tags(rich, "jc")[0], "val")).toBe("both");
        expect(xml.header).toContain("Heading 1");
        expect(xml.footer).toContain("PAGE");
        expect(xml.footer).toContain("LabsRunningText");
    });

    it("retains rich marks, literal text, hyperlinks, nested lists and all table paragraphs", async () => {
        const xml = await unpack(fixture());
        const rich = wordParagraph(xml.document, `${marked.text}Highlighted`);
        const run = tags(rich, "r").find(run => wordText(run) === marked.text);
        for (const mark of ["b", "i", "u", "strike"]) expect(tags(run, mark)).toHaveLength(1);
        expect(attr(tags(run, "color")[0], "val")).toBe("7E22CE");
        expect(attr(tags(run, "sz")[0], "val")).toBe("30");
        expect(attr(tags(run, "rFonts")[0], "ascii")).toBe("Georgia");
        expect(attr(tags(run, "shd")[0], "fill")).toBe("FEF9C3");
        expect(tags(rich, "br")).toHaveLength(1);
        expect(tags(rich, "hyperlink")).toHaveLength(1);
        expect(xml.relationships).toContain('Target="https://example.com/report?q=one&amp;mode=two"');
        expect(xml.relationships).toContain('Target="mailto:test@example.com"');
        expect(attr(tags(wordParagraph(xml.document, "First"), "ilvl")[0], "val")).toBe("0");
        expect(attr(tags(wordParagraph(xml.document, "Nested"), "ilvl")[0], "val")).toBe("1");
        expect(attr(tags(wordParagraph(xml.document, "Deep"), "ilvl")[0], "val")).toBe("2");
        expect(tags(wordParagraph(xml.document, "Continuation"), "numPr")).toHaveLength(0);
        expect(tags(xml.numbering, "start").map(node => attr(node, "val"))).toContain("7");
        expect(wordText(xml.document)).toContain("Cell italic");
        expect(tags(wordParagraph(xml.document, "Cell italic"), "i")).toHaveLength(1);
        expect(wordText(xml.document)).toContain('const x = "<safe>";next();');
    });

    it("emits solid theme fills, repeated headers, unsplit rows, padding and table borders", async () => {
        const xml = await unpack(fixture());
        const table = tags(xml.document, "tbl")[0];
        const rows = tags(table, "tr");
        expect(tags(rows[0], "tblHeader")).toHaveLength(1);
        expect(tags(rows[1], "tblHeader").every(node => attr(node, "val") === "false")).toBe(true);
        expect(tags(table, "cantSplit")).toHaveLength(3);
        const header = tags(rows[0], "tc")[0];
        const shade = tags(header, "shd")[0];
        expect(["val", "fill", "color"].map(key => attr(shade, key))).toEqual(["clear", "214F61", "auto"]);
        expect(attr(tags(header, "color")[0], "val")).toBe("FFFFFF");
        expect(attr(tags(tags(header, "tcMar")[0], "left")[0], "w")).toBe("160");
        expect(attr(tags(tags(header, "tcBorders")[0], "top")[0], "color")).toBe("D8E5E8");
        expect(attr(tags(tags(rows[2], "tc")[0], "shd")[0], "fill")).toBe("F0F6F7");
    });

    it.each(Object.keys(STYLE_SPEC.presets))("resolves the %s theme identically for both formats", async preset => {
        const input = doc([heading("Theme"), paragraph("Body"), { type: "table", content: [row(cell("Head", true)), row(cell("Data"))] }], { preset });
        const theme = resolveDocumentStyle({ preset });
        const xml = await unpack(input);
        const html = parseHtml(buildLabsPrintHtml(input));
        expect(attr(tags(wordParagraph(xml.document, "Theme"), "color")[0], "val")).toBe(theme.accent.slice(1));
        expect(html.querySelector("h1").getAttribute("style")).toContain(`color:${theme.accent}`);
        expect(html.querySelector("th").getAttribute("style")).toContain(`background-color:${theme.tableHeaderBackground}`);
        expect(attr(tags(tags(xml.document, "tc")[0], "shd")[0], "fill")).toBe(theme.tableHeaderBackground.slice(1));
    });

    it.each(["striped", "grid", "minimal"])("preserves the %s table variant and explicit shared colors", async tableVariant => {
        const attrs = { tableVariant, tableHeaderBackground: "purple", tableHeaderColor: "white", tableAlternateBackground: "yellow", tableBorderColor: "green", tableCellPaddingPt: 12 };
        const input = doc([{ type: "table", attrs, content: [row(cell("Head", true)), row(cell("One")), row(cell("Two"))] }]);
        const xml = await unpack(input);
        const html = parseHtml(buildLabsPrintHtml(input));
        const table = tags(xml.document, "tbl")[0];
        const rows = tags(table, "tr");
        expect(attr(tags(rows[0], "shd")[0], "fill")).toBe("7E22CE");
        expect(attr(tags(rows[2], "shd")[0], "fill")).toBe(tableVariant === "striped" ? "FEF9C3" : "FFFFFF");
        const borders = tags(tags(table, "tc")[0], "tcBorders")[0];
        // Only grid tables have vertical rules; striped/minimal stay lighter.
        expect(attr(tags(borders, "left")[0], "val")).toBe(tableVariant === "grid" ? "single" : "nil");
        expect(attr(tags(borders, "bottom")[0], "color")).toBe("15803D");
        expect(html.querySelector("th").getAttribute("style")).toContain("padding:12pt");
        expect(html.querySelector("tbody tr:last-child td").getAttribute("style")).toContain(`background-color:${tableVariant === "striped" ? "#FEF9C3" : "#FFFFFF"}`);
    });

    it("preserves merged cells and nested rich list content inside a table", async () => {
        const input = doc([{ type: "table", content: [
            row(cell("Spanning rows", false, { rowspan: 2 }), cell("Spanning columns", false, { colspan: 2 })),
            row({ type: "tableCell", content: [{ type: "bulletList", content: [item(paragraph([marked]))] }] }, cell("Last"))
        ] }]);
        const xml = await unpack(input);
        const page = parseHtml(buildLabsPrintHtml(input));
        expect(tags(xml.document, "vMerge").map(node => attr(node, "val"))).toContain("restart");
        expect(tags(xml.document, "vMerge").map(node => attr(node, "val"))).toContain("continue");
        expect(tags(xml.document, "gridSpan").map(node => attr(node, "val"))).toContain("2");
        expect(page.querySelector('[rowspan="2"]').textContent).toBe("Spanning rows");
        expect(page.querySelector('[colspan="2"]').textContent).toBe("Spanning columns");
        expect(page.querySelector("td ul a").textContent).toBe(marked.text);
        expect(wordText(xml.document)).toContain(marked.text);
    });

    it("honors explicit document style over root metadata without changing body text", async () => {
        const input = doc([paragraph("Unchanged")], { preset: "editorial", fontFamily: "Arial" });
        const xml = await unpack(input, { preset: "academic", fontFamily: "Verdana", fontSizePt: 14, lineHeight: 2, marginMm: 18 });
        expect(attr(tags(wordParagraph(xml.document, "Unchanged"), "rFonts")[0], "ascii")).toBe("Verdana");
        expect(attr(tags(wordParagraph(xml.document, "Unchanged"), "sz")[0], "val")).toBe("28");
        expect(attr(tags(wordParagraph(xml.document, "Unchanged"), "spacing")[0], "line")).toBe("480");
        expect(attr(tags(xml.document, "pgMar")[0], "top")).toBe("1020");
        expect(wordText(xml.document)).toBe("Unchanged");
    });

    it("builds valid empty documents", async () => {
        const xml = await unpack(doc([]));
        expect(tags(xml.document, "p")).toHaveLength(1);
        expect(wordText(xml.document)).toBe("");
        expect(parseHtml(buildLabsPrintHtml(doc([]))).body.textContent).toBe("");
    });

    it("keeps heading typography inside containers and constrains nested tables to their cells", async () => {
        const input = doc([
            { type: "blockquote", content: [heading("Nested heading", 2)] },
            { type: "table", content: [row({ type: "tableCell", content: [
                { type: "table", content: [row(cell("Nested cell"))] }
            ] }, cell("Sibling"))] }
        ]);
        const xml = await unpack(input);
        const expected = resolveBlockStyle("heading", { level: 2 });
        const p = wordParagraph(xml.document, "Nested heading");
        expect(attr(tags(p, "sz")[0], "val")).toBe(String(expected.fontSizePt * 2));
        expect(parseHtml(buildLabsPrintHtml(input)).querySelector("blockquote h2").getAttribute("style")).toContain(`font-size:${expected.fontSizePt}pt`);
        const [outer, inner] = tags(xml.document, "tbl");
        const outerCellWidth = Number(attr(tags(outer, "tcW")[0], "w"));
        expect(Number(attr(tags(inner, "tblW")[0], "w"))).toBe(outerCellWidth - 320);
        expect(wordText(inner)).toBe("Nested cell");
    });
});

describe("Labs print HTML", () => {
    it("uses selectable semantic HTML, print pagination, local fallback fonts and shared styles", () => {
        const html = buildLabsPrintHtml(fixture());
        const page = parseHtml(html);
        expect(page.querySelector("canvas,img,script,link")).toBeNull();
        expect(page.querySelector("p a strong").textContent).toBe(marked.text);
        expect(page.querySelector("p a em")).not.toBeNull();
        expect(page.querySelector("p a u")).not.toBeNull();
        expect(page.querySelector("p a s")).not.toBeNull();
        expect(page.querySelector("p a").getAttribute("href")).toBe("https://example.com/report?q=one&mode=two");
        expect(page.querySelector("ol").getAttribute("start")).toBe("3");
        expect(page.querySelector("ol > li > ul > li > ol").getAttribute("start")).toBe("7");
        expect(page.querySelectorAll("thead th")).toHaveLength(2);
        expect(page.querySelectorAll("tbody tr:last-child td:first-child p")).toHaveLength(2);
        expect(page.querySelector("pre").textContent).toBe('const x = "<safe>";next();');
        expect(html).toContain("size:A4; margin:24mm");
        expect(html).toContain("break-after:avoid-page");
        expect(html).toContain("page-break-inside:avoid");
        expect(html).toContain("display:table-header-group");
        expect(html).toContain("@bottom-center { content:counter(page)");
        expect(html).toContain('"Calibri", "Segoe UI", Arial, sans-serif');
        expect(html).toContain("print-color-adjust:exact");
    });

    it("uses the shared resolver for named block colors and document overrides", () => {
        const attrs = { backgroundColor: "black", tableHeaderBackground: "orange", tableAlternateBackground: "green", tableCellPaddingPt: 12 };
        const input = doc([paragraph("White on dark", { backgroundColor: "black" }), { type: "table", attrs, content: [row(cell("Header", true))] }]);
        const expected = resolveBlockStyle("table", attrs, { preset: "botanical" });
        const page = parseHtml(buildLabsPrintHtml(input, { preset: "botanical", marginMm: 18 }));
        expect(page.querySelector("p").getAttribute("style")).toContain("color:#FFFFFF;background-color:#111827");
        expect(page.querySelector("th").getAttribute("style")).toContain(`background-color:${expected.tableHeaderBackground}`);
        expect(page.querySelector("th").getAttribute("style")).toContain("padding:12pt");
        expect(page.head.textContent).toContain("margin:18mm");
    });

    it("keeps legacy dark table backgrounds on the header and readable theme ink on body cells", async () => {
        const input = doc([{ type: "table", attrs: { backgroundColor: "black" }, content: [row(cell("Head", true)), row(cell("Body"))] }]);
        const page = parseHtml(buildLabsPrintHtml(input));
        const xml = await unpack(input);
        expect(page.querySelector("th").getAttribute("style")).toContain("color:#FFFFFF;background-color:#111827");
        expect(page.querySelector("td").getAttribute("style")).toContain("color:#263342;background-color:#FFFFFF");
        expect(attr(tags(wordParagraph(xml.document, "Body"), "color")[0], "val")).toBe("263342");
    });

    it("escapes text, title, links and CSS attributes without loading arbitrary resources", async () => {
        const unsafe = '</style><script>alert("x")</script><img src="https://evil.example/tracker">';
        const input = doc([
            heading(unsafe),
            paragraph([text(unsafe, [
                { type: "link", attrs: { href: "javascript:alert(1)" } },
                { type: "textStyle", attrs: { fontFamily: 'Arial";background:url(https://evil.example)', color: "red;background:url(x)", fontSize: "12pt;display:none" } }
            ])], { backgroundColor: 'url("https://evil.example")', textColor: "constructor" }),
            paragraph([text("Safe link", [{ type: "link", attrs: { href: 'https://example.com/?q=" onmouseover="evil' } }])]),
            { type: "image", attrs: { src: "https://evil.example/image", alt: "Image description" } }
        ]);
        const html = buildLabsPrintHtml(input, undefined, undefined, unsafe);
        const page = parseHtml(html);
        expect(page.querySelector("script,img,iframe,link")).toBeNull();
        expect(page.querySelector("a")).toBeNull();
        expect(page.querySelector("h1").textContent).toBe(unsafe);
        expect(page.title).toBe(unsafe);
        expect(page.body.textContent).toContain("Image description");
        expect(html).not.toContain("background:url");
        expect(page.querySelector('meta[http-equiv="Content-Security-Policy"]').content).toContain("default-src 'none'");
        const xml = await unpack(input);
        expect(xml.relationships).not.toContain("javascript:");
        expect(wordText(xml.document)).toContain(unsafe);
    });
});

describe("export routing and print lifecycle", () => {
    it("retains the legacy Chat Word builder when no Labs content or blocks are supplied", async () => {
        let built;
        vi.spyOn(Packer, "toBlob").mockImplementation(async value => { built = value; return new Blob(); });
        vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: vi.fn(() => "blob:word"), revokeObjectURL: vi.fn() }));
        vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
        await exportToWord("# Chat\n\n**Bold** paragraph", "chat");
        const zip = await JSZip.loadAsync(await Packer.toBuffer(built));
        const xml = await zip.file("word/document.xml").async("string");
        expect(xml).toContain("Chat");
        expect(xml).toContain("Calibri");
        expect(xml).not.toContain("LabsBody");
    });

    it("retains Chat screenshot PDF export and cleans its temporary container", async () => {
        vi.useFakeTimers();
        const save = vi.fn();
        html2canvas.mockResolvedValue({ width: 210, height: 300, toDataURL: () => "data:image/png,test" });
        jsPDF.mockImplementation(function () { return { addImage: vi.fn(), addPage: vi.fn(), save }; });
        const exporting = exportToPdf("# Chat", "chat");
        await vi.advanceTimersByTimeAsync(100);
        await exporting;
        expect(html2canvas).toHaveBeenCalled();
        expect(save).toHaveBeenCalledWith("chat.pdf");
        expect(document.body.children).toHaveLength(0);
    });

    it("waits for load and fonts, opens native print, and retains the iframe until afterprint", async () => {
        let resolveFonts;
        const ready = new Promise(resolve => { resolveFonts = resolve; });
        const exporting = exportToPdf("ignored", "Report", { content: fixture() });
        const frame = document.querySelector("iframe");
        expect(frame.srcdoc).toContain("<title>Report</title>");
        Object.defineProperty(frame.contentDocument, "fonts", { value: { ready }, configurable: true });
        const print = vi.spyOn(frame.contentWindow, "print").mockImplementation(() => {});
        vi.spyOn(frame.contentWindow, "focus").mockImplementation(() => {});
        frame.dispatchEvent(new Event("load"));
        await Promise.resolve();
        expect(print).not.toHaveBeenCalled();
        resolveFonts();
        expect(await exporting).toEqual({ mode: "print" });
        expect(print).toHaveBeenCalledOnce();
        expect(frame.isConnected).toBe(true);
        frame.contentWindow.dispatchEvent(new Event("afterprint"));
        expect(frame.isConnected).toBe(false);
    });

    it("propagates print errors and removes failed frames", async () => {
        const exporting = exportToPdf("ignored", "Report", { blocks: [{ type: "paragraph", text: "Block fallback" }] });
        const frame = document.querySelector("iframe");
        vi.spyOn(frame.contentWindow, "focus").mockImplementation(() => {});
        vi.spyOn(frame.contentWindow, "print").mockImplementation(() => { throw new Error("Print denied"); });
        frame.dispatchEvent(new Event("load"));
        await expect(exporting).rejects.toThrow("Print denied");
        expect(frame.isConnected).toBe(false);
    });

    it("propagates loading errors and never attempts a screenshot fallback", async () => {
        html2canvas.mockClear();
        const exporting = exportToPdf("ignored", "Report", { content: doc([]) });
        const frame = document.querySelector("iframe");
        frame.dispatchEvent(new Event("error"));
        await expect(exporting).rejects.toThrow("could not be loaded");
        expect(frame.isConnected).toBe(false);
        expect(html2canvas).not.toHaveBeenCalled();
    });

    it("times out stalled font loading and removes the frame", async () => {
        vi.useFakeTimers();
        const exporting = exportToPdf("ignored", "Report", { content: doc([]) });
        const rejected = expect(exporting).rejects.toThrow("timed out");
        const frame = document.querySelector("iframe");
        Object.defineProperty(frame.contentDocument, "fonts", { value: { ready: new Promise(() => {}) }, configurable: true });
        frame.dispatchEvent(new Event("load"));
        await vi.advanceTimersByTimeAsync(15000);
        await rejected;
        expect(frame.isConnected).toBe(false);
    });
});
