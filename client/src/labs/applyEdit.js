/**
 * applyEdit — apply server `edit` events to the Tiptap editor.
 *
 * THE INVARIANT: edits are located by blockId, never by position. Events that
 * arrive together (a batched tool step can produce 15-18 of them) are applied
 * in ONE transaction with the `labsEdit` meta so history treats them as a
 * single undo unit.
 *
 * Operations (per the real server payloads in server/labs/tools.js):
 *   replace          {blockId, before, after, attrs?}   whole-block rewrite
 *   replace_in_block {blockId, before, after}           in-block text change
 *   insert           {blockId, afterId, after, type, attrs?} new block
 *   delete           {blockId, before}                 block removal
 *   set_attrs        {blockId, attrs, after}           attrs map (full state;
 *                    absent keys mean cleared after Phase 2 Step 0a)
 *
 * replace_in_block has two paths:
 *   - RANGE path: when the target node is a paragraph/heading and its plain
 *     text equals `before`, jsdiff locates the changed span; only that text
 *     range is replaced, so inline marks elsewhere in the block survive.
 *   - FALLBACK path: the new block text is parsed from markdown and the whole
 *     node is replaced (inline marks inside it are lost — documented).
 *   Usage of both paths is counted in `ctx.usage` for observability.
 *
 * If a target blockId is missing the edit is skipped and recorded in
 * `ctx.skipped` (the caller shows a visible warning in the run) — the stream
 * continues.
 */

import { diffWords } from "diff";
import { closeHistory } from "@tiptap/pm/history";
import { blockToNodeJSON, nodeToBlock } from "./bridge/markdown.js";
import { BLOCK_STYLE_KEYS, SERVER_ATTR_KEYS, DOCUMENT_STYLE_ID } from "./styles.js";

export function createApplyContext() {
  return {
    usage: { rangePath: 0, fallbackPath: 0, wholeBlockReplaces: 0, inserts: 0, deletes: 0, attrSets: 0 },
    skipped: []
  };
}

/**
 * Find a top-level node (and its position) by blockId.
 * @param {ProseMirrorNode} doc state doc (or a transaction's evolving doc)
 */
export function findBlockByPos(doc, blockId) {
  let found = null;
  doc.forEach((node, pos) => {
    if (found === null && node.attrs?.blockId === blockId) {
      found = { pos, node };
    }
  });
  return found;
}

/**
 * The block's plain text in the SAME space as server block text: text nodes
 * contribute their text, hardBreaks contribute "\n".
 */
export function blockPlainText(node) {
  let out = "";
  node.descendants((child) => {
    if (child.isText) out += child.text;
    else if (child.type.name === "hardBreak") out += "\n";
    return true;
  });
  return out;
}

/**
 * Map a character offset in blockPlainText space to a document position
 * inside the node. Returns null when the offset cannot be represented
 * exactly (e.g. it points into the middle of a hardBreak).
 */
function charOffsetToPos(node, nodePos, offset) {
  const innerStart = nodePos + 1;
  let acc = 0;
  let result = null;
  node.content.forEach((child, childOffset) => {
    if (result !== null) return;
    const childPos = innerStart + childOffset;
    const len = child.isText ? child.text.length : child.type.name === "hardBreak" ? 1 : 0;
    if (len === 0) return;
    if (offset <= acc + len) {
      // Boundary cases resolve to the position after the consumed characters.
      result = childPos + (offset - acc);
    } else {
      acc += len;
    }
  });
  if (result === null && offset === acc) result = innerStart + node.content.size;
  return result;
}

/** Plain text of a parsed node JSON (text nodes + "\n" for hardBreaks). */
function plainTextOfJSON(nodeJSON) {
  let out = "";
  for (const child of nodeJSON.content || []) {
    if (child.type === "text") out += child.text || "";
    else if (child.type === "hardBreak") out += "\n";
  }
  return out;
}

/** Extract the server-visible attrs from a top-level node. */
function attrsFromNode(node) {
  const attrs = {};
  if (node.attrs.level != null) attrs.level = node.attrs.level;
  if (node.attrs.language) attrs.language = node.attrs.language;
  if (node.attrs.textColor) attrs.textColor = node.attrs.textColor;
  if (node.attrs.backgroundColor) attrs.backgroundColor = node.attrs.backgroundColor;
  if (node.attrs.textAlign) attrs.align = node.attrs.textAlign;
  for (const key of BLOCK_STYLE_KEYS) if (node.attrs[key] != null) attrs[key] = node.attrs[key];
  return attrs;
}

