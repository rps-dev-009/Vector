import { useEffect, useMemo, useRef, useState } from "react";
import { createParser } from "eventsource-parser";

const MAX_MESSAGES = 20;
const REQUEST_TIMEOUT_MS = 60000; // 60 second timeout
const GLOBAL_HISTORY_KEY = "flowise_history_global";

const MODES = [
  { id: "chat", label: "Chat Mode" }
];

const ACTIVITY_LABELS = {
  searching: "Searching",
  reading: "Reading sources",
  reasoning: "Reasoning",
  writing: "Writing answer",
  tool: "Using tool",
  thinking: "Thinking",
  planning: "Planning",
  executing: "Executing"
};

// Global history - all sessions stored together with their modelId
function loadAllSessions() {
  const raw = localStorage.getItem(GLOBAL_HISTORY_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function trimMessages(messages) {
  if (messages.length <= MAX_MESSAGES) return messages;
  return messages.slice(-MAX_MESSAGES);
}

function normalizeSessionsForStorage(sessions) {
  return sessions.map((session) => ({
    ...session,
    messages: trimMessages(session.messages || [])
  }));
}

function saveAllSessions(sessions) {
  const normalized = normalizeSessionsForStorage(sessions);
  try {
    localStorage.setItem(GLOBAL_HISTORY_KEY, JSON.stringify(normalized));
  } catch (error) {
    const reduced = normalized.map((session) => ({
      ...session,
      messages: session.messages.slice(-10)
    }));
    try {
      localStorage.setItem(GLOBAL_HISTORY_KEY, JSON.stringify(reduced));
    } catch (innerError) {
      localStorage.removeItem(GLOBAL_HISTORY_KEY);
    }
  }
}

// Keep the last selected model with the conversation, not a model lock.
function createSession(mode, modelId) {
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    mode,
    modelId,
    createdAt: Date.now(),
    messages: []
  };
}

// Convert File object to Flowise upload format (base64 data URI)
async function fileToFlowise(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({
      type: "file",
      name: file.name,
      data: reader.result, // data:mime;base64,...
      mime: file.type || "application/octet-stream"
    });
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

// Convert array of File objects to Flowise uploads array
async function filesToFlowise(files) {
  if (!files || files.length === 0) return [];
  const results = await Promise.all(
    files.map(file => fileToFlowise(file).catch(err => {
      console.warn(`Skipping file ${file.name}:`, err.message);
      return null;
    }))
  );
  return results.filter(Boolean);
}

export function useChatSession() {
  const [models, setModels] = useState([]);
  const [modelsIssues, setModelsIssues] = useState([]);
  const [isModelsLoading, setIsModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState("");
  const [modelsReloadToken, setModelsReloadToken] = useState(0);
  const [mode, setMode] = useState("chat");
  const [message, setMessage] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef(null);
  const timeoutRef = useRef(null);
  const initialLoadDone = useRef(false);
  const tokenBufferRef = useRef("");
  const flushScheduledRef = useRef(false);

  // Load sessions synchronously from localStorage on first render
  // to avoid race conditions with model loading
  const initialSessions = useRef(null);
  if (initialSessions.current === null) {
    initialSessions.current = loadAllSessions();
    initialLoadDone.current = true;
  }

  const [sessions, setSessions] = useState(() => {
    return initialSessions.current.length > 0 ? initialSessions.current : [];
  });

  const [activeSessionId, setActiveSessionId] = useState(() => {
    return initialSessions.current.length > 0 ? initialSessions.current[0].id : "";
  });

  // Initialize selectedModelId from the stored session's modelId (if any)
  const [selectedModelId, setSelectedModelId] = useState(() => {
    const first = initialSessions.current[0];
    return first?.modelId || "";
  });

  const activeSession = sessions.find((item) => item.id === activeSessionId);

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();

    async function loadModels() {
      setIsModelsLoading(true);
      setModelsError("");
      try {
        const res = await fetch("/models", { signal: controller.signal });
        const raw = await res.json().catch(() => null);
        if (!res.ok) {
          const message =
            (raw && (raw.error || raw.message)) ||
            `Failed to load models (${res.status})`;
          throw new Error(message);
        }

        const nextModels = Array.isArray(raw) ? raw : raw?.models;
        const issues = Array.isArray(raw?.issues) ? raw.issues : [];

        if (!Array.isArray(nextModels)) {
          throw new Error("Invalid models response");
        }

        const normalized = nextModels
          .filter((item) => item && typeof item === "object")
          .map((item) => ({
            id: String(item.id || ""),
            name: String(item.name || ""),
            thinking: item.thinking,
            features: {
              uploads: Boolean(item?.features?.uploads),
              tts: Boolean(item?.features?.tts),
              stt: Boolean(item?.features?.stt),
              status: String(item?.features?.status || "unknown")
            }
          }))
          .filter((item) => item.id && item.name);

        if (!isMounted) return;
        setModels(normalized);
        setModelsIssues(issues);

        setSelectedModelId((prev) => {
          // If there's already a valid model selected (e.g. restored from session), keep it
          if (prev && normalized.some((m) => m.id === prev)) return prev;
          return normalized[0]?.id || "";
        });
      } catch (error) {
        if (!isMounted) return;
        if (error?.name === "AbortError") return;
        setModels([]);
        setModelsIssues([]);
        setModelsError(error?.message || "Failed to load models");
        setSelectedModelId("");
      } finally {
        if (!isMounted) return;
        setIsModelsLoading(false);
      }
    }

    loadModels();
    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [modelsReloadToken]);

  // When no sessions exist and we have a model, create a fresh session
  useEffect(() => {
    if (sessions.length === 0 && selectedModelId && initialLoadDone.current) {
      const fresh = createSession(mode, selectedModelId);
      setSessions([fresh]);
      setActiveSessionId(fresh.id);
    }
  }, [sessions.length, selectedModelId, mode]);

  useEffect(() => {
    if (activeSession?.mode) {
      setMode(activeSession.mode);
    }
  }, [activeSession?.mode]);

  // Persist automatic model selection, including fallback after config changes.
  useEffect(() => {
    if (activeSession && selectedModelId) {
      if (activeSession.modelId !== selectedModelId) {
        updateSession(activeSession.id, (session) => ({
          ...session,
          modelId: selectedModelId,
          thinkingLevel: undefined
        }));
      }
    }
  }, [activeSession, selectedModelId]);

  // Save sessions globally whenever they change
  useEffect(() => {
    if (sessions.length > 0) {
      saveAllSessions(sessions);
    }
  }, [sessions]);

  const historyList = useMemo(() => {
    return [...sessions].sort((a, b) => b.createdAt - a.createdAt);
  }, [sessions]);

  const selectedModel = useMemo(() => {
    return models.find((m) => m.id === selectedModelId) || null;
  }, [models, selectedModelId]);

  const thinkingLevel = selectedModel?.thinking?.levels?.includes(activeSession?.thinkingLevel)
    ? activeSession.thinkingLevel : selectedModel?.thinking?.defaultLevel || "";

  function handleSelectModel(modelId) {
    if (isStreaming || modelId === selectedModelId || !models.some(model => model.id === modelId)) return;
    setSelectedModelId(modelId);
    if (activeSession) {
      updateSession(activeSession.id, session => ({ ...session, modelId, thinkingLevel: undefined }));
    }
  }

  function setThinkingLevel(level) {
    if (isStreaming || !activeSession || !selectedModel?.thinking?.levels?.includes(level)) return;
    updateSession(activeSession.id, session => ({ ...session, thinkingLevel: level }));
  }

  // Handle session selection - auto-switch model to match session
  function handleSelectSession(sessionId) {
    const session = sessions.find(s => s.id === sessionId);
    if (session) {
      setActiveSessionId(sessionId);
      // If the session has a modelId, switch to it
      if (session.modelId) {
        setSelectedModelId(models.some(model => model.id === session.modelId) ? session.modelId : models[0]?.id || "");
      }
    }
  }

  function updateSession(sessionId, updater) {
    setSessions((prev) =>
      prev.map((item) =>
        item.id === sessionId ? updater(item) : item
      )
    );
  }

  function handleNewChat() {
    const fresh = createSession(mode, selectedModelId);
    setSessions((prev) => [fresh, ...prev]);
    setActiveSessionId(fresh.id);
    setMessage("");
  }

  function handleClearHistory() {
    const fresh = createSession(mode, selectedModelId);
    setSessions([fresh]);
    setActiveSessionId(fresh.id);
    setMessage("");
  }

  function handleModeChange(nextMode) {
    setMode(nextMode);
    if (activeSession) {
      updateSession(activeSession.id, (session) => ({
        ...session,
        mode: nextMode
      }));
    }
  }

  async function handleSend(files = []) {
    if (!message.trim() || !activeSession || isStreaming) return;
    if (message.trim().length > 10000) return;

    // Convert files to Flowise format
    const uploads = await filesToFlowise(files);

    const userMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: message.trim(),
      attachments: uploads.length > 0 ? uploads.map(u => u.name) : undefined
    };
    const assistantMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      modelId: selectedModelId,
      thinkingLevel,
      content: "",
      activities: [],
      createdAt: Date.now()
    };

    if (!selectedModelId) {
      updateSession(activeSession.id, (session) => ({
        ...session,
        mode,
        messages: trimMessages([
          ...session.messages,
          userMessage,
          {
            ...assistantMessage,
            content: "No AI model selected or configured. Please check your .env configuration in the server folder."
          }
        ])
      }));
      setMessage("");
      return;
    }

    updateSession(activeSession.id, (session) => {
      const updated = {
        ...session,
        mode,
        messages: trimMessages([
          ...session.messages,
          userMessage,
          assistantMessage
        ])
      };
      if (session.title === "New chat") {
        updated.title = userMessage.content.slice(0, 36);
      }
      return updated;
    });
    setMessage("");
    setIsStreaming(true);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Clear any existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    // Set up timeout for the request
    timeoutRef.current = setTimeout(() => {
      if (isStreaming) {
        controller.abort();
        updateSession(activeSession.id, (session) => ({
          ...session,
          messages: session.messages.map((msg) =>
            msg.id === assistantMessage.id && !msg.content
              ? {
                ...msg,
                content: "Request timed out. The AI server may be slow or unavailable. Please check your connection and try again."
              }
              : msg
          )
        }));
        setIsStreaming(false);
      }
    }, REQUEST_TIMEOUT_MS);

    let hasReceivedData = false;

    try {
      const response = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMessage.content,
          modelId: selectedModelId,
          thinkingLevel: thinkingLevel || undefined,
          messages: activeSession.messages.filter(msg => msg.content && ["user", "assistant"].includes(msg.role))
            .map(msg => ({ role: msg.role, content: msg.content })),
          mode,
          sessionId: activeSession.id,
          uploads: uploads.length > 0 ? uploads : undefined
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(errorText || `Request failed (${response.status})`);
      }

      if (!response.body) {
        throw new Error("No response received from server");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      const parser = createParser((event) => {
        if (event.type !== "event") return;
        const eventName = event.event || "";
        const payload = event.data || "";
        let parsed = null;
        try {
          parsed = JSON.parse(payload);
        } catch (error) {
          parsed = { text: payload };
        }

        if (eventName === "token") {
          hasReceivedData = true;
          // Reset timeout on receiving data
          if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = setTimeout(() => {
              controller.abort();
            }, REQUEST_TIMEOUT_MS);
          }
          // Buffer tokens and flush via rAF for smooth streaming
          tokenBufferRef.current += (parsed.text || "");
          if (!flushScheduledRef.current) {
            flushScheduledRef.current = true;
            requestAnimationFrame(() => {
              const buffered = tokenBufferRef.current;
              tokenBufferRef.current = "";
              flushScheduledRef.current = false;
              if (buffered) {
                updateSession(activeSession.id, (session) => ({
                  ...session,
                  messages: session.messages.map((msg) =>
                    msg.id === assistantMessage.id
                      ? { ...msg, content: msg.content + buffered }
                      : msg
                  )
                }));
              }
            });
          }
        }

        if (eventName === "activity") {
          const activityKey = parsed.tool
            ? `tool:${parsed.tool}`
            : parsed.state;
          updateSession(activeSession.id, (session) => ({
            ...session,
            messages: session.messages.map((msg) =>
              msg.id === assistantMessage.id
                ? {
                  ...msg,
                  activities: Array.from(
                    new Set([...(msg.activities || []), activityKey])
                  )
                }
                : msg
            )
          }));
        }

        if (eventName === "agentStep") {
          updateSession(activeSession.id, (session) => ({
            ...session,
            messages: session.messages.map((msg) =>
              msg.id === assistantMessage.id
                ? {
                  ...msg,
                  agentSteps: [...(msg.agentSteps || []), parsed]
                }
                : msg
            )
          }));
        }

        if (eventName === "error") {
          updateSession(activeSession.id, (session) => ({
            ...session,
            messages: session.messages.map((msg) =>
              msg.id === assistantMessage.id
                ? {
                  ...msg,
                  content:
                    parsed.message || "Something went wrong. Please try again."
                }
                : msg
            )
          }));
        }
      });

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        parser.feed(chunk);
      }

      // Final flush of any remaining buffered tokens
      if (tokenBufferRef.current) {
        const remaining = tokenBufferRef.current;
        tokenBufferRef.current = "";
        flushScheduledRef.current = false;
        updateSession(activeSession.id, (session) => ({
          ...session,
          messages: session.messages.map((msg) =>
            msg.id === assistantMessage.id
              ? { ...msg, content: msg.content + remaining }
              : msg
          )
        }));
      }

      // Final save
      setSessions(prev => [...prev]);
    } catch (error) {
      // Clear timeout on error
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      if (error?.name === "AbortError") {
        updateSession(activeSession.id, (session) => ({
          ...session,
          messages: session.messages.map((msg) =>
            msg.id === assistantMessage.id && !msg.content
              ? {
                ...msg,
                content: hasReceivedData
                  ? "Response was interrupted. The partial response has been saved."
                  : "Connection was interrupted. Please check your internet connection and try again."
              }
              : msg
          )
        }));
        setIsStreaming(false);
        return;
      }

      // Network error handling
      const isNetworkError = error?.message?.includes("fetch") ||
        error?.message?.includes("network") ||
        error?.message?.includes("Failed to fetch") ||
        !navigator.onLine;

      updateSession(activeSession.id, (session) => ({
        ...session,
        messages: session.messages.map((msg) =>
          msg.id === assistantMessage.id
            ? {
              ...msg,
              content: isNetworkError
                ? "Unable to connect to the server. Please check your internet connection and try again."
                : error?.message || "Something went wrong. Please try again."
            }
            : msg
        )
      }));
    } finally {
      // Clear timeout on completion
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      setIsStreaming(false);
    }
  }

  return {
    models,
    selectedModelId,
    setSelectedModelId: handleSelectModel,
    thinkingLevel,
    setThinkingLevel,
    modelsIssues,
    isModelsLoading,
    modelsError,
    reloadModels: () => setModelsReloadToken((prev) => prev + 1),
    selectedModel,
    mode,
    setMode,
    sessions,
    activeSession,
    activeSessionId,
    setActiveSessionId,
    handleSelectSession, // Use this instead of setActiveSessionId for history clicks
    isSessionLocked: isStreaming,
    message,
    setMessage,
    isStreaming,
    handleNewChat,
    handleClearHistory,
    handleModeChange,
    handleSend,
    historyList,
    MODES,
    ACTIVITY_LABELS
  };
}

export async function query(data) {
  const response = await fetch("/predict", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data || {})
  });
  const isJson = (response.headers.get("content-type") || "").includes("application/json");
  if (!response.ok) {
    const text = isJson ? await response.json().catch(() => null) : await response.text().catch(() => "");
    const message = (text && (text.error || text.message)) || (typeof text === "string" ? text : "");
    throw new Error(message || `Request failed (${response.status})`);
  }
  return isJson ? await response.json() : {};
}
