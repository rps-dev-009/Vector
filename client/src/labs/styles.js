import spec from "../../../shared/labsStyles.json";

export const STYLE_SPEC = spec;
export const DOCUMENT_STYLE_ID = spec.documentStyleId;
export const BLOCK_STYLE_KEYS = [
  "fontFamily", "fontSizePt", "lineHeight", "spaceBeforePt", "spaceAfterPt",
  "tableVariant", "tableCellPaddingPt", ...spec.tableColorAttrs
];
export const SERVER_ATTR_KEYS = ["textColor", "backgroundColor", "align", "level", "language", ...BLOCK_STYLE_KEYS];

const namedColors = {
  black: "#111827", white: "#FFFFFF", gray: "#6B7280", grey: "#6B7280",
  red: "#DC2626", orange: "#C2410C", yellow: "#A16207", green: "#15803D",
  blue: "#2563EB", purple: "#7E22CE", pink: "#BE185D", brown: "#92400E"
};
const namedBackgrounds = {
  black: "#111827", white: "#FFFFFF", gray: "#F3F4F6", grey: "#F3F4F6",
  red: "#FEE2E2", orange: "#FFEDD5", yellow: "#FEF9C3", green: "#DCFCE7",
  blue: "#DBEAFE", purple: "#F3E8FF", pink: "#FCE7F3", brown: "#EFEBE9"
};

export function resolveColor(value, background = false) {
  if (typeof value !== "string") return null;
  if (/^#[\da-f]{6}$/i.test(value)) return value.toUpperCase();
  if (/^#[\da-f]{3}$/i.test(value)) return "#" + [...value.slice(1)].map(c => c + c).join("").toUpperCase();
  return (background ? namedBackgrounds : namedColors)[value.toLowerCase()] || null;
}

export function fontStack(font) {
  const safe = spec.fonts.includes(font) ? font : "Inter";
  return ["Georgia", "Cambria", "Times New Roman"].includes(safe)
    ? `"${safe}", Georgia, serif` : `"${safe}", "Segoe UI", Arial, sans-serif`;
}

export function resolveDocumentStyle(style = {}) {
  const preset = Object.hasOwn(spec.presets, style?.preset) ? style.preset : spec.defaultPreset;
  const theme = { ...spec.presets[preset], preset };
  if (spec.fonts.includes(style?.fontFamily)) theme.bodyFont = style.fontFamily;
  for (const key of ["fontSizePt", "lineHeight", "spaceAfterPt"]) {
    const value = style?.[key];
    const [min, max] = spec.numberAttrs[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) theme[key] = value;
  }
  if (typeof style?.marginMm === "number" && style.marginMm >= 12 && style.marginMm <= 32) theme.marginMm = style.marginMm;
  return theme;
}

/** One resolved style for the editor and both exporters, never PDF-only tints. */
export function resolveBlockStyle(type, attrs = {}, documentStyle = {}) {
  const theme = resolveDocumentStyle(documentStyle);
  const heading = type === "heading";
  const level = attrs.level || 1;
  const fontSizePt = heading ? (level === 1 ? theme.titleSizePt : level === 2 ? theme.headingSizePt : theme.subheadingSizePt) : theme.fontSizePt;
  const result = {
    fontFamily: heading ? theme.headingFont : theme.bodyFont,
    fontSizePt, lineHeight: heading ? 1.22 : theme.lineHeight,
    spaceBeforePt: heading ? (level === 1 ? 0 : 22) : 0,
    spaceAfterPt: heading ? 9 : theme.spaceAfterPt,
    textColor: heading ? theme.accent : theme.ink,
    backgroundColor: type === "blockquote" ? theme.soft : null, align: "left",
    tableHeaderBackground: theme.tableHeaderBackground,
    tableHeaderColor: theme.tableHeaderColor,
    tableAlternateBackground: theme.tableAlternateBackground,
    tableBorderColor: theme.tableBorderColor,
    tableCellPaddingPt: theme.tableCellPaddingPt, tableVariant: theme.tableVariant
  };
  if (spec.fonts.includes(attrs.fontFamily)) result.fontFamily = attrs.fontFamily;
  for (const [key, [min, max]] of Object.entries(spec.numberAttrs)) {
    if (typeof attrs[key] === "number" && Number.isFinite(attrs[key]) && attrs[key] >= min && attrs[key] <= max) result[key] = attrs[key];
  }
  if (["left", "center", "right", "justify"].includes(attrs.align)) result.align = attrs.align;
  if (spec.tableVariants.includes(attrs.tableVariant)) result.tableVariant = attrs.tableVariant;
  for (const key of ["textColor", "backgroundColor", ...spec.tableColorAttrs]) {
    const color = resolveColor(attrs[key], key === "backgroundColor" || key === "tableAlternateBackground");
    if (color) result[key] = color;
  }
  // Legacy table backgroundColor remains meaningful unless a header override exists.
  if (type === "table" && result.backgroundColor && !resolveColor(attrs.tableHeaderBackground)) {
    result.tableHeaderBackground = result.backgroundColor;
    if (!attrs.tableHeaderColor) result.tableHeaderColor = contrastingText(result.tableHeaderBackground);
  }
  if (resolveColor(attrs.tableHeaderBackground) && !resolveColor(attrs.tableHeaderColor)) result.tableHeaderColor = contrastingText(result.tableHeaderBackground);
  if (type !== "table" && result.backgroundColor && !resolveColor(attrs.textColor)) result.textColor = contrastingText(result.backgroundColor);
  return result;
}

function contrastingText(hex) {
  const values = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return values[0] * .2126 + values[1] * .7152 + values[2] * .0722 > .179 ? "#182431" : "#FFFFFF";
}

export function documentCssVariables(style) {
  const t = resolveDocumentStyle(style);
  return {
    "--doc-font": fontStack(t.bodyFont), "--doc-heading-font": fontStack(t.headingFont),
    "--doc-size": `${t.fontSizePt}pt`, "--doc-leading": t.lineHeight,
    "--doc-after": `${t.spaceAfterPt}pt`, "--doc-title-size": `${t.titleSizePt}pt`,
    "--doc-heading-size": `${t.headingSizePt}pt`, "--doc-subheading-size": `${t.subheadingSizePt}pt`,
    "--doc-ink": t.ink, "--doc-muted": t.muted, "--doc-accent": t.accent, "--doc-soft": t.soft,
    "--doc-table-header": t.tableHeaderBackground, "--doc-table-header-ink": t.tableHeaderColor,
    "--doc-table-stripe": t.tableAlternateBackground, "--doc-table-border": t.tableBorderColor,
    "--doc-table-padding": `${t.tableCellPaddingPt}pt`, "--doc-margin": `${t.marginMm}mm`
  };
}
