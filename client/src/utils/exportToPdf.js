import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import { createLabsExportModel, elementStyle, tableCellStyle, documentTitle } from "./labsExportModel.js";
import { fontStack } from "../labs/styles.js";

/**
 * Converts markdown content to a styled PDF document
 * @param {string} content - Markdown content (legacy / fallback)
 * @param {string} filename - Name for the exported file (without extension)
 * @param {object} [options]
 * @param {object} [options.content] - Full Tiptap document (native print path).
 * @param {Array} [options.blocks] - Legacy Labs block fallback (native print).
 * @param {object} [options.documentStyle] - Overrides root document style.
 */
export async function exportToPdf(content, filename = "document", options = {}) {
    if (options.content != null || Array.isArray(options.blocks)) {
        return printLabsDocument(buildLabsPrintHtml(options.content, options.documentStyle, options.blocks, filename));
    }
    // Create a temporary container to render the content
    const container = document.createElement("div");
    container.style.cssText = `
        position: absolute;
        left: -9999px;
        top: 0;
        width: 210mm;
        padding: 20mm;
        background: white;
        color: black;
        font-family: 'Inter', 'Segoe UI', 'Arial', sans-serif;
        font-size: 12pt;
        line-height: 1.6;
    `;

    // Keep the Chat markdown screenshot exporter unchanged.
    const htmlContent = markdownToHtml(content);
    container.innerHTML = htmlContent;
    document.body.appendChild(container);

    try {
        // Wait for any images/fonts to load
        await new Promise(resolve => setTimeout(resolve, 100));

        // Capture the content as canvas
        const canvas = await html2canvas(container, {
            scale: 2,
            useCORS: true,
            logging: false,
            backgroundColor: "#ffffff"
        });

        // Create PDF
        const imgWidth = 210; // A4 width in mm
        const pageHeight = 297; // A4 height in mm
        const imgHeight = (canvas.height * imgWidth) / canvas.width;
        let heightLeft = imgHeight;
        let position = 0;

        const pdf = new jsPDF("p", "mm", "a4");
        const imgData = canvas.toDataURL("image/png");

        // Add first page
        pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
        heightLeft -= pageHeight;

        // Add additional pages if content is longer than one page
        while (heightLeft > 0) {
            position = heightLeft - imgHeight;
            pdf.addPage();
            pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
            heightLeft -= pageHeight;
        }

        // Save the PDF
        pdf.save(`${filename}.pdf`);
    } finally {
        // Clean up
        document.body.removeChild(container);
    }
}

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));

function printStyle(style) {
    return `font-family:${fontStack(style.fontFamily)};font-size:${style.fontSizePt}pt;line-height:${style.lineHeight};margin-top:${style.spaceBeforePt}pt;margin-bottom:${style.spaceAfterPt}pt;color:${style.textColor};background-color:${style.backgroundColor || "transparent"};text-align:${style.align}`;
}

function richPrintRuns(runs) {
    return runs.map(run => {
        if (run.break) return "<br>";
        const style = [];
        if (run.color) style.push(`color:${run.color}`);
        if (run.backgroundColor) style.push(`background-color:${run.backgroundColor}`);
        if (run.fontFamily) style.push(`font-family:${fontStack(run.fontFamily)}`);
        if (run.fontSizePt) style.push(`font-size:${run.fontSizePt}pt`);
        let text = escapeHtml(run.text).replace(/\n/g, "<br>");
        if (run.code) text = `<code>${text}</code>`;
        if (run.bold) text = `<strong>${text}</strong>`;
        if (run.italic) text = `<em>${text}</em>`;
        if (run.underline) text = `<u>${text}</u>`;
        if (run.strike) text = `<s>${text}</s>`;
        if (style.length) text = `<span style="${escapeHtml(style.join(";"))}">${text}</span>`;
        return run.href ? `<a href="${escapeHtml(run.href)}" rel="noopener noreferrer">${text}</a>` : text;
    }).join("");
}

