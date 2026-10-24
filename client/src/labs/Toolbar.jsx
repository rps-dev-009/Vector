/**
 * Toolbar — compact formatting bar for the document canvas.
 *
 * Grouped controls (block type · marks · colour · alignment · table · history)
 * centred over the page, with the live AI state on the right. Everything is
 * disabled while the agent holds the document.
 */

import { useEffect, useRef, useState } from "react";
import { useEditorState } from "@tiptap/react";
import { createPortal } from "react-dom";
import {
  Bold, Italic, Underline, Strikethrough, Code2, Link2, Unlink,
  AlignLeft, AlignCenter, AlignRight, AlignJustify,
  List, ListOrdered, ListTodo, Quote, Minus, Heading1, Heading2, Heading3, Heading4, Heading5, Heading6,
  Pilcrow, Table as TableIcon, Rows3, Columns3,
  Undo2, Redo2, Trash2, ChevronDown, Baseline, Highlighter, X
} from "lucide-react";
import { cn } from "../utils/cn.js";
import { COLOR_SWATCHES, HIGHLIGHT_SWATCHES } from "./constants/palette.js";

function TB({ onClick, active, disabled, title, children }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "rounded-md p-1.5 transition-colors",
        active
          ? "bg-primary/15 text-primary"
          : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
        disabled && "cursor-not-allowed opacity-35 hover:bg-transparent hover:text-muted-foreground"
      )}
    >
      {children}
    </button>
  );
}

function Popover({ open, onClose, children, align = "left" }) {
  const ref = useRef(null);
  const anchorRef = useRef(null);
  const [position, setPosition] = useState(null);
  useEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current?.parentElement;
    const rect = anchor?.getBoundingClientRect();
    if (rect) setPosition({ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, window.innerWidth - 264)) });
    const handle = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const esc = (e) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", handle);
    document.addEventListener("keydown", esc);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", handle);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("resize", onClose);
    };
  }, [open, onClose]);
  return <span ref={anchorRef}>
    {open && position && createPortal(<div ref={ref} style={position} className="labs-pop fixed z-50 max-h-[60vh] overflow-y-auto p-1.5">{children}</div>, document.body)}
  </span>;
}

function SwatchGrid({ swatches, onPick, onClear, clearLabel }) {
  return (
    <div className="w-[188px]">
      <div className="grid grid-cols-6 gap-1">
        {swatches.map((s) => (
          <button
            key={s.name}
            type="button"
            title={s.name}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(s.hex)}
            className="h-7 w-7 rounded-lg border border-border/70 transition-transform hover:scale-110"
            style={{ background: s.hex }}
          />
        ))}
      </div>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClear}
        className="mt-1.5 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
      >
        <X size={12} /> {clearLabel}
      </button>
    </div>
  );
}

