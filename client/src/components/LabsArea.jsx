import React, { useState, useEffect, useRef, useCallback, Suspense, lazy } from "react";
import { motion } from "framer-motion";
import { FileText, Loader2, Plus, Upload, Sparkles } from "lucide-react";
import { useLabsProjects } from "../hooks/useLabsProjects.js";
import LabsTopBar from "../labs/LabsTopBar.jsx";

// The document canvas (Tiptap + the agent client) stays lazy so the chat
// view's critical path never pays for it. The two modals are lazy too: they
// mount on first use and then stay mounted so their exit animation survives.
const LabsWorkspace = lazy(() => import("../labs/LabsWorkspace.jsx"));
const ExportDialog = lazy(() => import("../labs/ExportDialog.jsx"));
const CommandPalette = lazy(() => import("../labs/CommandPalette.jsx"));

const ASSISTANT_OPEN_KEY = "labs_assistant_open";
// Below this container width the split cannot host a usable editor + a
// 320px assistant, so Labs switches to one-pane-at-a-time with tabs.
const COMPACT_WIDTH = 820;

/**
 * LabsArea — the Labs shell: one top bar, one canvas, one assistant.
 * Owns projects, import/export, the command palette and the layout flags;
 * the workspace owns the editor and the agent run.
 */
export default function LabsArea({ toggleSidebar, sidebarOpen, onProjectLockChange }) {
    const {
        projects,
        activeProject,
        activeProjectId,
        setActiveProjectId,
        isProjectLocked,
        storageStatus,
        handleNewProject,
        handleImportDocument,
        handleDeleteProject,
        handleRenameProject,
        handleUpdateContent,
        handleAppendChat
    } = useLabsProjects();

    const [saveStatus, setSaveStatus] = useState("saved");
    const [assistantOpen, setAssistantOpen] = useState(
        () => localStorage.getItem(ASSISTANT_OPEN_KEY) !== "0"
    );
    const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
    const [shellWidth, setShellWidth] = useState(null);
    const shellRef = useRef(null);
    const [mobileTab, setMobileTab] = useState("document");
    const [showExport, setShowExport] = useState(false);
    const [exportMounted, setExportMounted] = useState(false);
    const [exportStatus, setExportStatus] = useState(null); // null | 'word' | 'pdf'
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [paletteMounted, setPaletteMounted] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const [notice, setNotice] = useState("");
    const [reviewCount, setReviewCount] = useState(0);
    const [renameSignal, setRenameSignal] = useState(0);
    const importInputRef = useRef(null);
    const editorRef = useRef(null);
    const handleEditorReady = useCallback(editor => { editorRef.current = editor; }, []);

    const handleSaveStatusChange = useCallback((status) => setSaveStatus(status), []);

    const openExport = useCallback(() => {
        setExportMounted(true);
        setShowExport(true);
    }, []);

    const openPalette = useCallback(() => {
        setPaletteMounted(true);
        setPaletteOpen(true);
    }, []);

    useEffect(() => {
        onProjectLockChange?.(isProjectLocked);
    }, [isProjectLocked, onProjectLockChange]);

    useEffect(() => {
        localStorage.setItem(ASSISTANT_OPEN_KEY, assistantOpen ? "1" : "0");
    }, [assistantOpen]);

    useEffect(() => {
        const onResize = () => setIsMobile(window.innerWidth < 768);
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);

    // Labs sizes itself from its OWN width, not the window's: the app sidebar
    // takes 280px and animates, so a window-based breakpoint left the split
    // trying to host two panes in a container too narrow for them (clipped
    // content on the right). Below COMPACT_WIDTH Labs shows one pane at a time.
    useEffect(() => {
        const el = shellRef.current;
        if (!el || typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver((entries) => {
            const w = entries[entries.length - 1]?.contentRect?.width;
            if (w) setShellWidth(w);
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // Fall back to the window width until the observer reports (and in jsdom).
    const compact = (shellWidth ?? window.innerWidth) < COMPACT_WIDTH || isMobile;

    // ⌘K / Ctrl+K opens the palette. Skipped inside the document itself,
    // where Mod+K is Tiptap's "insert link".
    useEffect(() => {
        const onKey = (e) => {
            if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) return;
            const target = e.target;
            if (
                target instanceof Element &&
                target.closest('.ProseMirror, [contenteditable="true"]')
            ) {
                return;
            }
            e.preventDefault();
            setPaletteMounted(true);
            setPaletteOpen((o) => !o);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    useEffect(() => {
        if (!notice) return;
        const t = setTimeout(() => setNotice(""), 6000);
        return () => clearTimeout(t);
    }, [notice]);

    const openImport = useCallback(() => importInputRef.current?.click(), []);

    const handleFileImport = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setIsImporting(true);
        setNotice("");
        try {
            await handleImportDocument(file);
        } catch (err) {
            setNotice(`Import failed: ${err?.message || "unknown error"}`);
        } finally {
            setIsImporting(false);
            if (importInputRef.current) importInputRef.current.value = "";
        }
    };

    const canExport = Boolean((activeProject?.document || "").trim());

    const runExport = async (kind, exportOptions = {}) => {
        if (!canExport) return;
        setExportStatus(kind);
        try {
            // Snapshot the live document, not the debounced saved markdown.
            // Inline marks and a style applied just before Export must survive.
            const content = editorRef.current && !editorRef.current.isDestroyed
                ? editorRef.current.getJSON() : activeProject?.content;
            const options = content ? { content, documentStyle: content.attrs?.documentStyle } : {};
            // Export code (docx/jspdf) is heavy — load it only on demand so it
            // never sits in the chat view's critical path.
            if (kind === "word") {
                const { exportToWord } = await import("../utils/exportToWord.js");
                await exportToWord(activeProject.document, activeProject.name, { ...options, tableMode: exportOptions.tableMode });
            } else {
                const { exportToPdf } = await import("../utils/exportToPdf.js");
                await exportToPdf(activeProject.document, activeProject.name, options);
            }
        } catch (err) {
            console.error("[Labs] export failed:", err);
            setNotice(err?.message ? `Export failed: ${err.message}` : "Export failed. Try again.");
        } finally {
            setExportStatus(null);
            setShowExport(false);
        }
    };

    return (
        <div ref={shellRef} className="labs-shell flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-background">
            <input
                type="file"
                ref={importInputRef}
                onChange={handleFileImport}
                accept=".txt,.md,.docx"
                className="hidden"
            />

            <LabsTopBar
                projects={projects}
                activeProject={activeProject}
                onSelectProject={setActiveProjectId}
                onNewProject={() => handleNewProject()}
                onImportClick={openImport}
                onRenameProject={handleRenameProject}
                onDeleteProject={handleDeleteProject}
                isImporting={isImporting}
                saveStatus={saveStatus}
                storageFull={storageStatus === "full"}
                onExport={openExport}
                canExport={canExport}
                assistantOpen={assistantOpen}
                onToggleAssistant={() => setAssistantOpen((o) => !o)}
                onOpenPalette={openPalette}
                toggleSidebar={toggleSidebar}
                isMobile={compact}
                mobileTab={mobileTab}
                onMobileTab={setMobileTab}
                reviewCount={reviewCount}
                renameSignal={renameSignal}
            />

            {notice && (
                <div className="shrink-0 border-b border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {notice}
                </div>
            )}

            <div className="flex min-h-0 flex-1 flex-col">
                {activeProject ? (
                    <Suspense
                        fallback={
                            <div className="flex min-h-0 flex-1 items-center justify-center">
                                <Loader2 size={18} className="animate-spin text-primary" />
                            </div>
                        }
                    >
                        <LabsWorkspace
                            key={activeProject.id}
                            onEditorReady={handleEditorReady}
                            activeProject={activeProject}
                            onUpdateContent={handleUpdateContent}
                            onAppendChat={handleAppendChat}
                            storageStatus={storageStatus}
                            onSaveStatusChange={handleSaveStatusChange}
                            assistantOpen={assistantOpen}
                            onToggleAssistant={() => setAssistantOpen((o) => !o)}
                            isMobile={compact}
                            mobileTab={mobileTab}
                            onReviewCountChange={setReviewCount}
                        />
                    </Suspense>
                ) : (
                    <motion.div
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                        className="flex min-h-0 flex-1 items-center justify-center p-6"
                    >
                        <div className="max-w-sm text-center">
                            <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10">
                                <FileText className="h-7 w-7 text-primary" />
                            </span>
                            <h2 className="mb-1.5 text-lg font-semibold text-foreground">No document open</h2>
                            <p className="mb-5 text-sm leading-relaxed text-muted-foreground">
                                Create a document and ask the assistant to write it, or import one you already have.
                            </p>
                            <div className="flex items-center justify-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => handleNewProject()}
                                    className="flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                                >
                                    <Plus size={14} /> New document
                                </button>
                                <button
                                    type="button"
                                    onClick={openImport}
                                    className="flex items-center gap-1.5 rounded-lg bg-foreground/10 px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-foreground/15"
                                >
                                    <Upload size={14} /> Import
                                </button>
                            </div>
                            <p className="mt-5 flex items-center justify-center gap-1.5 text-xs text-muted-foreground/70">
                                <Sparkles size={12} /> The assistant edits the document, you review the changes.
                            </p>
                        </div>
                    </motion.div>
                )}
            </div>

            <ExportDialogMount
                mounted={exportMounted}
                open={showExport}
                status={exportStatus}
                onClose={() => setShowExport(false)}
                onExportWord={options => runExport("word", options)}
                onExportPdf={() => runExport("pdf")}
            />

            {paletteMounted && (
                <Suspense fallback={null}>
                    <CommandPalette
                        open={paletteOpen}
                        onClose={() => setPaletteOpen(false)}
                        projects={projects}
                        activeProjectId={activeProjectId}
                        onSelectProject={setActiveProjectId}
                        onNewProject={() => handleNewProject()}
                        onImport={openImport}
                        onExport={openExport}
                        onToggleAssistant={() => setAssistantOpen((o) => !o)}
                        assistantOpen={assistantOpen}
                        onRenameRequest={() => setRenameSignal((n) => n + 1)}
                    />
                </Suspense>
            )}
        </div>
    );
}

function ExportDialogMount({ mounted, ...props }) {
    if (!mounted) return null;
    return (
        <Suspense fallback={null}>
            <ExportDialog {...props} />
        </Suspense>
    );
}
