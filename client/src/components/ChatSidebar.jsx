import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  MessageSquare,
  Plus,
  Trash2,
  Moon,
  Sun,
  Bot,
  FlaskConical,
  ChevronDown,
  Check,
  Lock,
  RefreshCw,
} from "lucide-react";
import { cn } from "../utils/cn.js";
import ThinkingSelector from "./ThinkingSelector.jsx";

// ── Custom Model Dropdown ──────────────────────────────────────────────────────
function ModelDropdown({
  models,
  selectedModelId,
  onSelectModel,
  isLoading,
  isLocked,
  onReload,
  modelsError,
  modelsIssues,
}) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef(null);
  const selectedModel = models?.find((m) => m.id === selectedModelId);
  const uploadsEnabled = Boolean(selectedModel?.features?.uploads);
  const uploadsStatus = selectedModel?.features?.status || "unknown";

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div>
      {/* Label row */}
      <div className="flex items-center justify-between mb-1.5 px-0.5">
        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
          Model
        </span>
        <button
          onClick={onReload}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors"
          title="Reload models"
          aria-label="Reload models"
        >
          <RefreshCw size={11} />
        </button>
      </div>

      {/* Trigger */}
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() =>
            !isLocked && !isLoading && models?.length > 0 && setOpen((v) => !v)
          }
          disabled={isLoading || isLocked || !models?.length}
          title={
            isLocked
              ? "Wait for the current response before changing models."
              : "Switch models without starting a new chat."
          }
          className={cn(
            "w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm transition-all border",
            "bg-foreground/5 border-border",
            isLocked || isLoading || !models?.length
              ? "cursor-not-allowed opacity-60"
              : "hover:bg-foreground/8 hover:border-border/70 cursor-pointer"
          )}
        >
          <div className="flex-1 text-left truncate">
            {isLoading ? (
              /* Animated shimmer bar */
              <span className="relative flex items-center gap-2 overflow-hidden">
                <span className="block w-full h-[10px] rounded-full bg-foreground/10 overflow-hidden relative">
                  <span
                    className="absolute inset-y-0 w-1/2 bg-gradient-to-r from-transparent via-foreground/20 to-transparent"
                    style={{ animation: "shimmer-slide 1.4s ease-in-out infinite" }}
                  />
                </span>
              </span>
            ) : selectedModel ? (
              <span className="font-medium text-foreground truncate">
                {selectedModel.name}
              </span>
            ) : (
              <span className="text-muted-foreground">No models</span>
            )}
          </div>
          {isLocked ? (
            <Lock size={12} className="text-muted-foreground shrink-0" />
          ) : (
            <ChevronDown
              size={13}
              className={cn(
                "shrink-0 text-muted-foreground transition-transform duration-200",
                open && "rotate-180"
              )}
            />
          )}
        </button>

        {/* Dropdown list */}
        <AnimatePresence>
          {open && models?.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.97 }}
              transition={{ duration: 0.13, ease: "easeOut" }}
              className="absolute top-full left-0 right-0 mt-1.5 bg-popover border border-border rounded-xl shadow-2xl z-[60] overflow-hidden"
            >
              {models.map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    onSelectModel(m.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-left transition-colors",
                    m.id === selectedModelId
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                  )}
                >
                  <div className="w-4 h-4 flex items-center justify-center shrink-0">
                    {m.id === selectedModelId && (
                      <Check size={13} className="text-primary" />
                    )}
                  </div>
                  <span className="truncate">{m.name}</span>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Status badge below trigger */}
        {selectedModel && (
          <div className="mt-1.5 px-0.5">
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
                uploadsStatus === "ok"
                  ? uploadsEnabled
                    ? "border-emerald-500/40 text-emerald-400"
                    : "border-border text-muted-foreground/60"
                  : "border-amber-500/40 text-amber-400"
              )}
            >
              {uploadsStatus === "ok"
                ? uploadsEnabled
                  ? "Uploads enabled"
                  : "Uploads off"
                : "Uploads unknown"}
            </span>
          </div>
        )}

        {/* Errors */}
        {(modelsError ||
          (!isLoading && !models?.length && !modelsError) ||
          modelsIssues?.length > 0) && (
            <div className="mt-1 px-0.5 text-[11px] text-destructive/80 space-y-0.5">
              {modelsError && <div>{modelsError}</div>}
              {!modelsError && !isLoading && !models?.length && (
                <div className="text-muted-foreground">
                  Configure GEMINI_MODEL_1_ID or MODEL_1_NAME / MODEL_1_ID / MODEL_1_HOST in .env
                </div>
              )}
              {modelsIssues?.slice(0, 2).map((issue) => (
                <div key={issue}>{issue}</div>
              ))}
            </div>
          )}
      </div>
    </div>
  );
}

