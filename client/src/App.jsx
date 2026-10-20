import { useEffect, useRef, useState } from "react";
import ChatSidebar from "./components/ChatSidebar.jsx";
import ChatArea from "./components/ChatArea.jsx";
import LabsArea from "./components/LabsArea.jsx";
import { useChatSession } from "./hooks/useChatSession.js";
import { cn } from "./utils/cn.js";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bot,
  PanelLeftOpen,
  SquarePen,
  MessageSquare,
  FlaskConical,
} from "lucide-react";

// ── Skeleton shimmer ────────────────────────────────────────────────────────────
function SkeletonLine({ w = "100%", h = "12px", className = "" }) {
  return (
    <div
      className={cn("rounded-md bg-foreground/8 animate-pulse", className)}
      style={{ width: w, height: h }}
    />
  );
}

function AppLoadingSkeleton() {
  return (
    <motion.div
      key="app-skeleton"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.35, ease: "easeInOut" }}
      className="fixed inset-0 z-[100] flex bg-background"
    >
      {/* Icon rail skeleton — desktop only */}
      <div className="w-[60px] shrink-0 border-r border-[rgba(255,255,255,0.05)] bg-popover flex-col items-center py-4 gap-5 hidden md:flex">
        <div className="w-7 h-7 rounded-lg bg-foreground/8 animate-pulse" />
        <div className="w-6 h-6 rounded bg-foreground/6 animate-pulse" />
        <div className="w-6 h-6 rounded bg-foreground/6 animate-pulse" />
        <div className="w-6 h-6 rounded bg-foreground/6 animate-pulse" />
      </div>

      {/* Main centred content */}
      <div className="flex-1 flex flex-col items-center justify-center gap-5">
        <SkeletonLine w="260px" h="28px" />
        <SkeletonLine w="520px" h="52px" className="rounded-2xl max-w-[90vw]" />
        <div className="flex gap-2">
          {[100, 120, 100].map((px, i) => (
            <SkeletonLine key={i} w={`${px}px`} h="28px" className="rounded-full" />
          ))}
        </div>
      </div>
    </motion.div>
  );
}

// ── Icon Rail (ChatGPT-style collapsed sidebar) ─────────────────────────────────
function IconRail({
  onOpenSidebar,
  onNewChat,
  activeView,
  onNavigateToChat,
  onNavigateToLabs,
}) {
  return (
    <div className="hidden md:flex fixed left-0 top-0 bottom-0 z-30 w-[60px] flex-col items-center py-3.5 gap-1 bg-background">
      {/* Brand icon — opens sidebar */}
      <button
        onClick={onOpenSidebar}
        className="w-9 h-9 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors mb-1"
        aria-label="Open sidebar"
        title="Open sidebar"
      >
        <PanelLeftOpen size={18} />
      </button>

      {/* New chat */}
      <button
        onClick={onNewChat}
        className="w-9 h-9 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors"
        aria-label="New chat"
        title="New chat"
      >
        <SquarePen size={17} />
      </button>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Chat nav */}
      <button
        onClick={onNavigateToChat}
        className={cn(
          "w-9 h-9 rounded-lg flex items-center justify-center transition-colors",
          activeView === "chat"
            ? "text-foreground bg-foreground/8"
            : "text-muted-foreground hover:text-foreground hover:bg-foreground/5"
        )}
        aria-label="Chat"
        title="Chat"
      >
        <MessageSquare size={17} />
      </button>

      {/* Labs nav */}
      <button
        onClick={onNavigateToLabs}
        className={cn(
          "w-9 h-9 rounded-lg flex items-center justify-center transition-colors mb-1",
          activeView === "labs"
            ? "text-foreground bg-foreground/8"
            : "text-muted-foreground hover:text-foreground hover:bg-foreground/5"
        )}
        aria-label="Labs"
        title="Labs"
      >
        <FlaskConical size={17} />
      </button>
    </div>
  );
}

// ── Boot timer (skeleton only during JS load, not model fetch) ──────────────────
function useAppBoot(durationMs = 500) {
  const [booting, setBooting] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setBooting(false), durationMs);
    return () => clearTimeout(t);
  }, []);
  return booting;
}

