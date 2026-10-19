import { Extension } from "@tiptap/core";
import { BLOCK_NODE_TYPES } from "../constants/palette.js";
import { BLOCK_STYLE_KEYS, STYLE_SPEC, fontStack, resolveColor, resolveBlockStyle } from "../styles.js";

const cssNames = {
  fontSizePt: "font-size", lineHeight: "line-height",
  spaceBeforePt: "margin-top", spaceAfterPt: "margin-bottom",
  tableCellPaddingPt: "--table-padding", tableHeaderBackground: "--table-header",
  tableHeaderColor: "--table-header-ink", tableAlternateBackground: "--table-stripe",
  tableBorderColor: "--table-border"
};

function renderStyle(key, attrs, type) {
  const value = attrs[key];
  if (value == null) return {};
  const data = { [`data-labs-${key.toLowerCase()}`]: String(value) };
  if (key === "tableVariant") return STYLE_SPEC.tableVariants.includes(value) ? { ...data, "data-table-variant": value } : {};
  if (key === "fontFamily") return STYLE_SPEC.fonts.includes(value) ? { ...data, style: `font-family:${fontStack(value)}` } : {};
  if (STYLE_SPEC.numberAttrs[key]) {
    const [min, max] = STYLE_SPEC.numberAttrs[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return {};
    return { ...data, style: `${cssNames[key]}:${value}${key === "lineHeight" ? "" : "pt"}` };
  }
  const color = resolveColor(value, key === "backgroundColor" || key === "tableAlternateBackground");
  if (!color) return {};
  const resolved = resolveBlockStyle(type, attrs);
  if (key === "backgroundColor" && type === "table") return { ...data, style: `--table-header:${resolved.tableHeaderBackground};--table-header-ink:${resolved.tableHeaderColor}` };
  if (key === "backgroundColor") return { ...data, style: `background-color:${color};${!attrs.textColor ? `color:${resolved.textColor};` : ""}padding:4pt 8pt;border-radius:4px` };
  if (key === "textColor") return { ...data, style: `color:${color}` };
  if (key === "tableHeaderBackground") return { ...data, style: `--table-header:${color};--table-header-ink:${resolved.tableHeaderColor}` };
  return { ...data, style: `${cssNames[key]}:${color}` };
}

export const LabsBlockAttrs = Extension.create({
  name: "labsBlockAttrs",
  addGlobalAttributes() {
    return [
      { types: ["doc"], attributes: {
        documentStyle: { default: { preset: STYLE_SPEC.defaultPreset }, rendered: false }
      } },
      ...BLOCK_NODE_TYPES.map(type => ({ types: [type], attributes: Object.fromEntries(
        ["textColor", "backgroundColor", ...BLOCK_STYLE_KEYS].map(key => [key, {
          default: null,
          parseHTML: element => {
            const value = element.getAttribute(`data-labs-${key.toLowerCase()}`);
            if (value != null) return STYLE_SPEC.numberAttrs[key] ? Number(value) : value;
            if (key === "textColor") return element.style.color || null;
            if (key === "backgroundColor") return element.style.backgroundColor || null;
            return null;
          },
          renderHTML: attrs => renderStyle(key, attrs, type)
        }])
      ) }))
    ];
  }
});