/** Standalone print HTML with local font fallbacks and no external resource loads. */
export function buildLabsPrintHtml(content, documentStyle, blocks, filename = "document") {
    const model = createLabsExportModel(content, documentStyle, blocks);
    const { theme, elements } = model;
    function render(element, inherited = {}) {
        if (element.type === "spacer") {
            const heightPt = element.attrs.heightPt;
            return `<div data-type="labs-spacer" data-height-pt="${heightPt}" style="height:${heightPt}pt;margin:0;padding:0;border:0;line-height:0;break-inside:avoid;page-break-inside:avoid"></div>`;
        }
        const style = elementStyle(element, model.documentStyle, inherited);
        const childAttrs = { ...inherited, ...element.attrs };
        const attr = escapeHtml(printStyle(style));
        if (element.runs) {
            const tag = element.type === "heading" ? `h${element.attrs.level}` : element.type === "codeBlock" ? "pre" : "p";
            const codeStyle = tag === "pre" ? `;font-family:Consolas,monospace;background-color:${style.backgroundColor || theme.soft}` : "";
            return `<${tag} style="${attr}${codeStyle}">${richPrintRuns(element.runs) || "<br>"}</${tag}>`;
        }
        if (["bulletList", "orderedList", "taskList"].includes(element.type)) {
            const ordered = element.type === "orderedList";
            const task = element.type === "taskList";
            const tag = ordered ? "ol" : "ul";
            const start = ordered ? ` start="${Math.max(1, Math.floor(Number(element.attrs.start)) || 1)}"` : "";
            return `<${tag}${start}${task ? ' class="task-list"' : ""} style="${attr}">${(element.children || []).map(item =>
                `<li>${task ? `<span class="task-marker">${item.attrs.checked ? "&#9745;" : "&#9744;"}</span>` : ""}${(item.children || []).map(child => render(child, childAttrs)).join("")}</li>`
            ).join("")}</${tag}>`;
        }
        if (element.type === "table") {
            const rows = element.children || [];
            let headerCount = 0;
            while (rows[headerCount]?.children.length && rows[headerCount].children.every(cell => cell.type === "tableHeader")) headerCount++;
            const rendered = rows.map((row, index) => `<tr>${row.children.map(cell => {
                const cellStyle = tableCellStyle(style, cell, index);
                const tag = cell.type === "tableHeader" ? "th" : "td";
                const border = `border:0.5pt solid ${style.tableBorderColor};${style.tableVariant !== "grid" ? "border-left:0;border-right:0;" : ""}`;
                const css = `${printStyle(cellStyle)};${border}padding:${style.tableCellPaddingPt}pt;vertical-align:middle`;
                return `<${tag}${tag === "th" ? ` scope="${index < headerCount ? "col" : "row"}"` : ""} colspan="${cell.attrs.colspan}" rowspan="${cell.attrs.rowspan}" style="${escapeHtml(css)}">${cell.children.map(child => render(child, cellStyle)).join("")}</${tag}>`;
            }).join("")}</tr>`);
            return `<table style="${attr}">${headerCount ? `<thead>${rendered.slice(0, headerCount).join("")}</thead>` : ""}<tbody>${rendered.slice(headerCount).join("")}</tbody></table>`;
        }
        if (element.type === "horizontalRule") return `<hr style="border-color:${style.tableBorderColor}">`;
        const children = (element.children || []).map(child => render(child, childAttrs)).join("");
        return element.type === "blockquote" ? `<blockquote style="${attr};border-left:2pt solid ${theme.accent}">${children}</blockquote>` : children;
    }
    const title = documentTitle(elements);
    // CSS strings need separate escaping from HTML; in particular a title must
    // never terminate the style element. No arbitrary CSS or URLs are accepted.
    const cssTitle = JSON.stringify(documentTitle(elements, 80).replace(/\s+/g, " ")).replace(/</g, "\\3c ").replace(/>/g, "\\3e ");
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="description" content="Print / Save PDF. Fonts use installed local faces and fallbacks; no fonts are downloaded or embedded.">
<title>${escapeHtml(filename || title || "document")}</title>
<style>
@page { size:A4; margin:${theme.marginMm}mm;
    @top-left { content:${cssTitle}; font-family:${fontStack(theme.bodyFont)}; font-size:9pt; color:${theme.muted}; }
    @bottom-center { content:counter(page); font-family:${fontStack(theme.bodyFont)}; font-size:9pt; color:${theme.muted}; }
}
* { box-sizing:border-box; }
html { color-scheme:light; background:#FFFFFF; }
body { margin:0; background:#FFFFFF; color:${theme.ink}; font-family:${fontStack(theme.bodyFont)}; font-size:${theme.fontSizePt}pt; line-height:${theme.lineHeight}; }
body { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
p, h1, h2, h3, h4, h5, h6 { white-space:pre-wrap; overflow-wrap:anywhere; }
p { orphans:2; widows:2; }
h1, h2, h3, h4, h5, h6 { break-after:avoid-page; page-break-after:avoid; break-inside:avoid; font-weight:700; }
a { color:inherit; text-decoration:underline; }
pre { white-space:pre-wrap; overflow-wrap:anywhere; padding:10pt; }
code { font-family:Consolas,monospace; }
blockquote { margin-left:0; margin-right:0; padding-left:14pt; }
ul, ol { padding-left:20pt; }
li > p:first-child { margin-top:0; }
.task-list { list-style:none; }
.task-list > li { position:relative; }
.task-marker { position:absolute; left:-18pt; }
table { border-collapse:collapse; width:100%; table-layout:fixed; }
thead { display:table-header-group; }
tfoot { display:table-footer-group; }
tr { break-inside:avoid; page-break-inside:avoid; }
th, td { overflow-wrap:anywhere; }
th { font-weight:700; }
hr { border:0; border-top:0.5pt solid; margin:14pt 0; }
@media screen { body { max-width:210mm; margin:auto; padding:${theme.marginMm}mm; } }
</style></head><body>${elements.map(element => render(element)).join("\n")}</body></html>`;
}

async function printLabsDocument(html) {
    const frame = document.createElement("iframe");
    frame.title = "Labs Print / Save PDF";
    frame.setAttribute("sandbox", "allow-same-origin allow-modals");
    frame.style.cssText = "position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0;";
    let timer;
    let printWindow;
    const cleanup = () => {
        clearTimeout(timer);
        printWindow?.removeEventListener("afterprint", cleanup);
        window.removeEventListener("afterprint", cleanup);
        frame.remove();
    };
    try {
        const loaded = new Promise((resolve, reject) => {
            frame.onload = resolve;
            frame.onerror = () => reject(new Error("The print document could not be loaded."));
        });
        frame.srcdoc = html;
        document.body.appendChild(frame);
        await Promise.race([
            (async () => {
                await loaded;
                await frame.contentDocument?.fonts?.ready;
            })(),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("The print document timed out while loading.")), 15000); })
        ]);
        clearTimeout(timer);
        printWindow = frame.contentWindow;
        if (!printWindow || typeof printWindow.print !== "function") throw new Error("Printing is unavailable in this browser.");
        // Native print may return before the dialog closes. Keep the frame and
        // its selectable text alive until afterprint, never a short cleanup timer.
        printWindow.addEventListener("afterprint", cleanup, { once: true });
        window.addEventListener("afterprint", cleanup, { once: true });
        void frame.contentDocument.body.offsetHeight;
        printWindow.focus();
        printWindow.print();
        return { mode: "print" };
    } catch (error) {
        cleanup();
        throw error;
    }
}

/**
 * Converts markdown to styled HTML for PDF rendering
 * Handles common markdown syntax including LaTeX (as plain text for PDF)
 */
function markdownToHtml(markdown) {
    if (!markdown) return "";

    let html = markdown;

    // Escape HTML entities
    html = html
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    // Convert LaTeX blocks to styled spans (rendered as formatted text)
    html = html.replace(/\$\$([^$]+)\$\$/g, '<div style="text-align: center; font-style: italic; padding: 10px; background: #f5f5f5; border-radius: 4px; margin: 10px 0;">$1</div>');
    html = html.replace(/\$([^$]+)\$/g, '<span style="font-style: italic; background: #f0f0f0; padding: 2px 4px; border-radius: 2px;">$1</span>');

    // Headers
    html = html.replace(/^### (.+)$/gm, '<h3 style="font-size: 14pt; font-weight: 600; margin: 16px 0 8px 0; color: #333;">$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2 style="font-size: 16pt; font-weight: 600; margin: 20px 0 10px 0; color: #222;">$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1 style="font-size: 20pt; font-weight: 700; margin: 24px 0 12px 0; color: #111; border-bottom: 1px solid #ddd; padding-bottom: 8px;">$1</h1>');

    // Bold and Italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
    html = html.replace(/_(.+?)_/g, '<em>$1</em>');

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code style="background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-family: Consolas, monospace; font-size: 11pt;">$1</code>');

    // Code blocks
    html = html.replace(/```[\w]*\n([\s\S]*?)```/g, '<pre style="background: #f5f5f5; padding: 12px; border-radius: 6px; font-family: Consolas, monospace; font-size: 10pt; overflow-x: auto; margin: 12px 0; border: 1px solid #e0e0e0;">$1</pre>');

    // Blockquotes
    html = html.replace(/^> (.+)$/gm, '<blockquote style="border-left: 3px solid #4a90d9; padding-left: 12px; margin: 12px 0; color: #555; font-style: italic;">$1</blockquote>');

    // Horizontal rules
    html = html.replace(/^---$/gm, '<hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">');

    // Unordered lists
    html = html.replace(/^- (.+)$/gm, '<li style="margin: 4px 0;">$1</li>');
    html = html.replace(/(<li[^>]*>.*<\/li>\n?)+/g, '<ul style="margin: 10px 0; padding-left: 24px;">$&</ul>');

    // Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<li style="margin: 4px 0;">$1</li>');

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color: #4a90d9; text-decoration: underline;">$1</a>');

    // Tables - parse markdown tables to HTML tables
    html = html.replace(/^(\|.+\|)\r?\n(\|[-:| ]+\|)\r?\n((?:\|.+\|\r?\n?)+)/gm, (match, headerRow, separatorRow, bodyRows) => {
        // Parse header cells
        const headers = headerRow.split('|').slice(1, -1).map(h => h.trim());

        // Parse alignment from separator row
        const alignments = separatorRow.split('|').slice(1, -1).map(sep => {
            const s = sep.trim();
            if (s.startsWith(':') && s.endsWith(':')) return 'center';
            if (s.endsWith(':')) return 'right';
            return 'left';
        });

        // Create header HTML
        const headerHtml = headers.map((h, i) =>
            `<th style="border: 1px solid #ddd; padding: 10px 12px; text-align: ${alignments[i] || 'left'}; background: #f5f5f5; font-weight: 600;">${h}</th>`
        ).join('');

        // Parse and create body rows
        const rows = bodyRows.trim().split('\n').map((row, rowIdx) => {
            const cells = row.split('|').slice(1, -1).map(c => c.trim());
            const cellsHtml = cells.map((c, i) =>
                `<td style="border: 1px solid #ddd; padding: 8px 12px; text-align: ${alignments[i] || 'left'};">${c}</td>`
            ).join('');
            return `<tr style="background: ${rowIdx % 2 === 0 ? '#fff' : '#fafafa'};">${cellsHtml}</tr>`;
        }).join('');

        return `<table style="border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 11pt;">
            <thead><tr>${headerHtml}</tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
    });

    // Paragraphs (handle line breaks)
    html = html.replace(/\n\n/g, '</p><p style="margin: 10px 0;">');
    html = html.replace(/\n/g, '<br>');

    // Wrap in paragraph tags
    html = `<p style="margin: 10px 0;">${html}</p>`;

    // Clean up empty paragraphs
    html = html.replace(/<p[^>]*>\s*<\/p>/g, '');

    return `
        <style>
            * { box-sizing: border-box; }
            body { margin: 0; padding: 0; }
        </style>
        ${html}
    `;
}