// ── Main App ────────────────────────────────────────────────────────────────────
export default function App() {
  const isBooting = useAppBoot(500);
  const [theme, setTheme] = useState(() => {
    const stored = localStorage.getItem("flowise_theme");
    if (stored === "light" || stored === "dark") return stored;
    const prefersLight =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-color-scheme: light)")?.matches;
    return prefersLight ? "light" : "dark";
  });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeView, setActiveView] = useState("chat");
  const [labsProjectLocked, setLabsProjectLocked] = useState(false);

  const {
    models,
    selectedModelId,
    setSelectedModelId,
    thinkingLevel,
    setThinkingLevel,
    selectedModel,
    modelsIssues,
    isModelsLoading,
    modelsError,
    reloadModels,
    mode,
    activeSession,
    activeSessionId,
    handleSelectSession,
    isSessionLocked,
    message,
    setMessage,
    isStreaming,
    handleNewChat,
    handleClearHistory,
    handleModeChange,
    handleSend,
    handleStop,
    historyList,
    MODES,
    ACTIVITY_LABELS,
  } = useChatSession();

  const handleNewChatRef = useRef(handleNewChat);
  useEffect(() => { handleNewChatRef.current = handleNewChat; }, [handleNewChat]);

  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
    localStorage.setItem("flowise_theme", theme);
  }, [theme]);

  useEffect(() => {
    const set = () => {
      document.documentElement.style.setProperty("--app-height", `${window.innerHeight}px`);
      document.documentElement.classList.add("has-app-height");
    };
    set();
    window.addEventListener("resize", set);
    window.visualViewport?.addEventListener("resize", set);
    return () => {
      window.removeEventListener("resize", set);
      window.visualViewport?.removeEventListener("resize", set);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        if (activeView === "chat") handleNewChatRef.current?.();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeView]);

  useEffect(() => {
    const handleResize = () => setSidebarOpen(window.innerWidth >= 768);
    window.addEventListener("resize", handleResize);
    handleResize();
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Determine left margin: full sidebar → 280px, icon rail → 60px, mobile → 0
  const mainMargin = sidebarOpen ? "md:ml-[280px]" : "md:ml-[60px]";

  return (
    <div className="relative flex h-screen w-full overflow-hidden bg-background">
      {/* Loading skeleton — shows only during JS boot */}
      <AnimatePresence>{isBooting && <AppLoadingSkeleton />}</AnimatePresence>

      <div className="pointer-events-none absolute inset-0 bg-background" />

      {/* Full sidebar (open) */}
      <ChatSidebar
        open={sidebarOpen}
        setOpen={setSidebarOpen}
        models={models}
        selectedModelId={selectedModelId}
        onSelectModel={setSelectedModelId}
        thinkingLevel={thinkingLevel}
        onThinkingLevelChange={setThinkingLevel}
        isModelsLoading={isModelsLoading}
        modelsError={modelsError}
        modelsIssues={modelsIssues}
        onReloadModels={reloadModels}
        mode={mode}
        modes={MODES}
        onModeChange={handleModeChange}
        onNewChat={handleNewChat}
        onClearHistory={handleClearHistory}
        historyList={historyList}
        activeSessionId={activeSessionId}
        onSelectSession={handleSelectSession}
        isSessionLocked={activeView === "labs" ? false : isSessionLocked}
        theme={theme}
        onToggleTheme={() => setTheme((p) => (p === "dark" ? "light" : "dark"))}
        activeView={activeView}
        onNavigateToLabs={() => setActiveView("labs")}
        onNavigateToChat={() => setActiveView("chat")}
      />

      {/* Icon rail (collapsed — desktop only, hidden when sidebar is open) */}
      {!sidebarOpen && (
        <IconRail
          onOpenSidebar={() => setSidebarOpen(true)}
          onNewChat={handleNewChat}
          activeView={activeView}
          onNavigateToChat={() => setActiveView("chat")}
          onNavigateToLabs={() => setActiveView("labs")}
        />
      )}

      <main
        className={cn(
          "relative flex-1 flex flex-col min-w-0 transition-all duration-300 ease-in-out h-full",
          mainMargin
        )}
      >
        <AnimatePresence mode="wait">
          {activeView === "chat" ? (
            <motion.div
              key="chat-view"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="flex-1 flex flex-col h-full"
            >
              <ChatArea
                activeSession={activeSession}
                isStreaming={isStreaming}
                message={message}
                onMessageChange={setMessage}
                onSend={handleSend}
                onStop={handleStop}
                onSelectFollowUp={setMessage}
                activityLabels={ACTIVITY_LABELS}
                toggleSidebar={() => setSidebarOpen(!sidebarOpen)}
                sidebarOpen={sidebarOpen}
                features={selectedModel?.features || { uploads: false, stt: false }}
              />
            </motion.div>
          ) : (
            <motion.div
              key="labs-view"
              initial={{ opacity: 0, scale: 0.985, y: 18 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.985, y: -12 }}
              transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
              className="flex-1 flex flex-col h-full"
            >
              <LabsArea
                toggleSidebar={() => setSidebarOpen(!sidebarOpen)}
                sidebarOpen={sidebarOpen}
                onProjectLockChange={setLabsProjectLocked}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
