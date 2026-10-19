/**
 * CommandPalette — ⌘K / Ctrl+K for Labs: switch documents and run the
 * actions that are otherwise one dropdown away. Keyboard driven, no mouse
 * required: type to filter, ↑/↓ to move, Enter to run, Esc to close.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Search, FileText, Plus, Upload, Download, PanelRight, Pencil, CornerDownLeft
} from "lucide-react";
import { cn } from "../utils/cn.js";

export default function CommandPalette({
  open,
  onClose,
  projects,
  activeProjectId,
  onSelectProject,
  onNewProject,
  onImport,
  onExport,
  onToggleAssistant,
  assistantOpen,
  onRenameRequest
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef(null);

  const items = useMemo(() => {
    const actions = [
      { id: "new", icon: Plus, label: "New document", hint: "Create", run: onNewProject },
      { id: "import", icon: Upload, label: "Import document", hint: ".txt, .md, .docx", run: onImport },
      { id: "export", icon: Download, label: "Export document", hint: ".docx or .pdf", run: onExport },
      {
        id: "assistant",
        icon: PanelRight,
        label: assistantOpen ? "Hide assistant" : "Show assistant",
        hint: "Layout",
        run: onToggleAssistant
      },
      { id: "rename", icon: Pencil, label: "Rename this document", hint: "Title", run: onRenameRequest }
    ];
    const docs = projects.map((p) => ({
      id: `doc:${p.id}`,
      icon: FileText,
      label: p.name,
      hint: p.id === activeProjectId ? "Current" : "Document",
      run: () => onSelectProject(p.id)
    }));
    const all = [...docs, ...actions];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((it) => it.label.toLowerCase().includes(q));
  }, [projects, activeProjectId, query, assistantOpen, onNewProject, onImport, onExport, onToggleAssistant, onRenameRequest, onSelectProject]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setIndex(0);
    }
  }, [open]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setIndex((i) => (items.length ? (i + 1) % items.length : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setIndex((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const it = items[index];
        if (it) {
          onClose();
          it.run?.();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, items, index, onClose]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${index}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [index]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] bg-black/50 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -10 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            className="labs-pop fixed left-1/2 top-[14vh] z-[71] w-[480px] max-w-[94vw] -translate-x-1/2 overflow-hidden"
            role="dialog"
            aria-modal="true"
          >
            <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
              <Search size={15} className="shrink-0 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search documents and actions…"
                className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
              <span className="labs-kbd shrink-0">Esc</span>
            </div>

            <div ref={listRef} className="max-h-[340px] overflow-y-auto custom-scrollbar p-1.5">
              {items.length === 0 && (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">No matches.</p>
              )}
              {items.map((it, i) => (
                <button
                  key={it.id}
                  type="button"
                  data-idx={i}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => { onClose(); it.run?.(); }}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left",
                    i === index ? "bg-primary/15" : "hover:bg-foreground/10"
                  )}
                >
                  <it.icon size={14} className={cn("shrink-0", i === index ? "text-primary" : "text-muted-foreground")} />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">{it.label}</span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/60">{it.hint}</span>
                  {i === index && <CornerDownLeft size={12} className="shrink-0 text-primary" />}
                </button>
              ))}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
