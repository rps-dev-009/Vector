/**
 * reviewStore — in-memory Keep/Reject state for one agent run.
 *
 * For every block the agent touches, the store captures the block's state
 * BEFORE the first edit of the run (full node JSON + the previous sibling's
 * blockId) so Reject restores it exactly — even if the model edited the same
 * block multiple times, and with all inline marks intact.
 *
 *   - inserted blocks:  before = null      -> Reject deletes them
 *   - deleted blocks:  before = nodeJSON   -> Reject reinserts after the
 *                                            previous sibling (or at start)
 *   - modified blocks: before = nodeJSON   -> Reject replaces current state
 *
 * Pending review state lives in memory only. On refresh everything counts as
 * kept (the document was already saved). This is a plain module (no React) so
 * the vitest suite can drive it against a real editor instance.
 */

import { findBlockByPos } from "./applyEdit.js";
import { editorToBlocks } from "./bridge/markdown.js";
import { resolveSpacerHeight } from "./styles.js";

export function createReviewStore() {
  let run = null;

  function newRun() {
    return {
      id: crypto.randomUUID(),
      status: "active", // active | done | error | aborted
      startedAt: Date.now(),
      steps: [],           // activity labels: {label, tool?, at}
      edits: [],           // applied edit events (server order)
      blocks: new Map(),   // blockId -> review entry
      unexpected: [],      // blocks changed without a matching edit event
      summary: "",
      done: null,          // the server's done payload
      error: null
    };
  }

  return {
    /** The active (or last) run. */
    getRun() {
      return run;
    },

    /**
     * Start a run: snapshot the pre-run document (blocks + full node JSONs)
     * for the unexpected-change check.
     */
    startRun(editor) {
      // A follow-up question must not silently accept outstanding edits.
      const pending = this.pendingEntries();
      run = newRun();
      run.preRun = snapshotDoc(editor);
      for (const entry of pending) run.blocks.set(entry.blockId, { ...entry, kept: false });
      return run;
    },

    addActivity(entry) {
      if (!run) return;
      run.steps.push({ ...entry, at: Date.now() });
    },

    /**
     * Capture the BEFORE state of a block on its first edit of the run.
     * Called from applyEdit's onBeforeEdit hook.
     */
    captureBeforeEdit(event, blockInfo) {
      if (!run || run.status !== "active") return;
      if (run.blocks.has(blockInfo.blockId)) return; // keep the FIRST before-state
      const original = run.preRun.nodes.find(node => node.id === blockInfo.blockId);
      run.blocks.set(blockInfo.blockId, {
        blockId: blockInfo.blockId,
        op: blockInfo.op,
        before: original?.nodeJSON ?? blockInfo.nodeJSON, // null for inserts
        beforeText: blockInfo.nodeJSON ? null : undefined,
        prevSiblingId: original ? original.prevSiblingId : blockInfo.prevSiblingId,
        originalPos: original ? original.originalPos : blockInfo.originalPos,
        originalOrder: original ? run.preRun.order : undefined,
        currentPreview: null,
        warnings: Array.isArray(event.warnings) ? [...event.warnings] : [],
        kept: false
      });
    },

    /**
     * Record that an edit event was applied (after the transaction). Updates
     * the entry's current preview text.
     */
    recordEdit(editor, event) {
      if (!run) return;
      run.edits.push(event);
      const entry = run.blocks.get(event.blockId);
      if (entry && event.op !== "delete") {
        const found = findBlockByPos(editor.state.doc, event.blockId);
        if (found) entry.currentPreview = previewOf(found.node);
      }
      if (entry && Array.isArray(event.warnings) && event.warnings.length) {
        const codes = new Set(entry.warnings.map((w) => w.code));
        for (const w of event.warnings) if (!codes.has(w.code)) entry.warnings.push(w);
      }
    },

    /** After the run: detect blocks that changed WITHOUT a matching edit. */
    finishRun(editor, donePayload, status) {
      if (!run) return run;
      run.status = status;
      run.done = donePayload || null;
      run.summary = donePayload?.summary || "";
      const post = snapshotDoc(editor);
      const postBlocks = post.blocks;
      run.unexpected = [];
      const editedIds = new Set(run.blocks.keys());
      const beforeById = new Map((run.preRun?.blocks || []).map((b) => [b.id, b]));
      const afterById = new Map(postBlocks.map((b) => [b.id, b]));

      // Changed or vanished blocks with no edit event -> unexpected change.
      for (const beforeBlock of run.preRun?.blocks || []) {
        if (editedIds.has(beforeBlock.id)) continue;
        const afterBlock = afterById.get(beforeBlock.id);
        const original = run.preRun.nodes.find(node => node.id === beforeBlock.id);
        const current = post.nodes.find(node => node.id === beforeBlock.id);
        const changed =
          afterBlock == null ||
          JSON.stringify(current?.nodeJSON) !== JSON.stringify(original?.nodeJSON);
        if (changed) {
          const nodeEntry = (run.preRun?.nodes || []).find((n) => n.id === beforeBlock.id);
          run.unexpected.push({
            blockId: beforeBlock.id,
            before: nodeEntry ? nodeEntry.nodeJSON : null,
            prevSiblingId: nodeEntry ? nodeEntry.prevSiblingId : null,
            originalPos: nodeEntry?.originalPos,
            originalOrder: run.preRun.order,
            reason: afterBlock == null ? "vanished" : "changed"
          });
        }
      }
      // New blocks that appeared without an insert event.
      for (const afterBlock of postBlocks) {
        if (editedIds.has(afterBlock.id)) continue;
        if (!beforeById.has(afterBlock.id)) {
          run.unexpected.push({
            blockId: afterBlock.id,
            before: null,
            prevSiblingId: null,
            reason: "appeared"
          });
        }
      }
      return run;
    },

    /** Mark one block as kept (clears its highlight). */
    keep(blockId) {
      const entry = run?.blocks.get(blockId);
      if (entry) entry.kept = true;
      for (const u of run?.unexpected || []) if (u.blockId === blockId) u.resolved = true;
    },

    /** All ids still pending review (edited + unexpected, not kept). */
    pendingIds() {
      if (!run) return { edited: [], unexpected: [] };
      return {
        edited: [...run.blocks.values()].filter((e) => !e.kept).map((e) => e.blockId),
        unexpected: (run.unexpected || []).filter((u) => !u.resolved).map((u) => u.blockId)
      };
    },

    /** Pending entries in document order (for the review list). */
    pendingEntries() {
      if (!run) return [];
      const edited = [...run.blocks.values()].filter((e) => !e.kept);
      const editedIds = new Set(edited.map((e) => e.blockId));
      const unexpected = (run.unexpected || []).filter(
        (u) => !u.resolved && !editedIds.has(u.blockId)
      );
      const all = [
        ...edited.map((e) => ({ kind: "edited", ...e })),
         ...unexpected.map((u) => ({ kind: "unexpected", op: "unexpected", ...u, warnings: [], kept: false }))
      ];
      return all.sort((a, b) => (a.originalPos ?? 0) - (b.originalPos ?? 0));
    },

    reset() {
      run = null;
    }
  };
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function previewOf(node) {
  if (node.type.name === "spacer") return `Blank space (${resolveSpacerHeight(node.attrs.heightPt)} pt)`;
  let text = "";
  node.descendants((n) => {
    if (n.isText) text += n.text;
    else if (n.type.name === "hardBreak") text += " ";
    return true;
  });
  return text.replace(/\s+/g, " ").trim().slice(0, 80);
}

function snapshotDoc(editor) {
  const state = editor.state;
  const blocks = [];
  const nodes = [];
  let prevId = null;
  state.doc.forEach((node, pos) => {
    const id = node.attrs?.blockId;
    if (!id) {
      prevId = null;
      return;
    }
    const block = editorToBlocks({ type: "doc", content: [node.toJSON()] })[0];
    if (block) blocks.push(block);
    nodes.push({ id, nodeJSON: node.toJSON(), prevSiblingId: prevId, originalPos: pos });
    prevId = id;
  });
  return { blocks, nodes, order: nodes.map(node => node.id) };
}
