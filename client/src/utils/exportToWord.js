/**
 * Export markdown content to a Word document (.docx)
 * Uses the docx library to create properly formatted documents
 */

import {
    Document,
    Paragraph,
    TextRun,
    HeadingLevel,
    Table,
    TableRow,
    TableCell,
    WidthType,
    BorderStyle,
    Packer,
    AlignmentType,
    ExternalHyperlink,
    Header,
    Footer,
    PageNumber,
    ShadingType,
    LineRuleType,
    ImageRun
} from "docx";
import { createLabsExportModel, elementStyle, tableCellStyle, documentTitle, resolveTextHex, resolveBgHex } from "./labsExportModel.js";
import { resolveBlockStyle } from "../labs/styles.js";

const ALIGN_MAP = {
    left: AlignmentType.LEFT,
    center: AlignmentType.CENTER,
    right: AlignmentType.RIGHT,
    justify: AlignmentType.JUSTIFIED
};

/**
 * Simple markdown parser for converting to docx elements
 */
function parseMarkdown(markdown) {
    const lines = markdown.split("\n");
    const elements = [];
    let inCodeBlock = false;
    let codeContent = [];
    let inTable = false;
    let tableRows = [];
    let listItems = [];
    let listType = null; // "ul" or "ol"

    const flushList = () => {
        if (listItems.length > 0) {
            elements.push({
                type: listType === "ol" ? "orderedList" : "bulletList",
                items: [...listItems]
            });
            listItems = [];
            listType = null;
        }
    };

    const flushTable = () => {
        if (tableRows.length > 0) {
            elements.push({
                type: "table",
                rows: [...tableRows]
            });
            tableRows = [];
            inTable = false;
        }
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Code block handling
        if (line.startsWith("```")) {
            if (inCodeBlock) {
                elements.push({
                    type: "codeBlock",
                    content: codeContent.join("\n")
                });
                codeContent = [];
                inCodeBlock = false;
            } else {
                flushList();
                flushTable();
                inCodeBlock = true;
            }
            continue;
        }

        if (inCodeBlock) {
            codeContent.push(line);
            continue;
        }

        // Table handling
        if (line.includes("|") && line.trim().startsWith("|")) {
            flushList();
            const cells = line.split("|").slice(1, -1).map(c => c.trim());

            // Skip separator row
            if (cells.every(c => /^[-:]+$/.test(c))) {
                continue;
            }

            tableRows.push(cells);
            inTable = true;
            continue;
        } else if (inTable) {
            flushTable();
        }

        // Empty line
        if (!line.trim()) {
            flushList();
            continue;
        }

        // Headings
        const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch) {
            flushList();
            elements.push({
                type: "heading",
                level: headingMatch[1].length,
                content: headingMatch[2]
            });
            continue;
        }

        // Horizontal rule
        if (/^[-*_]{3,}$/.test(line.trim())) {
            flushList();
            elements.push({ type: "hr" });
            continue;
        }

        // Blockquote
        if (line.startsWith(">")) {
            flushList();
            elements.push({
                type: "blockquote",
                content: line.replace(/^>\s*/, "")
            });
            continue;
        }

        // Ordered list
        const olMatch = line.match(/^(\d+)\.\s+(.+)$/);
        if (olMatch) {
            if (listType === "ul") flushList();
            listType = "ol";
            listItems.push(olMatch[2]);
            continue;
        }

        // Unordered list
        const ulMatch = line.match(/^[-*+]\s+(.+)$/);
        if (ulMatch) {
            if (listType === "ol") flushList();
            listType = "ul";
            listItems.push(ulMatch[1]);
            continue;
        }

        // Regular paragraph
        flushList();
        elements.push({
            type: "paragraph",
            content: line
        });
    }

    // Flush any remaining items
    flushList();
    flushTable();

    return elements;
}

/**
 * Parse inline formatting (bold, italic, code, links)
 */