/** Node attrs for the whole-block fallback / replace paths. */
function nodeJSONForText(doc, pos, node, blockId, text, extraAttrs) {
  const current = attrsFromNode(node);
  const merged = { ...current, ...(extraAttrs || {}) };
  const block = { id: blockId, type: node.type.name, text, attrs: merged };
  return { block, nodeJSON: blockToNodeJSON(block) };
}

/** id of the top-level sibling before `pos`, or null. */
function prevSiblingBlockId(doc, pos) {
  let prev = null;
  doc.forEach((n, p) => {
    if (p >= pos) return false;
    prev = n.attrs?.blockId ?? null;
  });
  return prev;
}

/**
 * Apply a batch of edit events in ONE transaction.
 *
 * @param {Editor} editor Tiptap editor instance
 * @param {Array} events SSE edit events in arrival order
 * @param {Object} ctx createApplyContext() counters
 * @param {Object} hooks { onBeforeEdit(event, blockInfo) } — called before
 *        the first mutation of a block so the review store can capture the
 *        node's state (blockInfo: {blockId, op, nodeJSON, prevSiblingId,
 *        originalPos, exists}).
 */
export function applyEditEvents(editor, events, ctx, hooks = {}) {
  if (!events?.length) return;
  const state = editor.state;
  const tr = state.tr;
  tr.setMeta("labsEdit", true);
  tr.setMeta("labsEditIds", events.map((e) => e.editId).filter(Boolean));

  for (const event of events) {
    const blockId = event.blockId;

    if (event.op === "set_document_style") {
      hooks.onBeforeEdit?.(event, {
        blockId: DOCUMENT_STYLE_ID, op: event.op, exists: true, originalPos: -1,
        nodeJSON: { type: "doc", attrs: { documentStyle: { ...tr.doc.attrs.documentStyle } } }
      });
      tr.setDocAttribute("documentStyle", { ...event.after });
      ctx.usage.attrSets += 1;
      continue;
    }

    // ── insert: use the server-provided id as-is ──
    if (event.op === "insert") {
      const block = {
        id: blockId,
        type: event.type || "paragraph",
        text: event.after ?? "",
        attrs: event.attrs || {}
      };
      let newNode;
      try {
        newNode = state.schema.nodeFromJSON(blockToNodeJSON(block));
      } catch (err) {
        ctx.skipped.push({ editId: event.editId, blockId, op: "insert", reason: String(err?.message || err) });
        continue;
      }
      let insertPos = 0;
      if (event.afterId != null) {
        const anchor = findBlockByPos(tr.doc, event.afterId);
        if (!anchor) {
          ctx.skipped.push({ editId: event.editId, blockId, op: "insert", reason: `afterId ${event.afterId} not found` });
          continue;
        }
        insertPos = anchor.pos + anchor.node.nodeSize;
      }
      hooks.onBeforeEdit?.(event, { blockId, op: "insert", nodeJSON: null, exists: false });
      tr.insert(insertPos, newNode);
      ctx.usage.inserts += 1;
      continue;
    }

    // All other ops target an existing block by id.
    const target = findBlockByPos(tr.doc, blockId);
    if (!target) {
      ctx.skipped.push({ editId: event.editId, blockId, op: event.op, reason: "blockId not found" });
      continue;
    }

    const { pos, node } = target;
    const blockInfo = {
      blockId,
      op: event.op,
      nodeJSON: node.toJSON(),
      prevSiblingId: prevSiblingBlockId(tr.doc, pos),
      originalPos: pos,
      exists: true
    };

    switch (event.op) {
      case "replace": {
        const { nodeJSON } = nodeJSONForText(tr.doc, pos, node, blockId, event.after ?? "", event.attrs);
        try {
          const newNode = tr.doc.type.schema.nodeFromJSON(nodeJSON);
          hooks.onBeforeEdit?.(event, blockInfo);
          tr.replaceWith(pos, pos + node.nodeSize, newNode);
          ctx.usage.wholeBlockReplaces += 1;
        } catch (err) {
          ctx.skipped.push({ editId: event.editId, blockId, op: event.op, reason: String(err?.message || err) });
        }
        break;
      }

      case "replace_in_block": {
        hooks.onBeforeEdit?.(event, blockInfo);
        const beforeText = event.before ?? "";
        const afterText = event.after ?? "";
        let applied = false;

        // RANGE path — for plain-text containers (paragraphs, headings).
        // The event's before/after are MARKDOWN strings (with ** ` etc.),
        // while the node holds marks — so we parse both through the bridge
        // and diff their PLAIN text. When the plain(before) matches the
        // node's current plain text, the changed plain-text range is spliced
        // and every inline mark outside the range survives.
        if (
          (node.type.name === "paragraph" || node.type.name === "heading") &&
          beforeText !== afterText
        ) {
          try {
            const parsedBeforeJSON = blockToNodeJSON({
              id: blockId, type: node.type.name, text: beforeText, attrs: {}
            });
            const parsedAfterJSON = blockToNodeJSON({
              id: blockId, type: node.type.name, text: afterText, attrs: {}
            });
            const plainB = plainTextOfJSON(parsedBeforeJSON);
            const plainA = plainTextOfJSON(parsedAfterJSON);
            if (plainB === blockPlainText(node) && plainB !== plainA) {
              const parts = diffWords(plainB, plainA);
              const firstChange = parts.findIndex((p) => p.added || p.removed);
              if (firstChange !== -1) {
                let lastChange = parts.length - 1;
                while (lastChange > firstChange && !parts[lastChange].added && !parts[lastChange].removed) {
                  lastChange -= 1;
                }
                const prefix = parts.slice(0, firstChange).map((p) => p.value).join("");
                const suffix = parts.slice(lastChange + 1).map((p) => p.value).join("");
                const replacement = parts
                  .slice(firstChange, lastChange + 1)
                  .filter((p) => p.added)
                  .map((p) => p.value)
                  .join("");
                const rangeStart = prefix.length;
                const rangeEnd = plainB.length - suffix.length;
                const from = charOffsetToPos(node, pos, rangeStart);
                const to = charOffsetToPos(node, pos, rangeEnd);
                if (from !== null && to !== null && to >= from) {
                  tr.insertText(replacement, from, to);
                  ctx.usage.rangePath += 1;
                  applied = true;
                }
              }
            }
          } catch {
            // Parsing the texts failed — fall through to the fallback path.
          }
        }

        // FALLBACK path — parse the new block text and replace the node.
        if (!applied) {
          const { nodeJSON } = nodeJSONForText(tr.doc, pos, node, blockId, afterText);
          try {
            const newNode = tr.doc.type.schema.nodeFromJSON(nodeJSON);
            tr.replaceWith(pos, pos + node.nodeSize, newNode);
            ctx.usage.fallbackPath += 1;
          } catch (err) {
            ctx.skipped.push({ editId: event.editId, blockId, op: event.op, reason: String(err?.message || err) });
          }
        }
        break;
      }

      case "delete": {
        hooks.onBeforeEdit?.(event, blockInfo);
        tr.delete(pos, pos + node.nodeSize);
        ctx.usage.deletes += 1;
        break;
      }

      case "set_attrs": {
        hooks.onBeforeEdit?.(event, blockInfo);
        const next = { ...node.attrs };
        const attrs = event.attrs ?? (event.after && typeof event.after === "object" ? event.after : {});
        for (const key of SERVER_ATTR_KEYS) {
          const serverKey = key === "align" ? "align" : key;
          if (attrs[serverKey] == null) {
            next[key === "align" ? "textAlign" : key] = null;
          } else {
            next[key === "align" ? "textAlign" : key] = attrs[serverKey];
          }
        }
        tr.setNodeMarkup(pos, null, next);
        ctx.usage.attrSets += 1;
        break;
      }

      default: {
        ctx.skipped.push({ editId: event.editId, blockId, op: event.op, reason: "unknown op" });
      }
    }
  }

  if (tr.docChanged) {
    editor.view.dispatch(tr);
  }
}

