import { Extension, commands as coreCommands } from "@tiptap/core";
import { BLOCK_NODE_TYPES } from "../constants/palette.js";
import { BLOCK_STYLE_KEYS, STYLE_SPEC, fontStack, resolveColor, resolveBlockStyle } from "../styles.js";

const cssNames = {
  fontSizePt: "font-size", lineHeight: "line-height",
  spaceBeforePt: "margin-top", spaceAfterPt: "margin-bottom",
  tableCellPaddingPt: "--table-padding", tableHeaderBackground: "--table-header",
  tableHeaderColor: "--table-header-ink", tableAlternateBackground: "--table-stripe",
  tableBorderColor: "--table-border"
};

const paragraphDefaults = Object.fromEntries(
  ["textColor", "backgroundColor", "textAlign", ...BLOCK_STYLE_KEYS].map(key => [key, null])
);

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
  addCommands() {
    return {
      setParagraph: () => props => {
        const { from, to } = props.tr.selection;
        const blocks = [];
        props.tr.doc.nodesBetween(from, to, (node, pos) => {
          if (["heading", "paragraph"].includes(node.type.name)) blocks.push({ node, pos });
        });
        const mappingStart = props.tr.mapping.maps.length;
        const changed = coreCommands.setNode("paragraph")(props);
        if (changed && props.dispatch) {
          const mapping = props.tr.mapping.slice(mappingStart);
          for (const { node, pos } of blocks) {
            const mapped = mapping.map(pos);
            const current = props.tr.doc.nodeAt(mapped);
            if (current?.type.name !== "paragraph") continue;
            const attrs = node.type.name === "heading" ? { ...node.attrs, ...paragraphDefaults } : node.attrs;
            props.tr.setNodeMarkup(mapped, undefined, attrs);
          }
        }
        return changed;
      },
      splitBlock: options => props => {
        const leavingHeading = props.tr.selection.$from.parent.type.name === "heading";
        const split = coreCommands.splitBlock(options)(props);
        const { $from } = props.tr.selection;
        if (split && props.dispatch && leavingHeading && $from.parent.type.name === "paragraph") {
          // Do not disable keepOnSplit globally: paragraphs and headings split
          // in the middle should still continue their own formatting.
          const marks = props.tr.storedMarks;
          props.tr.setNodeMarkup($from.before(), undefined, { ...$from.parent.attrs, ...paragraphDefaults });
          props.tr.setStoredMarks(marks);
        }
        return split;
      }
    };
  },
  addGlobalAttributes() {
    return [
      { types: ["doc"], attributes: {
        documentStyle: { default: { preset: STYLE_SPEC.defaultPreset }, rendered: false }
      } },
      ...BLOCK_NODE_TYPES.filter(type => type !== "spacer").map(type => ({ types: [type], attributes: Object.fromEntries(
        ["textColor", "backgroundColor", ...BLOCK_STYLE_KEYS].map(key => [key, {
          default: null,
          parseHTML: element => {
            const value = element.getAttribute(`data-labs-${key.toLowerCase()}`);
            if (value != null) return STYLE_SPEC.numberAttrs[key] ? Number(value) : value;
            if (key === "textColor") return resolveColor(element.style.color);
            if (key === "backgroundColor") return resolveColor(element.style.backgroundColor, true);
            return null;
          },
          renderHTML: attrs => renderStyle(key, attrs, type)
        }])
      ) }))
    ];
  }
});