function parseInlineFormatting(text, baseColor) {
    const runs = [];
    let remaining = text;
    const tint = baseColor ? { color: baseColor } : {};

    while (remaining.length > 0) {
        // Bold and italic: ***text***
        let match = remaining.match(/^\*\*\*(.+?)\*\*\*/);
        if (match) {
            runs.push(new TextRun({ text: match[1], bold: true, italics: true, font: "Calibri", ...tint }));
            remaining = remaining.slice(match[0].length);
            continue;
        }

        // Bold: **text** or __text__
        match = remaining.match(/^(\*\*|__)(.+?)(\*\*|__)/);
        if (match) {
            runs.push(new TextRun({ text: match[2], bold: true, font: "Calibri", ...tint }));
            remaining = remaining.slice(match[0].length);
            continue;
        }

        // Italic: *text* or _text_
        match = remaining.match(/^(\*|_)(.+?)(\*|_)/);
        if (match) {
            runs.push(new TextRun({ text: match[2], italics: true, font: "Calibri", ...tint }));
            remaining = remaining.slice(match[0].length);
            continue;
        }

        // Inline code: `code`
        match = remaining.match(/^`([^`]+)`/);
        if (match) {
            runs.push(new TextRun({
                text: match[1],
                font: "Consolas",
                shading: { fill: "E8E8E8" }
            }));
            remaining = remaining.slice(match[0].length);
            continue;
        }

        // Link: [text](url)
        match = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
        if (match) {
            runs.push(new TextRun({
                text: match[1],
                color: "0563C1",
                underline: {},
                font: "Calibri"
            }));
            remaining = remaining.slice(match[0].length);
            continue;
        }

        // Regular text (take until next special character or end)
        match = remaining.match(/^[^*_`\[]+/);
        if (match) {
            runs.push(new TextRun({ text: match[0], font: "Calibri", ...tint }));
            remaining = remaining.slice(match[0].length);
            continue;
        }

        // Single special character that didn't match formatting
        runs.push(new TextRun({ text: remaining[0], font: "Calibri", ...tint }));
        remaining = remaining.slice(1);
    }

    return runs;
}

/**
 * Convert parsed elements to docx sections
 */
