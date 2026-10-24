import { blockToNodeJSON } from "../labs/bridge/markdown.js";
import { STYLE_SPEC, resolveColor, resolveDocumentStyle, resolveBlockStyle, resolveSpacerHeight } from "../labs/styles.js";

function exportColor(value, background = false) {
    const color = resolveColor(value, background);
    return typeof color === "string" && /^#[\da-f]{6}$/i.test(color) ? color : null;
}

export const resolveTextHex = (value) => exportColor(value)?.slice(1) || null;
export const resolveBgHex = (value) => exportColor(value, true)?.slice(1) || null;

export function safeLink(value) {
    if (typeof value !== "string" || /[\u0000-\u0020\u007f]/.test(value)) return null;
    try {
        const url = new URL(value);
        return ["https:", "http:", "mailto:", "tel:"].includes(url.protocol) ? url.href : null;
    } catch {
        return null;
    }
}

function inlineRuns(nodes) {
    return (nodes || []).flatMap(node => {
        if (node.type === "hardBreak") return [{ break: true }];
        if (node.type !== "text") {
            // Never fetch images or other resources; preserve any accessible text.
            if (node.type === "image") return [{ text: node.attrs?.alt || "" }];
            return inlineRuns(node.content);
        }
        const run = { text: node.text || "" };
        for (const mark of node.marks || []) {
            const attrs = mark.attrs || {};
            if (["bold", "italic", "underline", "strike", "code"].includes(mark.type)) run[mark.type] = true;
            if (mark.type === "link") run.href = safeLink(attrs.href);
            if (mark.type === "highlight") run.backgroundColor = exportColor(attrs.color || "yellow", true);
            if (mark.type === "textStyle") {
                const color = exportColor(attrs.color);
                const background = exportColor(attrs.backgroundColor, true);
                if (color) run.color = color;
                if (background) run.backgroundColor = background;
                const family = typeof attrs.fontFamily === "string" ? attrs.fontFamily.replace(/^["']|["']$/g, "") : null;
                if (STYLE_SPEC.fonts.includes(family)) run.fontFamily = family;
                // Tiptap stores CSS sizes; Word expects points, not CSS pixels.
                const size = String(attrs.fontSize ?? "").match(/^(\d+(?:\.\d+)?)(pt|px)?$/);
                const points = size ? Number(size[1]) * (size[2] === "px" ? .75 : 1) : 0;
                if (points >= 1 && points <= 400) run.fontSizePt = points;
            }
        }
        return [run];
    });
}

function normalizeNode(node) {
    if (node.type === "spacer") return { type: "spacer", attrs: { heightPt: resolveSpacerHeight(node.attrs?.heightPt) } };
    const attrs = Object.fromEntries(Object.entries(node.attrs || {}).filter(([, value]) => value != null));
    for (const key of ["textColor", "backgroundColor", ...STYLE_SPEC.tableColorAttrs]) {
        if (attrs[key] && !exportColor(attrs[key], key === "backgroundColor" || key === "tableAlternateBackground")) delete attrs[key];
    }
    if (attrs.textAlign) attrs.align = attrs.textAlign;
    if (node.type === "heading") attrs.level = Math.min(6, Math.max(1, Math.floor(Number(attrs.level)) || 1));
    if (node.type === "orderedList") attrs.start = Math.min(2147483647, Math.max(1, Math.floor(Number(attrs.start)) || 1));
    if (node.type === "tableCell" || node.type === "tableHeader") {
        for (const key of ["colspan", "rowspan"]) attrs[key] = Math.min(100, Math.max(1, Math.floor(Number(attrs[key])) || 1));
    }
    const element = { type: node.type, attrs };
    if (["paragraph", "heading", "codeBlock"].includes(node.type)) {
        element.runs = inlineRuns(node.content);
    } else if (node.type === "text" || node.type === "image" || node.type === "hardBreak") {
        element.type = "paragraph";
        element.runs = inlineRuns([node]);
    } else {
        element.children = (node.content || []).map(normalizeNode);
    }
    return element;
}

/** Only legacy block input is parsed as Markdown; canonical JSON never round-trips. */
export function blocksToElements(blocks) {
    return (blocks || []).map(block => {
        const node = blockToNodeJSON({ ...block, text: typeof block.text === "string" ? block.text : "" });
        node.attrs = { ...node.attrs, ...block.attrs };
        return normalizeNode(node);
    });
}

export function createLabsExportModel(content, documentStyle, blocks) {
    const style = documentStyle ?? content?.attrs?.documentStyle ?? {};
    if (content != null && (content.type !== "doc" || (content.content != null && !Array.isArray(content.content)))) {
        throw new Error("Labs export requires a Tiptap document.");
    }
    return {
        documentStyle: style,
        theme: resolveDocumentStyle(style),
        elements: content ? (content.content || []).map(normalizeNode) : blocksToElements(blocks)
    };
}

export function elementStyle(element, documentStyle, inherited = {}) {
    return resolveBlockStyle(element.type, { ...inherited, ...element.attrs }, documentStyle);
}

export function tableCellStyle(tableStyle, cell, rowIndex) {
    const header = cell.type === "tableHeader";
    const backgroundColor = exportColor(cell.attrs.backgroundColor, true) || (header
        ? tableStyle.tableHeaderBackground
        : tableStyle.tableVariant === "striped" && rowIndex % 2 === 0
            ? tableStyle.tableAlternateBackground : "#FFFFFF");
    return {
        ...tableStyle,
        backgroundColor,
        textColor: exportColor(cell.attrs.textColor) || (header ? tableStyle.tableHeaderColor : tableStyle.textColor),
        spaceBeforePt: 0,
        spaceAfterPt: 0
    };
}

export function documentTitle(elements, maxLength) {
    const title = elements.find(element => element.type === "heading")?.runs.map(run => run.text || " ").join("") || "";
    if (!maxLength || title.length <= maxLength) return title;
    const prefix = title.replace(/\s+/g, " ").slice(0, maxLength - 3);
    return `${prefix.replace(/\s+\S*$/, "")}...`;
}
