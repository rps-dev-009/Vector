/**
 * LabsTopBar — the only chrome in Labs.
 *
 *   [menu] [document switcher ▾] · title (inline rename) · save state
 *                                      … [⌘K] [Export] [assistant toggle]
 *
 * The project list lives in the switcher dropdown (there is no permanent
 * third column). On mobile the bar adds a Document | Assistant segmented
 * control on a second row.
 */

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronDown, FileText, Plus, Upload, Pencil, Trash2, Check, Loader2,
  Download, PanelRight, PanelRightClose, Menu, Search, Sparkles, CloudOff
} from "lucide-react";
import { cn } from "../utils/cn.js";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");

function SaveState({ status, storageFull }) {
  if (storageFull) {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[11px] text-amber-400" title="Storage is full — export your work">
        <CloudOff size={11} /> Storage full
      </span>
    );
  }
  const map = {
    saved: { label: "Saved", className: "text-muted-foreground/70" },
    saving: { label: "Saving…", className: "text-muted-foreground" },
    unsaved: { label: "Unsaved", className: "text-muted-foreground/70" },
    error: { label: "Not saved", className: "text-destructive" }
  };
  const it = map[status] || map.saved;
  return (
    <span className={cn("hidden shrink-0 items-center gap-1 text-[11px] sm:flex", it.className)}>
      {status === "saving" ? <Loader2 size={10} className="animate-spin" /> : null}
      {it.label}
    </span>
  );
}