function elementsToDocx(elements) {
    const children = [];

    for (const el of elements) {
        const attrs = el.attrs || {};
        const textHex = resolveTextHex(attrs.textColor);
        const bgHex = resolveBgHex(attrs.backgroundColor);
        const align = ALIGN_MAP[attrs.align] || undefined;
        const shading = bgHex ? { fill: bgHex } : undefined;

        switch (el.type) {
            case "heading":
                const headingLevels = {
                    1: HeadingLevel.HEADING_1,
                    2: HeadingLevel.HEADING_2,
                    3: HeadingLevel.HEADING_3,
                    4: HeadingLevel.HEADING_4,
                    5: HeadingLevel.HEADING_5,
                    6: HeadingLevel.HEADING_6
                };
                children.push(
                    new Paragraph({
                        heading: headingLevels[el.level] || HeadingLevel.HEADING_1,
                        children: parseInlineFormatting(el.content, textHex),
                        alignment: align,
                        shading,
                        spacing: { before: 280, after: 120 }
                    })
                );
                break;

            case "paragraph":
                children.push(
                    new Paragraph({
                        children: parseInlineFormatting(el.content, textHex),
                        alignment: align,
                        shading,
                        spacing: { after: 280, line: 276 }
                    })
                );
                break;

            case "bulletList":
                for (let i = 0; i < el.items.length; i++) {
                    children.push(
                        new Paragraph({
                            bullet: { level: 0 },
                            children: parseInlineFormatting(el.items[i], textHex),
                            spacing: { after: i === el.items.length - 1 ? 200 : 60 }
                        })
                    );
                }
                break;

            case "orderedList":
                for (let idx = 0; idx < el.items.length; idx++) {
                    children.push(
                        new Paragraph({
                            numbering: { reference: "default-numbering", level: 0 },
                            children: parseInlineFormatting(el.items[idx], textHex),
                            spacing: { after: idx === el.items.length - 1 ? 200 : 60 }
                        })
                    );
                }
                break;

            case "taskList":
                for (let i = 0; i < el.items.length; i++) {
                    const it = el.items[i];
                    const box = it.checked ? "\u2611 " : "\u2610 ";
                    children.push(
                        new Paragraph({
                            children: [
                                new TextRun({ text: box, font: "Calibri" }),
                                ...parseInlineFormatting(it.text, textHex)
                            ],
                            spacing: { after: i === el.items.length - 1 ? 200 : 60 }
                        })
                    );
                }
                break;

            case "codeBlock":
                children.push(
                    new Paragraph({
                        children: [
                            new TextRun({
                                text: el.content,
                                font: "Consolas",
                                size: 20
                            })
                        ],
                        shading: { fill: "F5F5F5" },
                        spacing: { before: 200, after: 200 }
                    })
                );
                break;

            case "blockquote":
                children.push(
                    new Paragraph({
                        children: parseInlineFormatting(el.content, textHex),
                        indent: { left: 720 },
                        alignment: align,
                        shading,
                        border: {
                            left: { style: BorderStyle.SINGLE, size: 24, color: "CCCCCC" }
                        },
                        spacing: { before: 200, after: 200 }
                    })
                );
                break;

            case "table": {
                // Calculate equal column widths for Google Docs compatibility
                const numCols = el.rows[0] ? el.rows[0].length : 1;
                const colWidthPct = Math.floor(100 / numCols);
                const cellBorders = {
                    top: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
                    bottom: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
                    left: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
                    right: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
                };
                // Header shading follows the block's colour if it set one.
                const headerFill = bgHex || "E8E8E8";
                const tableRows = el.rows.map((row, rowIdx) =>
                    new TableRow({
                        tableHeader: rowIdx === 0,
                        children: row.map(cell =>
                            new TableCell({
                                children: [
                                    new Paragraph({
                                        children: parseInlineFormatting(cell, rowIdx === 0 ? textHex : null),
                                        spacing: { before: 40, after: 40 },
                                    })
                                ],
                                width: { size: colWidthPct, type: WidthType.PERCENTAGE },
                                borders: cellBorders,
                                shading: rowIdx === 0 ? { fill: headerFill } : undefined,
                                verticalAlign: "center",
                                margins: {
                                    top: 40,
                                    bottom: 40,
                                    left: 80,
                                    right: 80,
                                },
                            })
                        )
                    })
                );
                children.push(
                    new Table({
                        rows: tableRows,
                        width: { size: 100, type: WidthType.PERCENTAGE },
                        layout: "fixed",
                    })
                );
                // Add spacing after table
                children.push(new Paragraph({ spacing: { after: 200 } }));
                break;
            }

            case "hr":
                children.push(
                    new Paragraph({
                        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "CCCCCC" } },
                        spacing: { before: 400, after: 400 }
                    })
                );
                break;
        }
    }

    return children;
}

// OOXML spacing is twips, font sizes are half-points, and auto line spacing is
// in 240ths of a line. CLEAR + fill is a solid background, not a hatch pattern.
const twips = (points) => Math.round(points * 20);
const hex = (color) => color?.replace("#", "");
const fill = (color) => color ? { type: ShadingType.CLEAR, color: "auto", fill: hex(color) } : undefined;
const spacing = (style) => ({
    before: twips(style.spaceBeforePt), after: twips(style.spaceAfterPt),
    line: Math.round(style.lineHeight * 240), lineRule: LineRuleType.AUTO
});

