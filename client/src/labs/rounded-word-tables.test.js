import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Packer } from "docx";
import JSZip from "jszip";
import html2canvas from "html2canvas";
import { buildLabsWordDocument } from "../utils/exportToWord.js";
import { renderRoundedWordTables, tablePanelRows } from "../utils/roundedWordTables.js";
import ExportDialog from "./ExportDialog.jsx";

vi.mock("html2canvas", () => ({ default: vi.fn() }));
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZAAAAABJRU5ErkJggg==";
const paragraph = text => ({ type: "paragraph", content: [{ type: "text", text }] });
const table = { type: "table", content: [
    { type: "tableRow", content: [{ type: "tableHeader", content: [paragraph("Method")] }] },
    { type: "tableRow", content: [{ type: "tableCell", content: [paragraph("T-budding")] }] }
] };
const content = { type: "doc", content: [paragraph("Editable introduction"), table, paragraph("Editable conclusion")] };
const panel = { data: png, width: 500, height: 120, alt: "Method | T-budding" };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); document.body.replaceChildren(); });

describe("Word table modes", () => {
    it("keeps native tables as the default", async () => {
        const zip = await JSZip.loadAsync(await Packer.toBuffer(buildLabsWordDocument(content)));
        const xml = await zip.file("word/document.xml").async("string");
        expect(xml).toContain("<w:tbl>");
        expect(xml).not.toContain("<w:drawing>");
        expect(xml).toContain("T-budding");
    });

    it("embeds only rounded table panels as PNGs while keeping surrounding text editable", async () => {
        const before = JSON.stringify(content);
        const zip = await JSZip.loadAsync(await Packer.toBuffer(buildLabsWordDocument(content, undefined, undefined, [[panel]])));
        const xml = await zip.file("word/document.xml").async("string");
        expect(xml).not.toContain("<w:tbl>");
        expect(xml).toContain("<w:drawing>");
        expect(xml).toContain("Editable introduction");
        expect(xml).toContain("Editable conclusion");
        expect(xml).toContain('descr="Method | T-budding"');
        expect(Object.keys(zip.files).some(name => /^word\/media\/.+\.png$/.test(name))).toBe(true);
        expect(JSON.stringify(content)).toBe(before);
    });

    it("puts continuation panels on new pages without scaling the table text down", async () => {
        const zip = await JSZip.loadAsync(await Packer.toBuffer(buildLabsWordDocument(content, undefined, undefined, [[panel, panel]])));
        const xml = await zip.file("word/document.xml").async("string");
        expect(xml.match(/<w:drawing>/g)).toHaveLength(2);
        expect(xml.match(/<w:pageBreakBefore\/?/g)).toHaveLength(1);
        expect(xml).toContain('cx="4762500"'); // 500 CSS px at 9525 EMU/px
    });

    it("refuses missing or mismatched table panels instead of dropping content", () => {
        expect(() => buildLabsWordDocument(content, undefined, undefined, [])).toThrow("missing");
        expect(() => buildLabsWordDocument(content, undefined, undefined, [[panel], [panel]])).toThrow("does not match");
    });

    it("exposes both modes and requires an explicit choice for rounded image tables", async () => {
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
        const host = document.createElement("div"); document.body.append(host);
        const root = createRoot(host);
        const onExportWord = vi.fn();
        try {
            await act(async () => root.render(React.createElement(ExportDialog, { open: true, onClose: vi.fn(), onExportWord, onExportPdf: vi.fn() })));
            expect(host.querySelector('input[value="editable"]').checked).toBe(true);
            expect(host.textContent).toContain("not editable or searchable");
            await act(async () => host.querySelector('input[value="rounded"]').click());
            await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent.includes("Word document")).click());
            expect(onExportWord).toHaveBeenCalledWith({ tableMode: "rounded" });
        } finally { await act(async () => root.unmount()); }
    });
});

describe("image-table pagination", () => {
    it("repeats headers and partitions only at full row boundaries", () => {
        const rows = [20, 35, 35, 35].map(height => ({ height, span: 1 }));
        expect(tablePanelRows(rows, 100, 1)).toEqual([[1, 2], [3]]);
    });
    it("keeps rowspan-connected groups together", () => {
        const rows = [
            { height: 20, span: 1 }, { height: 30, span: 1 },
            { height: 25, span: 2 }, { height: 25, span: 1 }, { height: 20, span: 1 }
        ];
        expect(tablePanelRows(rows, 85, 1)).toEqual([[1], [2, 3], [4]]);
    });
    it("rejects an oversized row rather than making an unreadable thumbnail", () => {
        expect(() => tablePanelRows([{ height: 20 }, { height: 200 }], 100, 1)).toThrow("Editable tables");
    });
    it("supports tables without headers and header-only tables", () => {
        expect(tablePanelRows([{ height: 40 }, { height: 40 }], 60, 0)).toEqual([[0], [1]]);
        expect(tablePanelRows([{ height: 40 }], 60, 1)).toEqual([[]]);
    });
});

describe("rounded renderer cleanup", () => {
    it("cleans its isolated frame and reports load errors", async () => {
        const pending = renderRoundedWordTables(content);
        const rejected = expect(pending).rejects.toThrow("could not be loaded");
        document.querySelector("iframe").dispatchEvent(new Event("error"));
        await rejected;
        expect(document.querySelector("iframe")).toBeNull();
        expect(html2canvas).not.toHaveBeenCalled();
    });
});