function ProjectSwitcher({
  projects, activeProject, onSelect, onNew, onImport, onRename, onDelete, importing
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState(null);
  const [draft, setDraft] = useState("");
  const ref = useRef(null);
  const renameRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onEsc = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setRenamingId(null);
    }
  }, [open]);

  useEffect(() => {
    if (renamingId) renameRef.current?.select();
  }, [renamingId]);

  const filtered = query.trim()
    ? projects.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()))
    : projects;

  const commitRename = (id) => {
    const name = draft.trim();
    if (name) onRename(id, name);
    setRenamingId(null);
  };

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors",
          open ? "bg-foreground/10 text-foreground" : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
        )}
        title="Switch document"
      >
        <FileText size={14} className="shrink-0" />
        <span className="hidden sm:inline">Documents</span>
        <ChevronDown size={13} className={cn("transition-transform", open && "rotate-180")} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.13, ease: [0.22, 1, 0.36, 1] }}
            className="labs-pop absolute left-0 top-full z-50 mt-1.5 w-[300px] overflow-hidden"
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Search size={13} className="shrink-0 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a document…"
                className="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>

            <div className="max-h-[300px] overflow-y-auto custom-scrollbar p-1.5">
              {filtered.length === 0 && (
                <p className="px-2.5 py-3 text-center text-xs text-muted-foreground">No documents match.</p>
              )}
              {filtered.map((p) => {
                const active = p.id === activeProject?.id;
                return (
                  <div
                    key={p.id}
                    className={cn(
                      "group flex items-center gap-2 rounded-lg px-2 py-1.5",
                      active ? "bg-primary/15" : "hover:bg-foreground/10"
                    )}
                  >
                    {renamingId === p.id ? (
                      <input
                        ref={renameRef}
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => commitRename(p.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(p.id);
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        className="min-w-0 flex-1 rounded border-b border-primary/50 bg-transparent text-xs text-foreground outline-none"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => { onSelect(p.id); setOpen(false); }}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <span className={cn("truncate text-xs", active ? "text-primary" : "text-foreground")}>
                          {p.name}
                        </span>
                        {active && <Check size={12} className="shrink-0 text-primary" />}
                      </button>
                    )}
                    {renamingId !== p.id && (
                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        <button
                          type="button"
                          title="Rename"
                          onClick={() => { setRenamingId(p.id); setDraft(p.name); }}
                          className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                        >
                          <Pencil size={11} />
                        </button>
                        <button
                          type="button"
                          title="Delete"
                          onClick={() => {
                            if (window.confirm(`Delete "${p.name}"? This cannot be undone.`)) onDelete(p.id);
                          }}
                          className="rounded p-1 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex items-center gap-1 border-t border-border p-1.5">
              <button
                type="button"
                onClick={() => { onNew(); setOpen(false); }}
                className="flex flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-foreground hover:bg-foreground/10"
              >
                <Plus size={13} /> New document
              </button>
              <button
                type="button"
                onClick={() => { onImport(); setOpen(false); }}
                disabled={importing}
                className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-50"
              >
                {importing ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} Import
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function DocumentTitle({ name, onRename, renameSignal }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  useEffect(() => {
    if (renameSignal) setEditing(true);
  }, [renameSignal]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== name) onRename(next);
    else setDraft(name);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") { setDraft(name); setEditing(false); }
        }}
        className="min-w-0 flex-1 rounded-md bg-foreground/5 px-1.5 py-0.5 text-sm font-medium text-foreground outline-none ring-1 ring-primary/40"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Rename document"
      className="min-w-0 flex-1 truncate rounded-md px-1.5 py-0.5 text-left text-sm font-medium text-foreground hover:bg-foreground/10"
    >
      {name}
    </button>
  );
}

export default function LabsTopBar({
  projects,
  activeProject,
  onSelectProject,
  onNewProject,
  onImportClick,
  onRenameProject,
  onDeleteProject,
  isImporting,
  saveStatus,
  storageFull,
  onExport,
  canExport,
  assistantOpen,
  onToggleAssistant,
  onOpenPalette,
  toggleSidebar,
  isMobile,
  mobileTab,
  onMobileTab,
  reviewCount,
  renameSignal
}) {
  return (
    <header className="shrink-0 border-b border-border bg-card">
      <div className="flex h-12 items-center gap-1.5 px-2 sm:px-3">
        <button
          type="button"
          onClick={toggleSidebar}
          className="shrink-0 rounded-lg p-2 text-muted-foreground hover:bg-foreground/10 hover:text-foreground md:hidden"
          aria-label="Open sidebar"
        >
          <Menu size={17} />
        </button>

        <ProjectSwitcher
          projects={projects}
          activeProject={activeProject}
          onSelect={onSelectProject}
          onNew={onNewProject}
          onImport={onImportClick}
          onRename={onRenameProject}
          onDelete={onDeleteProject}
          importing={isImporting}
        />

        <div className="mx-1 hidden h-5 w-px shrink-0 bg-border sm:block" />

        {activeProject ? (
          <DocumentTitle
            name={activeProject.name}
            onRename={(n) => onRenameProject(activeProject.id, n)}
            renameSignal={renameSignal}
          />
        ) : (
          <span className="flex-1 truncate px-1.5 text-sm text-muted-foreground">Labs</span>
        )}

        <SaveState status={saveStatus} storageFull={storageFull} />

        <div className="mx-1 hidden h-5 w-px shrink-0 bg-border sm:block" />

        <button
          type="button"
          onClick={onOpenPalette}
          title={`Command palette (${isMac ? "⌘" : "Ctrl"}+K)`}
          className="hidden shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-foreground/10 hover:text-foreground sm:flex"
        >
          <Search size={13} />
          <span className="labs-kbd">{isMac ? "⌘" : "Ctrl"}</span>
          <span className="labs-kbd">K</span>
        </button>

        <button
          type="button"
          onClick={onExport}
          disabled={!canExport}
          title="Export document"
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors",
            canExport
              ? "text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              : "cursor-not-allowed text-muted-foreground/40"
          )}
        >
          <Download size={14} />
          <span className="hidden lg:inline">Export</span>
        </button>

        {!isMobile && (
          <button
            type="button"
            onClick={onToggleAssistant}
            title={assistantOpen ? "Hide assistant" : "Show assistant"}
            className={cn(
              "relative shrink-0 rounded-lg p-2 transition-colors",
              assistantOpen
                ? "bg-foreground/10 text-foreground"
                : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            )}
          >
            {assistantOpen ? <PanelRightClose size={16} /> : <PanelRight size={16} />}
            {!assistantOpen && reviewCount > 0 && (
              <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />
            )}
          </button>
        )}
      </div>

      {isMobile && (
        <div className="flex items-center justify-center gap-2 border-t border-border/60 px-2 pb-2 pt-1.5">
          <div className="labs-segment">
            <button type="button" data-active={mobileTab === "document"} onClick={() => onMobileTab("document")}>
              <FileText size={12} /> Document
            </button>
            <button type="button" data-active={mobileTab === "assistant"} onClick={() => onMobileTab("assistant")}>
              <Sparkles size={12} /> Assistant
              {reviewCount > 0 && (
                <span className="ml-0.5 rounded-full bg-primary/20 px-1.5 text-[9px] text-primary">{reviewCount}</span>
              )}
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