function richWordRuns(runs, style, bold = false, code = false) {
    return runs.flatMap(run => {
        const properties = {
            font: run.fontFamily || (run.code || code ? "Consolas" : style.fontFamily),
            size: Math.round((run.fontSizePt || style.fontSizePt) * 2),
            color: hex(run.color || style.textColor),
            bold: run.bold || bold,
            italics: run.italic,
            strike: run.strike,
            underline: run.underline || run.href ? {} : undefined,
            shading: fill(run.backgroundColor)
        };
        const children = run.break ? [new TextRun({ ...properties, break: 1 })]
            : String(run.text).split("\n").map((text, i) => new TextRun({ ...properties, text, ...(i ? { break: 1 } : {}) }));
        return run.href ? [new ExternalHyperlink({ link: run.href, children })] : children;
    });
}

/** Pure builder: canonical Tiptap content wins; blocks are the legacy Labs fallback. */
export function buildLabsWordDocument(content, documentStyle, blocks, tableImages) {
    const model = createLabsExportModel(content, documentStyle, blocks);
    const { theme, elements } = model;
    const body = resolveBlockStyle("paragraph", {}, model.documentStyle);
    const numbering = [];
    let tableIndex = 0;
    const border = (color, minimal = false) => ({ style: minimal ? BorderStyle.NIL : BorderStyle.SINGLE, size: 4, color: hex(color) });

    function render(element, context = {}) {
        const style = elementStyle(element, model.documentStyle, context.inherited);
        if (element.runs) {
            const heading = element.type === "heading";
            const code = element.type === "codeBlock";
            return [new Paragraph({
                style: heading ? `Heading${element.attrs.level}` : code ? "LabsCode" : context.quote ? "LabsQuote" : context.cell ? "LabsTableText" : "LabsBody",
                ...(heading ? { heading: HeadingLevel[`HEADING_${element.attrs.level}`], outlineLevel: element.attrs.level - 1 } : {}),
                children: [
                    ...(context.task ? richWordRuns([{ text: context.task }], style) : []),
                    ...richWordRuns(element.runs, style, heading || context.header, code)
                ],
                alignment: ALIGN_MAP[style.align],
                spacing: spacing(style),
                shading: fill(style.backgroundColor || (code ? theme.soft : null)),
                keepNext: heading,
                keepLines: heading,
                widowControl: true,
                numbering: context.numbering,
                indent: context.indent || (context.quote ? { left: 360 } : undefined),
                border: context.quote ? { left: { ...border(theme.accent), size: 16, space: 10 } } : undefined
            })];
        }
        if (["bulletList", "orderedList", "taskList"].includes(element.type)) {
            const level = Math.min(context.depth || 0, 8);
            const reference = `labs-list-${numbering.length}`;
            const taskList = element.type === "taskList";
            if (!taskList) numbering.push({
                reference,
                levels: Array.from({ length: 9 }, (_, i) => ({
                    level: i,
                    format: element.type === "orderedList" ? "decimal" : "bullet",
                    text: element.type === "orderedList" ? `%${i + 1}.` : "\u2022",
                    start: Math.max(1, Math.floor(Number(element.attrs.start)) || 1),
                    alignment: AlignmentType.START,
                    style: { run: { font: style.fontFamily, color: hex(style.textColor) }, paragraph: { indent: { left: (i + 1) * 360, hanging: 240 } } }
                }))
            });
            return (element.children || []).flatMap(item => {
                const nodes = [...(item.children || [])];
                if (!nodes[0]?.runs) nodes.unshift({ type: "paragraph", attrs: {}, runs: [] });
                return nodes.flatMap((child, i) => render(child, {
                    ...context, inherited: { ...context.inherited, ...element.attrs }, depth: level + 1,
                    numbering: !taskList && i === 0 ? { reference, level } : undefined,
                    indent: taskList || i > 0 ? { left: (level + 1) * 360 } : undefined,
                    task: taskList && i === 0 ? (item.attrs.checked ? "\u2611 " : "\u2610 ") : undefined
                }));
            });
        }
        if (element.type === "table") {
            const rows = element.children || [];
            if (!rows.length) return [];
            if (tableImages) {
                const panels = tableImages[tableIndex++];
                if (!panels?.length) throw new Error("A rounded table image is missing. Try Editable tables export.");
                return panels.map((panel, index) => new Paragraph({
                    children: [new ImageRun({ type: "png", data: panel.data,
                        transformation: { width: panel.width, height: panel.height },
                        altText: { title: `Table ${tableIndex}${panels.length > 1 ? `, part ${index + 1}` : ""}`, description: panel.alt || "Rounded table image", name: `table-${tableIndex}-${index + 1}` }
                    })],
                    alignment: ALIGN_MAP[style.align],
                    spacing: { before: 0, after: twips(style.spaceAfterPt) },
                    keepLines: true,
                    // Pre-rendered panels break only between complete row groups.
                    pageBreakBefore: index > 0
                }));
            }
            const columns = Math.max(1, ...rows.map(row => row.children.reduce((sum, cell) => sum + cell.attrs.colspan, 0)));
            const width = context.availableWidth || Math.round((210 - theme.marginMm * 2) * 1440 / 25.4);
            const line = border(style.tableBorderColor);
            const side = border(style.tableBorderColor, style.tableVariant !== "grid");
            const borders = { top: line, bottom: line, left: side, right: side };
            let leadingHeader = true;
            const table = new Table({
                width: { size: width, type: WidthType.DXA },
                columnWidths: Array.from({ length: columns }, () => Math.floor(width / columns)),
                layout: "fixed",
                borders: { ...borders, insideHorizontal: line, insideVertical: side },
                rows: rows.map((row, rowIndex) => {
                    leadingHeader = leadingHeader && row.children.length > 0 && row.children.every(cell => cell.type === "tableHeader");
                    return new TableRow({
                        tableHeader: leadingHeader,
                        cantSplit: true,
                        children: row.children.map(cell => {
                            const cellStyle = tableCellStyle(style, cell, rowIndex);
                            const cellWidth = Math.floor(width * cell.attrs.colspan / columns);
                            const children = (cell.children || []).flatMap(child => render(child, {
                                inherited: cellStyle, cell: true, header: cell.type === "tableHeader",
                                availableWidth: Math.max(1, cellWidth - twips(style.tableCellPaddingPt) * 2)
                            }));
                            // Word requires every cell, including one ending in a nested table, to end in a paragraph.
                            if (!(children.at(-1) instanceof Paragraph)) children.push(new Paragraph({ style: "LabsTableText" }));
                            return new TableCell({
                                children,
                                columnSpan: cell.attrs.colspan,
                                rowSpan: cell.attrs.rowspan,
                                width: { size: cellWidth, type: WidthType.DXA },
                                verticalAlign: "center",
                                borders,
                                shading: fill(cellStyle.backgroundColor),
                                margins: Object.fromEntries(["top", "bottom", "left", "right"].map(key => [key, twips(style.tableCellPaddingPt)]))
                            });
                        })
                    });
                })
            });
            return [table, new Paragraph({ spacing: { after: twips(style.spaceAfterPt), before: 0, line: 1, lineRule: LineRuleType.EXACTLY }, run: { size: 2 }, children: [] })];
        }
        if (element.type === "horizontalRule") return [new Paragraph({
            border: { bottom: border(style.tableBorderColor) }, spacing: spacing(style)
        })];
        return (element.children || []).flatMap(child => render(child, {
            ...context, inherited: { ...context.inherited, ...(element.type === "blockquote" ? { backgroundColor: style.backgroundColor } : {}), ...element.attrs }, quote: context.quote || element.type === "blockquote"
        }));
    }

    const children = elements.flatMap(element => render(element));
    if (tableImages && tableIndex !== tableImages.length) throw new Error("The rounded table preview does not match this document. Export again.");
    const bodyRun = { font: body.fontFamily, size: Math.round(body.fontSizePt * 2), color: hex(body.textColor) };
    const defaults = { document: { run: bodyRun, paragraph: { spacing: spacing(body) } } };
    for (let level = 1; level <= 6; level++) {
        const heading = resolveBlockStyle("heading", { level }, model.documentStyle);
        defaults[`heading${level}`] = {
            name: `Heading ${level}`, next: "LabsBody", quickFormat: true,
            run: { font: heading.fontFamily, size: Math.round(heading.fontSizePt * 2), color: hex(heading.textColor), bold: true },
            paragraph: { spacing: spacing(heading), keepNext: true, keepLines: true, outlineLevel: level - 1 }
        };
    }
    const margin = Math.round(theme.marginMm * 1440 / 25.4);
    return new Document({
        title: documentTitle(elements),
        description: "Labs document. Fonts are not embedded; Word uses installed fonts or its local substitutes.",
        background: { color: "FFFFFF" },
        styles: {
            default: defaults,
            paragraphStyles: [
                { id: "LabsBody", name: "Labs Body", basedOn: "Normal", next: "LabsBody", quickFormat: true, run: bodyRun, paragraph: { spacing: spacing(body) } },
                { id: "LabsQuote", name: "Labs Quote", basedOn: "LabsBody", next: "LabsBody", paragraph: { indent: { left: 360 } } },
                { id: "LabsCode", name: "Labs Code", basedOn: "LabsBody", next: "LabsBody", run: { font: "Consolas" } },
                { id: "LabsTableText", name: "Labs Table Text", basedOn: "LabsBody", paragraph: { spacing: { before: 0, after: 0 } } },
                { id: "LabsRunningText", name: "Labs Running Text", basedOn: "LabsBody", run: { font: body.fontFamily, size: 18, color: hex(theme.muted) }, paragraph: { spacing: { before: 0, after: 0, line: 240, lineRule: LineRuleType.AUTO } } }
            ]
        },
        numbering: { config: numbering },
        sections: [{
            properties: { page: {
                size: { width: 11906, height: 16838, orientation: "portrait" },
                margin: { top: margin, right: margin, bottom: margin, left: margin, header: Math.round(margin / 2), footer: Math.round(margin / 2), gutter: 0 }
            } },
            headers: { default: new Header({ children: [new Paragraph({ style: "LabsRunningText", children: [new TextRun(documentTitle(elements))] })] }) },
            footers: { default: new Footer({ children: [new Paragraph({ style: "LabsRunningText", alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT] })] })] }) },
            children: children.length ? children : [new Paragraph({ style: "LabsBody" })]
        }]
    });
}