// ── Main Sidebar ───────────────────────────────────────────────────────────────
export default function ChatSidebar({
  open,
  setOpen,
  models,
  selectedModelId,
  onSelectModel,
  thinkingLevel,
  onThinkingLevelChange,
  isModelsLoading,
  modelsError,
  modelsIssues,
  onReloadModels,
  mode,
  modes,
  onModeChange,
  onNewChat,
  onClearHistory,
  historyList,
  activeSessionId,
  onSelectSession,
  isSessionLocked = false,
  theme,
  onToggleTheme,
  activeView = "chat",
  onNavigateToLabs,
  onNavigateToChat,
}) {
  const [historyExpanded, setHistoryExpanded] = useState(true);
  const [labsVisited, setLabsVisited] = useState(
    () => localStorage.getItem("labs_visited") === "true"
  );
  const historyScrollRef = useRef(null);

  // Scrollbar fade-in on scroll
  useEffect(() => {
    const el = historyScrollRef.current;
    if (!el) return;
    let timeoutId = null;
    const onScroll = () => {
      el.classList.add("scrolling");
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => el.classList.remove("scrolling"), 150);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, []);

  const handleNavigateToLabs = () => {
    if (!labsVisited) {
      setLabsVisited(true);
      localStorage.setItem("labs_visited", "true");
    }
    onNavigateToLabs?.();
  };

  const handleClearHistory = () => {
    if (
      window.confirm(
        "Clear all chat history? This cannot be undone."
      )
    ) {
      onClearHistory?.();
    }
  };

  return (
    <AnimatePresence mode="wait">
      {open && (
        <>
          {/* Mobile overlay */}
          <motion.button
            type="button"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-40 bg-[rgba(15,17,23,0.75)] md:hidden"
            onClick={() => setOpen?.(false)}
            aria-label="Close sidebar overlay"
          />

          {/* Sidebar panel */}
          <motion.aside
            initial={{ x: -300, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -300, opacity: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 32, mass: 0.9 }}
            className="fixed left-0 top-0 bottom-0 z-50 w-[280px] bg-popover border-r border-[rgba(255,255,255,0.05)] flex flex-col"
          >
            {/* ── Header ── */}
            <div className="flex items-center justify-between px-4 py-3.5 border-b border-[rgba(255,255,255,0.05)]">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-[#22D3EE]/10 border border-[#22D3EE]/20 flex items-center justify-center">
                  <Bot size={15} className="text-[#22D3EE]" />
                </div>
                <span className="font-semibold text-[15px] text-foreground tracking-tight">
                  Vector
                </span>
              </div>
              <button
                onClick={() => setOpen?.(false)}
                className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors focus-visible:outline-none"
                aria-label="Close sidebar"
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 13 13"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M1 1L12 12M12 1L1 12"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>

            {/* ── Nav Tabs ── */}
            <div className="px-3 pt-3 pb-2">
              <div className="flex items-center gap-1 bg-foreground/5 rounded-xl p-1">
                <button
                  onClick={onNavigateToChat}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-[13px] font-medium transition-all",
                    activeView === "chat"
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground/80"
                  )}
                >
                  <MessageSquare size={13} />
                  <span>Chat</span>
                </button>
                <button
                  onClick={handleNavigateToLabs}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-[13px] font-medium transition-all relative",
                    activeView === "labs"
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground/80"
                  )}
                >
                  <FlaskConical size={13} />
                  <span>Labs</span>
                  {!labsVisited && (
                    <motion.span
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-primary rounded-full"
                    />
                  )}
                </button>
              </div>
            </div>

            {/* ── Chat View Content ── */}
            {activeView === "chat" ? (
              <div className="flex-1 flex flex-col min-h-0 px-3 pb-2 gap-3 overflow-hidden">
                {/* New Thread */}
                <button
                  onClick={onNewChat}
                  className="group flex items-center gap-2.5 w-full px-3 py-2.5 rounded-xl border border-border transition-all hover:bg-foreground/5 hover:border-foreground/20 active:scale-[0.98] focus-visible:outline-none text-[13px] font-medium text-foreground"
                >
                  <div className="w-5 h-5 rounded-md bg-[#22D3EE]/10 flex items-center justify-center text-[#22D3EE]">
                    <Plus size={13} />
                  </div>
                  <span>New Thread</span>
                  <kbd className="ml-auto text-[10px] text-muted-foreground/50 border border-border/60 rounded px-1.5 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity font-sans">
                    Ctrl+N
                  </kbd>
                </button>

                {/* Model Dropdown */}
                <ModelDropdown
                  models={models}
                  selectedModelId={selectedModelId}
                  onSelectModel={onSelectModel}
                  isLoading={isModelsLoading}
                  isLocked={isSessionLocked}
                  onReload={onReloadModels}
                  modelsError={modelsError}
                  modelsIssues={modelsIssues}
                />

                <ThinkingSelector
                  thinking={models?.find(model => model.id === selectedModelId)?.thinking}
                  value={thinkingLevel}
                  onChange={onThinkingLevelChange}
                  disabled={isSessionLocked || isModelsLoading}
                />

                {/* ── History Section (Collapsible) ── */}
                <div className="flex-1 flex flex-col min-h-0">
                  <button
                    onClick={() => setHistoryExpanded((v) => !v)}
                    className="flex items-center justify-between w-full px-0.5 py-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider hover:text-foreground/70 transition-colors focus-visible:outline-none"
                  >
                    <div className="flex items-center gap-1.5">
                      <span>Recent</span>
                      {historyList.length > 0 && (
                        <span className="text-[10px] font-normal text-muted-foreground/40 normal-case tracking-normal">
                          ({historyList.length})
                        </span>
                      )}
                    </div>
                    <ChevronDown
                      size={12}
                      className={cn(
                        "transition-transform duration-200",
                        historyExpanded && "rotate-180"
                      )}
                    />
                  </button>

                  <AnimatePresence initial={false}>
                    {historyExpanded && (
                      <motion.div
                        key="history-list"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: "easeInOut" }}
                        style={{ overflow: "hidden" }}
                      >
                        <div
                          ref={historyScrollRef}
                          className="overflow-y-auto custom-scrollbar space-y-0.5 pr-0.5 mt-0.5"
                          style={{
                            maxHeight: "calc(100vh - 450px)",
                            minHeight: "40px",
                          }}
                        >
                          {historyList.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-6 gap-1.5 text-muted-foreground/40">
                              <MessageSquare size={18} />
                              <span className="text-xs">No history yet</span>
                            </div>
                          ) : (
                            historyList.map((session, i) => (
                              <button
                                key={session.id}
                                onClick={() => onSelectSession(session.id)}
                                className={cn(
                                  "w-full text-left px-2.5 py-2 rounded-lg text-[13px] transition-colors group flex items-center gap-2 relative overflow-hidden focus-visible:outline-none stagger-item",
                                  activeSessionId === session.id
                                    ? "bg-foreground/10 text-foreground"
                                    : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                                )}
                                style={{
                                  animationDelay: `${Math.min(i * 25, 200)}ms`,
                                }}
                              >
                                {activeSessionId === session.id && (
                                  <span className="absolute left-0 top-2 bottom-2 w-[2px] bg-[#22D3EE] rounded-full" />
                                )}
                                <MessageSquare
                                  size={13}
                                  className={cn(
                                    "shrink-0",
                                    activeSessionId === session.id
                                      ? "text-muted-foreground"
                                      : "text-muted-foreground/40 group-hover:text-muted-foreground/70"
                                  )}
                                />
                                <span className="truncate flex-1 z-10 relative">
                                  {session.title || "New Thread"}
                                </span>
                              </button>
                            ))
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            ) : (
              <div className="flex-1" />
            )}

            {/* ── Footer ── */}
            <div className="px-3 py-3 border-t border-[rgba(255,255,255,0.05)] space-y-0.5">
              {activeView === "chat" && (
                <button
                  onClick={handleClearHistory}
                  className="flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-[13px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-all focus-visible:outline-none"
                >
                  <Trash2 size={14} />
                  <span>Clear History</span>
                </button>
              )}
              <button
                onClick={onToggleTheme}
                className="flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-[13px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground transition-all focus-visible:outline-none"
              >
                {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
                <span>{theme === "dark" ? "Light Mode" : "Dark Mode"}</span>
              </button>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
