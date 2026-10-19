/**
 * ExportDialog — format picker for the current document (.docx / .pdf).
 * Export uses the live styled document snapshot, including inline marks.
 */

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Download, FileText, FileDown, Loader2, X } from "lucide-react";

export default function ExportDialog({ open, status, onClose, onExportWord, onExportPdf }) {
  const [tableMode, setTableMode] = useState("editable");
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape" && !status) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, status, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] bg-black/55 backdrop-blur-sm"
            onClick={() => !status && onClose()}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            style={{ translate: "-50% -50%" }}
            className="labs-pop fixed left-1/2 top-1/2 z-[61] max-h-[90dvh] w-[380px] max-w-[92vw] overflow-y-auto"
            role="dialog"
            aria-modal="true"
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <Download size={15} className="text-primary" />
                <span className="text-sm font-semibold text-foreground">Export document</span>
              </div>
              <button
                type="button"
                onClick={() => !status && onClose()}
                disabled={!!status}
                className="rounded-lg p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-40"
              >
                <X size={14} />
              </button>
            </div>

            <div className="p-4">
              {status ? (
                <div className="flex flex-col items-center justify-center gap-3 py-7">
                  <Loader2 size={26} className="animate-spin text-primary" />
                  <span className="text-sm text-muted-foreground">
                    {status === "word" ? "Preparing your Word document..." : "Opening print preview..."}
                  </span>
                </div>
              ) : (
                <div className="space-y-2">
                  <fieldset className="mb-3 rounded-xl border border-border p-3">
                    <legend className="px-1 text-xs font-medium text-foreground">Tables in Word</legend>
                    <label className="flex cursor-pointer items-start gap-2 text-xs">
                      <input type="radio" name="word-table-mode" value="editable" checked={tableMode === "editable"} onChange={() => setTableMode("editable")} className="mt-0.5 accent-primary" />
                      <span><span className="block font-medium text-foreground">Editable tables</span><span className="block text-muted-foreground">Editable cells and searchable text. Square corners in Word.</span></span>
                    </label>
                    <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs">
                      <input type="radio" name="word-table-mode" value="rounded" checked={tableMode === "rounded"} onChange={() => setTableMode("rounded")} className="mt-0.5 accent-primary" />
                      <span><span className="block font-medium text-foreground">Rounded appearance</span><span className="block text-muted-foreground">High-resolution table images with rounded corners. Cells are not editable or searchable in Word; the rest of the document stays editable.</span></span>
                    </label>
                    {tableMode === "rounded" && <p className="mt-2 text-[11px] text-muted-foreground">Long tables are split into page-sized image panels with repeated headers. Your original tables stay editable in Labs.</p>}
                  </fieldset>
                  <button
                    type="button"
                    onClick={() => onExportWord({ tableMode })}
                    className="flex w-full items-center gap-3 rounded-xl border border-border px-3.5 py-3 text-left transition-colors hover:border-border/80 hover:bg-foreground/10"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/12">
                      <FileText size={17} className="text-blue-400" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-foreground">Word document</span>
                      <span className="block text-xs text-muted-foreground">.docx — Word &amp; Google Docs</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={onExportPdf}
                    className="flex w-full items-center gap-3 rounded-xl border border-border px-3.5 py-3 text-left transition-colors hover:border-border/80 hover:bg-foreground/10"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-500/12">
                      <FileDown size={17} className="text-red-400" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-foreground">Print / Save PDF</span>
                      <span className="block text-xs text-muted-foreground">Choose Save as PDF in the print dialog</span>
                    </span>
                  </button>
                  <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground/70">
                    Uses your document theme, fonts, spacing and table styles. Fonts must be installed on the device opening the file.
                  </p>
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
