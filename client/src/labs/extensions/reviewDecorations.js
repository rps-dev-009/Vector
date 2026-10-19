/**
 * Review decorations — ProseMirror node decorations driven by plugin state,
 * NOT marks in the document, so accepting/rejecting changes never touches the
 * document content itself.
 *
 *   labs-review-modified : blue/amber tint + left border (changed blocks)
 *   labs-review-added    : green tint + left border (inserted blocks)
 *
 * The DecorationSet is cached in plugin state and mapped through transactions,
 * so normal typing/edits do not trigger a full rescan.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export const labsReviewKey = new PluginKey("labsReviewDecorations");

function buildDecorations(doc, addedSet, modifiedSet) {
  const decorations = [];
  doc.forEach((node, pos) => {
    const id = node.attrs?.blockId;
    if (!id) return;
    if (addedSet.has(id)) {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "labs-review-added" }));
    } else if (modifiedSet.has(id)) {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "labs-review-modified" }));
    }
  });
  return DecorationSet.create(doc, decorations);
}

export const LabsReviewDecorations = Extension.create({
  name: "labsReviewDecorations",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: labsReviewKey,
        state: {
          init() {
            return { added: new Set(), modified: new Set(), deco: DecorationSet.empty };
          },
          apply(tr, value, oldState, newState) {
            const meta = tr.getMeta(labsReviewKey);
            if (meta) {
              return {
                added: meta.added,
                modified: meta.modified,
                deco: buildDecorations(newState.doc, meta.added, meta.modified)
              };
            }
            if (tr.docChanged && value.deco !== DecorationSet.empty) {
              // Node decorations move with content; remap positions.
              return { ...value, deco: value.deco.map(tr.mapping, tr.doc) };
            }
            return value;
          }
        },
        props: {
          decorations(state) {
            return labsReviewKey.getState(state)?.deco || null;
          }
        }
      })
    ];
  }
});

/**
 * Update the highlight sets. `pending` maps blockId -> entry where entries
 * with before === null are inserts (green); everything else is a
 * modification (blue/amber). Blocks not listed lose their highlight.
 */
export function updateReviewDecorations(editor, pending) {
  const added = new Set();
  const modified = new Set();
  for (const [blockId, entry] of pending || []) {
    if (entry.before == null) added.add(blockId);
    else modified.add(blockId);
  }
  const tr = editor.state.tr.setMeta(labsReviewKey, { added, modified });
  tr.setMeta("addToHistory", false);
  editor.view.dispatch(tr);
}
