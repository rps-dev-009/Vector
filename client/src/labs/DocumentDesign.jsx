import { useState } from "react";
import { useEditorState } from "@tiptap/react";
import { Palette, Check, ChevronDown, RotateCcw, X } from "lucide-react";
import { STYLE_SPEC, BLOCK_STYLE_KEYS, DOCUMENT_STYLE_ID, resolveDocumentStyle, resolveBlockStyle, fontStack } from "./styles.js";

export function selectedBlocks(editor) {
  const { from, to, empty } = editor.state.selection;
  const blocks = [];
  editor.state.doc.forEach((node, pos) => {
    if ((empty ? pos <= from && pos + node.nodeSize > from : pos < to && pos + node.nodeSize > from) && node.attrs.blockId) blocks.push({ node, pos });
  });
  return blocks;
}

export default function DocumentDesign({ editor, disabled, onManualStyle, pendingDocument, onKeepDocument, onRejectDocument }) {
  const [open, setOpen] = useState(false);
  const state = useEditorState({ editor, selector: ({ editor: ed }) => ({
    documentStyle: ed.state.doc.attrs.documentStyle,
    selected: selectedBlocks(ed).map(({ node }) => ({ type: node.type.name, attrs: node.attrs }))
  }) });
  const theme = resolveDocumentStyle(state.documentStyle);
  const selected = state.selected[0];
  const style = resolveBlockStyle(selected?.type || "paragraph", selected?.attrs, state.documentStyle);
  const table = state.selected.some(b => b.type === "table");

  const applyPreset = preset => {
    if (disabled) return;
    onManualStyle?.([DOCUMENT_STYLE_ID]);
    editor.view.dispatch(editor.state.tr.setDocAttribute("documentStyle", { preset }));
  };
  const apply = (values, tablesOnly = false) => {
    if (disabled) return;
    const blocks = selectedBlocks(editor).filter(b => !tablesOnly || b.node.type.name === "table");
    onManualStyle?.(blocks.map(b => b.node.attrs.blockId));
    const tr = editor.state.tr;
    for (const { node, pos } of blocks) tr.setNodeMarkup(pos, null, { ...node.attrs, ...values });
    if (tr.docChanged) editor.view.dispatch(tr);
  };
  const clearOverrides = Object.fromEntries([...BLOCK_STYLE_KEYS, "textColor", "backgroundColor", "textAlign"].map(k => [k, null]));
  const resetAll = () => {
    if (disabled) return;
    const ids = [];
    editor.state.doc.forEach(node => { if (node.attrs.blockId) ids.push(node.attrs.blockId); });
    onManualStyle?.(ids);
    const tr = editor.state.tr;
    editor.state.doc.forEach((node, pos) => {
      if (node.attrs.blockId) tr.setNodeMarkup(pos, null, { ...node.attrs, ...clearOverrides });
    });
    editor.view.dispatch(tr);
  };

  return (
    <div className="labs-design shrink-0 border-b border-border bg-card" onKeyDown={e => { if (e.key === "Escape") setOpen(false); }}>
      <div className="flex min-h-10 items-center gap-2 px-3">
        <button type="button" aria-expanded={open} aria-controls="labs-design-panel" onClick={() => setOpen(!open)} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-foreground hover:bg-foreground/10">
          <Palette size={14} className="text-primary" /> Document design
          <span className="hidden text-muted-foreground sm:inline">/ {theme.name}</span>
          <ChevronDown size={12} className={open ? "rotate-180" : ""} />
        </button>
        <span className="ml-auto hidden text-[10px] text-muted-foreground lg:inline">One style. Every page.</span>
        {pendingDocument && <div className="ml-auto flex items-center gap-1 text-[11px]">
          <span className="text-primary">Style changed</span>
          <button type="button" disabled={disabled} title="Keep document style" onClick={onKeepDocument} className="rounded p-1.5 hover:bg-foreground/10 disabled:opacity-40"><Check size={13} /></button>
          <button type="button" disabled={disabled} title="Revert document style" onClick={onRejectDocument} className="rounded p-1.5 hover:bg-foreground/10 disabled:opacity-40"><RotateCcw size={13} /></button>
        </div>}
      </div>
      {open && <div id="labs-design-panel" className="labs-scroll max-h-[min(430px,50vh)] overflow-y-auto border-t border-border p-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div><p className="text-sm font-medium">A considered look, instantly.</p><p className="mt-1 text-xs text-muted-foreground">Themes style the whole document. Your words and individual overrides stay intact.</p></div>
          <button type="button" aria-label="Close document design" onClick={() => setOpen(false)} className="rounded-lg p-1.5 hover:bg-foreground/10"><X size={14} /></button>
        </div>
        <div className="labs-theme-grid" role="group" aria-label="Document themes">
          {Object.entries(STYLE_SPEC.presets).map(([id, preset]) => <button
            key={id} type="button" disabled={disabled} aria-pressed={theme.preset === id}
            onClick={() => applyPreset(id)} className="labs-theme-choice" title={preset.description}
          >
            <span className="labs-theme-sample" style={{ color: preset.accent, fontFamily: fontStack(preset.headingFont) }}>
              <span className="labs-theme-letter">Aa</span>
              <span className="labs-theme-lines"><i /><i /></span>
              <span className="labs-theme-table" style={{ background: preset.tableAlternateBackground }}><i style={{ background: preset.tableHeaderBackground }} /><i /><i /></span>
            </span>
            <span className="mt-2 flex items-center justify-between text-[11px] font-medium">{preset.name}{theme.preset === id && <Check size={12} />}</span>
          </button>)}
        </div>
        <button type="button" disabled={disabled} onClick={resetAll} className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40" title="Remove block-level formatting overrides across the document. Text and inline emphasis are preserved. Undo restores them."><RotateCcw size={11} /> Reset all blocks to this theme</button>
        <fieldset disabled={disabled || !selected} className="mt-4 border-t border-border pt-3 disabled:opacity-50">
          <legend className="pr-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Selected {table ? "table / blocks" : "blocks"}</legend>
          <div className="labs-style-fields">
            <label>Font<select aria-label="Selected block font" value={style.fontFamily} onChange={e => apply({ fontFamily: e.target.value })}>{STYLE_SPEC.fonts.map(font => <option key={font}>{font}</option>)}</select></label>
            <label>Size (pt)<select aria-label="Selected block font size" value={style.fontSizePt} onChange={e => apply({ fontSizePt: Number(e.target.value) })}>{[...new Set([8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 30, 36, 48, style.fontSizePt])].sort((a,b) => a-b).map(n => <option key={n}>{n}</option>)}</select></label>
            <label>Line spacing<select aria-label="Selected block line spacing" value={style.lineHeight} onChange={e => apply({ lineHeight: Number(e.target.value) })}>{[...new Set([1, 1.22, 1.5, 1.65, 1.7, 2, 2.4, style.lineHeight])].sort((a,b) => a-b).map(n => <option key={n}>{n}</option>)}</select></label>
            <label>Space after (pt)<select aria-label="Selected block space after" value={style.spaceAfterPt} onChange={e => apply({ spaceAfterPt: Number(e.target.value) })}>{[...new Set([0, 4, 8, 9, 10, 12, 18, 24, 36, style.spaceAfterPt])].sort((a,b) => a-b).map(n => <option key={n}>{n}</option>)}</select></label>
            <label>Text<input aria-label="Selected block text color" type="color" value={style.textColor} onChange={e => apply({ textColor: e.target.value })} /></label>
            <label>Highlight<input aria-label="Selected block background color" type="color" value={style.backgroundColor || "#FFFFFF"} onChange={e => apply({ backgroundColor: e.target.value })} /></label>
          </div>
          {table && <div className="labs-style-fields mt-3">
            <label>Table style<select aria-label="Table style" value={style.tableVariant} onChange={e => apply({ tableVariant: e.target.value }, true)}>{STYLE_SPEC.tableVariants.map(v => <option key={v}>{v}</option>)}</select></label>
            <label>Header<input aria-label="Table header color" type="color" value={style.tableHeaderBackground} onChange={e => apply({ tableHeaderBackground: e.target.value, tableHeaderColor: null }, true)} /></label>
            <label>Header text<input aria-label="Table header text color" type="color" value={style.tableHeaderColor} onChange={e => apply({ tableHeaderColor: e.target.value }, true)} /></label>
            <label>Alternating rows<input aria-label="Table alternating row color" type="color" value={style.tableAlternateBackground} onChange={e => apply({ tableAlternateBackground: e.target.value }, true)} /></label>
            <label>Padding (pt)<select aria-label="Table cell padding" value={style.tableCellPaddingPt} onChange={e => apply({ tableCellPaddingPt: Number(e.target.value) }, true)}>{[...new Set([3, 6, 7, 8, 10, 12, 16, 18, style.tableCellPaddingPt])].sort((a,b) => a-b).map(n => <option key={n}>{n}</option>)}</select></label>
          </div>}
          <button type="button" onClick={() => apply(clearOverrides)} className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"><RotateCcw size={11} /> Reset selected blocks to theme</button>
        </fieldset>
      </div>}
    </div>
  );
}