/** Convenience wrapper for a single event. */
export function applyEditEvent(editor, event, ctx, hooks) {
  applyEditEvents(editor, [event], ctx, hooks);
}

/**
 * Restore a review entry's block: reinsert the captured node JSON after its
 * captured previous sibling (or at the document start), replacing whatever
 * currently sits at that blockId (or nothing, for deleted blocks).
 * Accepts review-store entries ({blockId, before, prevSiblingId}) and the
 * applyEdit blockInfo shape ({blockId, nodeJSON, prevSiblingId}).
 */
export function restoreBlock(editor, entry) {
  return entry ? restoreEntries(editor, [entry]) : false;
}

/** Reject a selection of changes atomically. A false result must stay reviewable. */
export function restoreEntries(editor, entries) {
  if (!editor || editor.isDestroyed || !entries?.length) return false;
  try {
    const state = editor.state;
    // Parse every snapshot before changing anything, including document styles.
    const prepared = entries.map(entry => {
      if (!entry?.blockId) throw new Error("The original block id is missing.");
      const before = Object.hasOwn(entry, "before") ? entry.before : entry.nodeJSON;
      if (before === undefined) throw new Error("The original block snapshot is missing.");
      if (entry.blockId === DOCUMENT_STYLE_ID) {
        if (!before?.attrs?.documentStyle) throw new Error("The original document style is missing.");
        return { entry, documentStyle: before.attrs.documentStyle };
      }
      const node = before === null ? null : state.schema.nodeFromJSON(before);
      if (node) {
        node.check();
        if (node.attrs.blockId !== entry.blockId) throw new Error("The original block id does not match its snapshot.");
      }
      return { entry, node };
    });
    const nodes = [];
    state.doc.forEach(node => nodes.push(node));
    const indexOf = id => nodes.findIndex(node => node.attrs.blockId === id);

    // Remove added blocks first so no restoration is anchored to an AI insert.
    for (const item of prepared) {
      if (item.documentStyle || item.node) continue;
      const index = indexOf(item.entry.blockId);
      if (index !== -1) nodes.splice(index, 1);
    }
    const originals = prepared.filter(item => item.node).sort((a, b) => (a.entry.originalPos ?? 0) - (b.entry.originalPos ?? 0));
    for (const { entry, node } of originals) {
      const current = indexOf(entry.blockId);
      if (current !== -1) {
        // Replace in place. Delete-then-insert moved blocks and manufactured
        // empty filler paragraphs when restoring a single-block document.
        nodes[current] = node;
        continue;
      }
      let insertion = -1;
      const order = entry.originalOrder || [];
      const originalIndex = order.indexOf(entry.blockId);
      if (originalIndex !== -1) {
        for (let i = originalIndex - 1; i >= 0; i--) {
          const previous = indexOf(order[i]);
          if (previous !== -1) { insertion = previous + 1; break; }
        }
        if (insertion === -1) {
          for (let i = originalIndex + 1; i < order.length; i++) {
            const next = indexOf(order[i]);
            if (next !== -1) { insertion = next; break; }
          }
        }
      } else if (entry.prevSiblingId) {
        const previous = indexOf(entry.prevSiblingId);
        if (previous !== -1) insertion = previous + 1;
      }
      nodes.splice(insertion === -1 ? 0 : insertion, 0, node);
    }

    const tr = closeHistory(state.tr).setMeta("labsEdit", true)
      .setMeta("labsEditIds", entries.map(entry => `restore:${entry.blockId}`));
    for (const item of prepared) if (item.documentStyle) tr.setDocAttribute("documentStyle", { ...item.documentStyle });
    // Replace only the changed range; untouched leading/trailing blocks retain
    // their positions, selections and decorations wherever possible.
    const beforeNodes = [];
    state.doc.forEach(node => beforeNodes.push(node));
    let prefix = 0, suffix = 0;
    while (prefix < nodes.length && prefix < beforeNodes.length && nodes[prefix].eq(beforeNodes[prefix])) prefix++;
    while (suffix < nodes.length - prefix && suffix < beforeNodes.length - prefix && nodes[nodes.length - 1 - suffix].eq(beforeNodes[beforeNodes.length - 1 - suffix])) suffix++;
    const from = beforeNodes.slice(0, prefix).reduce((pos, node) => pos + node.nodeSize, 0);
    const to = state.doc.content.size - beforeNodes.slice(beforeNodes.length - suffix).reduce((size, node) => size + node.nodeSize, 0);
    const replacement = nodes.slice(prefix, nodes.length - suffix);
    if (from !== to || replacement.length) tr.replaceWith(from, to, replacement);
    if (tr.docChanged) editor.view.dispatch(tr);

    // dispatch may be refused by a plugin. Do not claim success just because
    // a transaction was created (or hide the controls after such a failure).
    return prepared.every(({ entry, node, documentStyle }) => {
      if (documentStyle) return JSON.stringify(editor.state.doc.attrs.documentStyle) === JSON.stringify(documentStyle);
      const restored = findBlockByPos(editor.state.doc, entry.blockId);
      return node ? Boolean(restored?.node.eq(node)) : restored === null;
    });
  } catch (err) {
    console.error("[Labs] restore failed:", err?.message || err);
    return false;
  }
}