export default function Toolbar({ editor, aiActive }) {
  const [menu, setMenu] = useState(null);
  const [linkUrl, setLinkUrl] = useState("");

  useEffect(() => {
    if (!editor || aiActive) {
      setMenu(null);
      return;
    }
    let dom;
    const handleLinkShortcut = event => {
      if (!editor.isEditable || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      setLinkUrl(editor.getAttributes("link").href || "");
      setMenu("link");
    };
    const detach = () => {
      dom?.removeEventListener("keydown", handleLinkShortcut);
      dom = null;
    };
    const attach = () => {
      detach();
      if (editor.isDestroyed) return;
      dom = editor.view.dom;
      dom.addEventListener("keydown", handleLinkShortcut);
    };
    // React can mount the toolbar before EditorContent creates its view.
    editor.on("mount", attach);
    editor.on("unmount", detach);
    attach();
    return () => {
      detach();
      editor.off("mount", attach);
      editor.off("unmount", detach);
    };
  }, [editor, aiActive]);

  const state = useEditorState({
    editor,
    selector: ({ editor }) => {
      const inTable =
        editor.isActive("table") || editor.isActive("tableCell") || editor.isActive("tableHeader");
      let label = "Paragraph";
      if (editor.isActive("heading", { level: 1 })) label = "Heading 1";
      else if (editor.isActive("heading", { level: 2 })) label = "Heading 2";
      else if (editor.isActive("heading", { level: 3 })) label = "Heading 3";
      else if (editor.isActive("heading", { level: 4 })) label = "Heading 4";
      else if (editor.isActive("heading", { level: 5 })) label = "Heading 5";
      else if (editor.isActive("heading", { level: 6 })) label = "Heading 6";
      else if (editor.isActive("bulletList")) label = "Bullet list";
      else if (editor.isActive("orderedList")) label = "Numbered list";
      else if (editor.isActive("taskList")) label = "Task list";
      else if (editor.isActive("blockquote")) label = "Quote";
      else if (editor.isActive("codeBlock")) label = "Code block";
      return {
        inTable,
        label,
        bold: editor.isActive("bold"),
        italic: editor.isActive("italic"),
        underline: editor.isActive("underline"),
        strike: editor.isActive("strike"),
        code: editor.isActive("code"),
        link: editor.isActive("link"),
        canUndo: editor.can().undo(),
        canRedo: editor.can().redo(),
        alignLeft: editor.isActive({ textAlign: "left" }),
        alignCenter: editor.isActive({ textAlign: "center" }),
        alignRight: editor.isActive({ textAlign: "right" }),
        alignJustify: editor.isActive({ textAlign: "justify" }),
        bulletList: editor.isActive("bulletList"),
        orderedList: editor.isActive("orderedList"),
        taskList: editor.isActive("taskList"),
        blockquote: editor.isActive("blockquote"),
        codeBlock: editor.isActive("codeBlock")
      };
    }
  });

  if (!editor) return null;
  const close = () => setMenu(null);
  const toggle = (name) => setMenu(menu === name ? null : name);
  const chain = () => editor.chain().focus();
  const off = !!aiActive;

  const blockTypes = [
    { label: "Paragraph", icon: Pilcrow, action: () => chain().setParagraph().run() },
    { label: "Heading 1", icon: Heading1, action: () => chain().setHeading({ level: 1 }).run() },
    { label: "Heading 2", icon: Heading2, action: () => chain().setHeading({ level: 2 }).run() },
    { label: "Heading 3", icon: Heading3, action: () => chain().setHeading({ level: 3 }).run() },
    { label: "Heading 4", icon: Heading4, action: () => chain().setHeading({ level: 4 }).run() },
    { label: "Heading 5", icon: Heading5, action: () => chain().setHeading({ level: 5 }).run() },
    { label: "Heading 6", icon: Heading6, action: () => chain().setHeading({ level: 6 }).run() },
    { label: "Bullet list", icon: List, action: () => chain().toggleBulletList().run() },
    { label: "Numbered list", icon: ListOrdered, action: () => chain().toggleOrderedList().run() },
    { label: "Task list", icon: ListTodo, action: () => chain().toggleTaskList().run() },
    { label: "Quote", icon: Quote, action: () => chain().toggleBlockquote().run() },
    { label: "Code block", icon: Code2, action: () => chain().toggleCodeBlock().run() },
    { label: "Divider", icon: Minus, action: () => chain().setHorizontalRule().run() }
  ];

  return (
    <div className="shrink-0 border-b border-border bg-card">
      <div className="mx-auto flex max-w-[1100px] items-center gap-0.5 overflow-x-auto px-2 py-1.5 custom-scrollbar">
        {/* Block type */}
        <div className="relative shrink-0">
          <button
            type="button"
            disabled={off}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggle("type")}
            className={cn(
              "flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
              off
                ? "cursor-not-allowed text-muted-foreground/40"
                : "text-foreground hover:bg-foreground/10"
            )}
          >
            <span className="w-[86px] truncate text-left">{state.label}</span>
            <ChevronDown size={13} className="text-muted-foreground" />
          </button>
          <Popover open={menu === "type"} onClose={close}>
            <div className="w-44">
              {blockTypes.map((bt) => (
                <button
                  key={bt.label}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { bt.action(); close(); }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs",
                    state.label === bt.label
                      ? "bg-primary/15 text-primary"
                      : "text-foreground hover:bg-foreground/10"
                  )}
                >
                  <bt.icon size={14} /> {bt.label}
                </button>
              ))}
            </div>
          </Popover>
        </div>

        <span className="mx-1 h-5 w-px shrink-0 bg-border" />

        <TB disabled={off} title="Bold (Mod+B)" active={state.bold} onClick={() => chain().toggleBold().run()}><Bold size={15} /></TB>
        <TB disabled={off} title="Italic (Mod+I)" active={state.italic} onClick={() => chain().toggleItalic().run()}><Italic size={15} /></TB>
        <TB disabled={off} title="Underline (Mod+U)" active={state.underline} onClick={() => chain().toggleUnderline().run()}><Underline size={15} /></TB>
        <TB disabled={off} title="Strikethrough" active={state.strike} onClick={() => chain().toggleStrike().run()}><Strikethrough size={15} /></TB>
        <TB disabled={off} title="Inline code" active={state.code} onClick={() => chain().toggleCode().run()}><Code2 size={15} /></TB>

        <div className="relative shrink-0">
          <TB
            disabled={off}
            title="Link (Mod+K)"
            active={state.link}
            onClick={() => { setLinkUrl(editor.getAttributes("link").href || ""); toggle("link"); }}
          >
            <Link2 size={15} />
          </TB>
          <Popover open={menu === "link"} onClose={close}>
            <div className="flex w-60 flex-col gap-2 p-1">
              <input
                autoFocus
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const url = linkUrl.trim();
                    if (url) chain().extendMarkRange("link").setLink({ href: url }).run();
                    close();
                  }
                }}
                placeholder="https://…"
                className="w-full rounded-lg border border-[var(--input-border)] bg-[var(--input-surface)] px-2 py-1.5 text-xs text-foreground outline-none focus:border-[var(--input-border-focus)]"
              />
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (linkUrl.trim()) chain().extendMarkRange("link").setLink({ href: linkUrl.trim() }).run();
                    close();
                  }}
                  className="flex-1 rounded-lg bg-primary px-2 py-1.5 text-xs font-medium text-primary-foreground"
                >
                  Apply
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { chain().extendMarkRange("link").unsetLink().run(); close(); }}
                  className="flex items-center gap-1 rounded-lg bg-foreground/10 px-2 py-1.5 text-xs text-foreground"
                >
                  <Unlink size={12} /> Remove
                </button>
              </div>
            </div>
          </Popover>
        </div>

        <span className="mx-1 h-5 w-px shrink-0 bg-border" />

        <div className="relative shrink-0">
          <TB disabled={off} title="Text colour" onClick={() => toggle("color")}><Baseline size={15} /></TB>
          <Popover open={menu === "color"} onClose={close}>
            <SwatchGrid
              swatches={COLOR_SWATCHES}
              onPick={(name) => { chain().setColor(name).run(); close(); }}
              onClear={() => { chain().unsetColor().run(); close(); }}
              clearLabel="Clear text colour"
            />
          </Popover>
        </div>

        <div className="relative shrink-0">
          <TB disabled={off} title="Highlight" onClick={() => toggle("highlight")}><Highlighter size={15} /></TB>
          <Popover open={menu === "highlight"} onClose={close}>
            <SwatchGrid
              swatches={HIGHLIGHT_SWATCHES}
              onPick={(name) => { chain().setHighlight({ color: name }).run(); close(); }}
              onClear={() => { chain().unsetHighlight().run(); close(); }}
              clearLabel="Clear highlight"
            />
          </Popover>
        </div>

        <span className="mx-1 h-5 w-px shrink-0 bg-border" />

        <TB disabled={off} title="Align left" active={state.alignLeft} onClick={() => chain().setTextAlign("left").run()}><AlignLeft size={15} /></TB>
        <TB disabled={off} title="Align centre" active={state.alignCenter} onClick={() => chain().setTextAlign("center").run()}><AlignCenter size={15} /></TB>
        <TB disabled={off} title="Align right" active={state.alignRight} onClick={() => chain().setTextAlign("right").run()}><AlignRight size={15} /></TB>
        <TB disabled={off} title="Justify" active={state.alignJustify} onClick={() => chain().setTextAlign("justify").run()}><AlignJustify size={15} /></TB>

        <span className="mx-1 h-5 w-px shrink-0 bg-border" />

        <div className="relative shrink-0">
          <TB disabled={off} title={state.inTable ? "Table" : "Insert table"} active={state.inTable} onClick={() => toggle("table")}>
            <TableIcon size={15} />
          </TB>
          <Popover open={menu === "table"} onClose={close}>
            <div className="w-48">
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); close(); }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-foreground hover:bg-foreground/10"
              >
                <TableIcon size={14} /> Insert table
              </button>
              {state.inTable && (
                <>
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { chain().addRowAfter().run(); close(); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-foreground hover:bg-foreground/10"><Rows3 size={14} /> Add row</button>
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { chain().deleteRow().run(); close(); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-foreground hover:bg-foreground/10"><Trash2 size={14} /> Delete row</button>
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { chain().addColumnAfter().run(); close(); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-foreground hover:bg-foreground/10"><Columns3 size={14} /> Add column</button>
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { chain().deleteColumn().run(); close(); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-foreground hover:bg-foreground/10"><Trash2 size={14} /> Delete column</button>
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { chain().deleteTable().run(); close(); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-destructive hover:bg-destructive/10"><Trash2 size={14} /> Delete table</button>
                </>
              )}
            </div>
          </Popover>
        </div>

        <span className="mx-1 h-5 w-px shrink-0 bg-border" />

        <TB disabled={off || !state.canUndo} title="Undo (Mod+Z)" onClick={() => chain().undo().run()}><Undo2 size={15} /></TB>
        <TB disabled={off || !state.canRedo} title="Redo (Mod+Shift+Z)" onClick={() => chain().redo().run()}><Redo2 size={15} /></TB>

        {off && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 rounded-full bg-primary/15 px-2.5 py-1 text-[11px] font-medium text-primary">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
            </span>
            AI is writing
          </span>
        )}
      </div>
    </div>
  );
}
