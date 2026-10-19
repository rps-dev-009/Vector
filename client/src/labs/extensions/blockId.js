/**
 * Labs blockId extension.
 *
 * - Adds a `blockId` attribute to every top-level block node type (rendered
 *   as data-block-id) so the server's edit events can target blocks by id.
 * - A ProseMirror appendTransaction plugin assigns fresh ids to top-level
 *   nodes that lack one (new nodes) or duplicate one (node splits), EXCEPT
 *   during labsEdit transactions where server-provided ids are canonical.
 * - IDs survive typing, splitting (split gets a new id) and moving (id
 *   travels with the node).
 *
 * A small custom extension instead of the UniqueID extension: the open-source
 * UniqueID marks every node (we only need top-level blocks) and generates
 * its own id format (we need ours to stay interchangeable with the server's
 * "b_xxxxxxxx" format so a document round-trips through localStorage and the
 * agent without renumbering).
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { BLOCK_NODE_TYPES, generateClientBlockId } from "../constants/palette.js";

export const labsBlockIdPluginKey = new PluginKey("labsBlockIdAssign");

/**
 * Walk a ProseMirror doc and assign ids to top-level nodes that lack one or
 * duplicate an earlier one. Mutates `tr` (setNodeMarkup) in place.
 * @returns {boolean} true when any assignment was made.
 */
export function assignMissingBlockIds(state, tr) {
  const seen = new Set();
  let changed = false;
  state.doc.forEach((node, pos) => {
    if (!BLOCK_NODE_TYPES.includes(node.type.name)) return;
    let id = node.attrs.blockId;
    if (!id || seen.has(id)) {
      id = generateClientBlockId(seen);
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, blockId: id });
      changed = true;
    }
    seen.add(id);
  });
  return changed;
}

export const LabsBlockId = Extension.create({
  name: "labsBlockId",

  addGlobalAttributes() {
    return [
      {
        types: BLOCK_NODE_TYPES,
        attributes: {
          blockId: {
            default: null,
            parseHTML: (element) => element.getAttribute("data-block-id"),
            renderHTML: (attributes) =>
              attributes.blockId ? { "data-block-id": attributes.blockId } : {}
          }
        }
      }
    ];
  },

  addProseMirrorPlugins() {
    const self = this;
    return [
      new Plugin({
        key: labsBlockIdPluginKey,
        appendTransaction: (transactions, oldState, newState) => {
          // Server-driven edits carry their own canonical ids.
          const onlyLabsEdits = transactions.every(
            (tr) => tr.getMeta("labsEdit") || tr.getMeta("labsBlockIdSkip")
          );
          if (onlyLabsEdits && transactions.length > 0) return null;
          if (!transactions.some((tr) => tr.docChanged)) return null;
          const tr = newState.tr;
          if (assignMissingBlockIds(newState, tr)) {
            tr.setMeta("labsBlockIdSkip", true);
            tr.setMeta("addToHistory", true);
            return tr;
          }
          return null;
        }
      })
    ];
  }
});

/**
 * Force id assignment on the current document (e.g. after import/migration).
 */
export function ensureBlockIds(editor) {
  const { state } = editor;
  const tr = state.tr;
  if (assignMissingBlockIds(state, tr)) {
    tr.setMeta("labsBlockIdSkip", true);
    editor.view.dispatch(tr);
  }
}
