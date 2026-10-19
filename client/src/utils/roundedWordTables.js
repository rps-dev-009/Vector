import { buildLabsPrintHtml } from "./exportToPdf.js";
import { resolveDocumentStyle } from "../labs/styles.js";

const PX_PER_MM = 96 / 25.4;
const SCALE = 3;
const MAX_PANELS = 100;

/** Partition at row boundaries; rows connected by rowspans stay together. */
export function tablePanelRows(rows, maxHeight, headerCount = 0) {
    const headerHeight = rows.slice(0, headerCount).reduce((sum, r) => sum + r.height, 0);
    const groups = [];
    for (let start = headerCount; start < rows.length;) {
        let end = start + 1;
        let height = 0;
        for (let i = start; i < end; i++) {
            if (!rows[i]) throw new Error("A table has a row span outside its rows. Use Editable tables export.");
            end = Math.max(end, i + Math.max(1, rows[i].span || 1));
            height += rows[i].height;
        }
        groups.push({ start, end, height });
        start = end;
    }
    if (!Number.isFinite(maxHeight) || maxHeight <= 0 || headerHeight > maxHeight) {
        throw new Error("This table header is taller than a page. Use Editable tables export.");
    }
    const panels = [];
    let current = [];
    let height = headerHeight;
    for (const group of groups) {
        if (group.height + headerHeight > maxHeight) {
            throw new Error("A table row or merged group is taller than a page. Use Editable tables export to keep its text readable.");
        }
        if (current.length && height + group.height > maxHeight) {
            panels.push(current);
            current = [];
            height = headerHeight;
        }
        current.push(...Array.from({ length: group.end - group.start }, (_, i) => group.start + i));
        height += group.height;
    }
    if (current.length || (!groups.length && headerCount)) panels.push(current);
    return panels;
}

function roundCanvas(source, radius = 6 * SCALE) {
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser cannot render rounded tables.");
    const r = Math.min(radius, canvas.width / 2, canvas.height / 2);
    const w = canvas.width, h = canvas.height;
    ctx.beginPath();
    ctx.moveTo(r, 0); ctx.lineTo(w - r, 0); ctx.quadraticCurveTo(w, 0, w, r);
    ctx.lineTo(w, h - r); ctx.quadraticCurveTo(w, h, w - r, h);
    ctx.lineTo(r, h); ctx.quadraticCurveTo(0, h, 0, h - r);
    ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath(); ctx.clip(); ctx.drawImage(source, 0, 0);
    return canvas;
}

/**
 * Explicit appearance-first mode: round table panels, never the whole document.
 * Layout comes from the same safe rich-content renderer as print. Nothing is
 * fetched from the document; the offscreen frame is always removed on failure.
 */
export async function renderRoundedWordTables(content, documentStyle, blocks) {
    const theme = resolveDocumentStyle(documentStyle ?? content?.attrs?.documentStyle);
    const width = (210 - theme.marginMm * 2) * PX_PER_MM;
    // Leave breathing room for Word's inline-image paragraph and table spacing.
    const maxHeight = (297 - theme.marginMm * 2) * PX_PER_MM - 48;
    const frame = document.createElement("iframe");
    frame.title = "Preparing rounded Word tables";
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.style.cssText = `position:fixed;left:-20000px;top:0;width:${Math.ceil(width)}px;height:1200px;border:0;`;
    let timer;
    try {
        const loaded = new Promise((resolve, reject) => {
            frame.onload = resolve;
            frame.onerror = () => reject(new Error("The table preview could not be loaded."));
        });
        frame.srcdoc = buildLabsPrintHtml(content, documentStyle, blocks);
        document.body.appendChild(frame);
        await Promise.race([
            (async () => { await loaded; await frame.contentDocument.fonts?.ready; })(),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Table rendering timed out. Try Editable tables export.")), 20000); })
        ]);
        clearTimeout(timer);
        const doc = frame.contentDocument;
        doc.body.style.cssText = `width:${width}px;max-width:none;margin:0;padding:0;`;
        const tables = [...doc.querySelectorAll("table")].filter(table => !table.parentElement.closest("table") && table.rows.length);
        if (!tables.length) return [];
        const { default: html2canvas } = await import("html2canvas");
        const result = [];
        let panelCount = 0;
        for (const table of tables) {
            const tableWidth = table.getBoundingClientRect().width;
            if (!tableWidth || table.scrollWidth > tableWidth + 2) throw new Error("A table is too wide to render. Use Editable tables export.");
            const rows = [...table.rows];
            let headerCount = table.tHead?.rows.length || 0;
            // Do not split a merged cell across the repeating header boundary.
            for (let i = 0; i < headerCount; i++) {
                headerCount = Math.max(headerCount, i + Math.max(...[...rows[i].cells].map(cell => cell.rowSpan), 1));
                if (headerCount > rows.length) throw new Error("A table has an invalid header span. Use Editable tables export.");
            }
            const chunks = tablePanelRows(rows.map(row => ({
                height: row.getBoundingClientRect().height,
                span: Math.max(...[...row.cells].map(cell => cell.rowSpan), 1)
            })), maxHeight - 4, headerCount);
            const images = [];
            for (const chunk of chunks) {
                if (++panelCount > MAX_PANELS) throw new Error("This document has too many table panels for image export. Use Editable tables export.");
                const panel = table.cloneNode(false);
                // Preserve the computed column widths when a chunk has less text.
                const rowWithColumns = rows.find(row => [...row.cells].every(cell => cell.colSpan === 1));
                if (rowWithColumns) {
                    const colgroup = doc.createElement("colgroup");
                    for (const cell of rowWithColumns.cells) {
                        const col = doc.createElement("col");
                        col.style.width = `${cell.getBoundingClientRect().width}px`;
                        colgroup.append(col);
                    }
                    panel.append(colgroup);
                }
                const tbody = doc.createElement("tbody");
                [...Array.from({ length: headerCount }, (_, i) => i), ...chunk].forEach(i => tbody.append(rows[i].cloneNode(true)));
                panel.append(tbody);
                panel.style.width = `${tableWidth}px`;
                panel.style.margin = "0";
                table.after(panel);
                try {
                    const rect = panel.getBoundingClientRect();
                    if (rect.height > maxHeight + 2) throw new Error("This table panel cannot fit a Word page. Use Editable tables export.");
                    const rendered = await html2canvas(panel, {
                        scale: SCALE, backgroundColor: null, logging: false,
                        useCORS: false, allowTaint: false, imageTimeout: 15000,
                        width: Math.ceil(rect.width), height: Math.ceil(rect.height)
                    });
                    const png = roundCanvas(rendered);
                    images.push({ data: png.toDataURL("image/png"), width: rect.width, height: rect.height,
                        alt: [...Array.from({ length: headerCount }, (_, i) => i), ...chunk]
                            .map(i => [...rows[i].cells].map(cell => cell.textContent.trim()).join(" | ")).join("; ").slice(0, 16000) });
                    png.width = 0; png.height = 0;
                    rendered.width = 0; rendered.height = 0;
                } finally { panel.remove(); }
            }
            result.push(images);
        }
        return result;
    } finally {
        clearTimeout(timer);
        frame.remove();
    }
}
