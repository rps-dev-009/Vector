import { Node } from "@tiptap/core";
import { resolveSpacerHeight, STYLE_SPEC } from "../styles.js";

export const LabsSpacer = Node.create({
  name: "spacer",
  // Deliberately not in the block group: only the document accepts spacers.
  atom: true,
  selectable: true,
  marks: "",

  addAttributes() {
    return {
      heightPt: {
        default: STYLE_SPEC.spacer.defaultHeightPt,
        parseHTML: element => {
          const value = element.getAttribute("data-height-pt");
          return resolveSpacerHeight(value?.trim() ? Number(value) : undefined);
        },
        rendered: false
      }
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="labs-spacer"]' }];
  },

  renderHTML({ node }) {
    const heightPt = resolveSpacerHeight(node.attrs.heightPt);
    return ["div", {
      "data-type": "labs-spacer",
      "data-height-pt": String(heightPt),
      ...(node.attrs.blockId ? { "data-block-id": node.attrs.blockId } : {}),
      role: "img",
      "aria-label": `Blank space, ${heightPt} points`,
      contenteditable: "false",
      style: `height:${heightPt}pt;margin:0;padding:0;border:0;line-height:0;break-inside:avoid;page-break-inside:avoid`
    }];
  },

  renderText() {
    return "";
  },

  renderMarkdown() {
    return "";
  }
});