/**
 * Export to a Word document and trigger download.
 * @param {string} markdown  derived Markdown (legacy / fallback)
 * @param {string} filename
 * @param {object} [options]
 * @param {object} [options.content] Full Tiptap document, retaining rich marks.
 * @param {Array} [options.blocks] Legacy Labs block fallback.
 * @param {object} [options.documentStyle] Overrides the root document style.
 * @param {"editable"|"rounded"} [options.tableMode] Rounded exports only tables as PNG panels.
 */
export async function exportToWord(markdown, filename = "document", options = {}) {
    const labs = options.content != null || Array.isArray(options.blocks);
    let tableImages;
    if (labs && options.tableMode === "rounded") {
        const { renderRoundedWordTables } = await import("./roundedWordTables.js");
        tableImages = await renderRoundedWordTables(options.content, options.documentStyle, options.blocks);
    }
    const doc = labs ? buildLabsWordDocument(options.content, options.documentStyle, options.blocks, tableImages) : new Document({
        numbering: {
            config: [
                {
                    reference: "default-numbering",
                    levels: [
                        {
                            level: 0,
                            format: "decimal",
                            text: "%1.",
                            alignment: AlignmentType.START
                        }
                    ]
                }
            ]
        },
        sections: [
            {
                children: elementsToDocx(parseMarkdown(markdown))
            }
        ]
    });

    const blob = await Packer.toBlob(doc);

    // Trigger download
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${filename.replace(/[^a-zA-Z0-9-_]/g, "_")}.docx`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}
