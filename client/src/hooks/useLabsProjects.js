import { useEffect, useMemo, useState, useCallback } from "react";

// Storage key
const STORAGE_KEY = "labs_projects_global";

/**
 * Load projects from localStorage
 */
function loadProjects() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      console.log("[Labs] No saved projects");
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn("[Labs] Invalid data format");
      return [];
    }
    console.log(`[Labs] Loaded ${parsed.length} projects`);
    return parsed;
  } catch (e) {
    console.error("[Labs] Load error:", e);
    return [];
  }
}

/**
 * Save projects to localStorage. Returns true on success, false on failure
 * (e.g. quota exceeded) so the UI can show an honest storage warning.
 */
function saveProjects(projects) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
    return true;
  } catch (e) {
    console.error("[Labs] Save error (storage may be full):", e?.name || e);
    return false;
  }
}

/**
 * Hook for managing Labs projects with localStorage persistence.
 */
export function useLabsProjects() {
  // Initialize state from localStorage immediately
  const [projects, setProjects] = useState(() => {
    const loaded = loadProjects();
    return loaded;
  });

  const [activeProjectId, setActiveProjectIdState] = useState(() => {
    const loaded = loadProjects();
    return loaded.length > 0 ? loaded[0].id : "";
  });

  const [storageStatus, setStorageStatus] = useState("ok"); // 'ok' | 'full'
  const [lastSavedAt, setLastSavedAt] = useState(0);

  // Get active project
  const activeProject = useMemo(() => {
    return projects.find(p => p.id === activeProjectId) || null;
  }, [projects, activeProjectId]);

  // Project is locked when it has content
  const isProjectLocked = useMemo(() => {
    if (!activeProject) return false;
    return (activeProject.document?.trim().length ?? 0) > 0;
  }, [activeProject]);

  // Fetch Labs model name from server
  const [labsModelName, setLabsModelName] = useState("");
  useEffect(() => {
    fetch("/labs-model")
      .then(r => r.json())
      .then(data => {
        if (data.model?.name) setLabsModelName(data.model.name);
      })
      .catch(() => { });
  }, []);

  // Save to localStorage whenever projects change; surface quota failures.
  useEffect(() => {
    if (projects.length > 0) {
      const ok = saveProjects(projects);
      setStorageStatus(ok ? "ok" : "full");
      if (ok) setLastSavedAt(Date.now());
    }
  }, [projects]);

  // Create a fresh project if none exist
  useEffect(() => {
    if (projects.length === 0) {
      console.log("[Labs] Creating initial project");
      const newProject = {
        id: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        name: "Untitled Project",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        document: "",
        content: null,
        chat: []
      };
      setProjects([newProject]);
      setActiveProjectIdState(newProject.id);
    }
  }, [projects.length]);

  // Sorted list (newest first)
  const projectList = useMemo(() => {
    return [...projects].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [projects]);

  // Get model name (always returns the Labs model name)
  const getModelName = useCallback(() => {
    return labsModelName || "Labs Model";
  }, [labsModelName]);

  /**
   * Set active project
   */
  const setActiveProjectId = useCallback((projectId) => {
    const project = projects.find(p => p.id === projectId);
    if (project) {
      setActiveProjectIdState(projectId);
      console.log(`[Labs] Activated: ${project.name}`);
    }
  }, [projects]);

  /**
   * Create new project
   */
  const handleNewProject = useCallback((name = "Untitled Project", document = "", content = null, chat = []) => {
    const newProject = {
      id: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      document,
      content,
      chat
    };
    setProjects(prev => [newProject, ...prev]);
    setActiveProjectIdState(newProject.id);
    console.log("[Labs] Created project:", name);
    return newProject;
  }, []);

  /**
   * Import document
   * .docx: mammoth HTML conversion -> sanitize (untrusted input) -> Tiptap
   * content JSON with block ids; the markdown document is derived from it.
   * .txt/.md: kept as raw markdown and converted on first open (migration).
   */
  const handleImportDocument = useCallback(async (file) => {
    if (!file) return null;
    const name = file.name.replace(/\.(txt|md|docx)$/i, "") || "Imported";
    let content = "";
    let contentJSON = null;
    let derivedDocument = "";
    try {
      if (file.name.endsWith(".docx")) {
        const [{ convertToHtml }, { sanitizeDocxHtml }, { generateJSON }, labExt, bridge] = await Promise.all([
          import("mammoth"),
          import("../labs/importSanitizer.js"),
          import("@tiptap/core"),
          import("../labs/extensions/buildExtensions.js"),
          import("../labs/bridge/markdown.js")
        ]);
        const buffer = await file.arrayBuffer();
        const result = await convertToHtml({ arrayBuffer: buffer });
        const html = sanitizeDocxHtml(result.value || "");
        contentJSON = generateJSON(html, labExt.buildLabsExtensions());
        // Assign block ids to top-level nodes so the content is stable
        // before the editor ever opens it.
        const idSet = new Set();
        contentJSON.content = (contentJSON.content || []).map((node) => {
          const attrs = { ...(node.attrs || {}) };
          if (!attrs.blockId) {
            let id;
            do {
              const bytes = new Uint8Array(4);
              crypto.getRandomValues(bytes);
              id = "b_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
            } while (idSet.has(id));
            idSet.add(id);
            attrs.blockId = id;
          }
          return { ...node, attrs };
        });
        contentJSON.documentSource = "docx-import";
        const blocks = bridge.editorToBlocks(contentJSON, (used) => {
          let id;
          do {
            const bytes = new Uint8Array(4);
            crypto.getRandomValues(bytes);
            id = "b_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
          } while (used.has(id));
          used.add(id);
          return id;
        });
        derivedDocument = bridge.blocksToMarkdownDocument(blocks);
        return handleNewProject(name, derivedDocument, contentJSON);
      }
      content = await file.text();
      return handleNewProject(name, content);
    } catch (e) {
      console.error("[Labs] Import error:", e);
      throw e;
    }
  }, [handleNewProject]);

  /**
   * Delete project
   */
  const handleDeleteProject = useCallback((projectId) => {
    setProjects(prev => {
      const filtered = prev.filter(p => p.id !== projectId);
      // Switch to another project if we deleted the active one
      if (projectId === activeProjectId && filtered.length > 0) {
        setActiveProjectIdState(filtered[0].id);
      }
      // If no projects left, clear storage
      if (filtered.length === 0) {
        localStorage.removeItem(STORAGE_KEY);
      }
      return filtered;
    });
  }, [activeProjectId]);

  /**
   * Rename project
   */
  const handleRenameProject = useCallback((projectId, newName) => {
    setProjects(prev => prev.map(p =>
      p.id === projectId ? { ...p, name: newName, updatedAt: Date.now() } : p
    ));
  }, []);

  /**
   * Update document (legacy textarea path — kept for the v1 fallback)
   */
  const handleUpdateDocument = useCallback((newDocument) => {
    if (!activeProjectId) return;
    setProjects(prev => prev.map(p =>
      p.id === activeProjectId
        ? { ...p, document: newDocument, updatedAt: Date.now() }
        : p
    ));
  }, [activeProjectId]);

  /**
   * Update the Tiptap content (source of truth) + the derived markdown
   * document. `extras.documentSource` (migration) preserves the original
   * document string untouched.
   */
  const handleUpdateContent = useCallback((contentJSON, derivedDocument, extras = {}) => {
    if (!activeProjectId) return;
    setProjects(prev => prev.map(p => {
      if (p.id !== activeProjectId) return p;
      const next = { ...p, content: contentJSON, document: derivedDocument, updatedAt: Date.now() };
      if (extras.documentSource && !p.documentSource) {
        next.documentSource = extras.documentSource;
      }
      return next;
    }));
  }, [activeProjectId]);

  /**
   * Append chat messages (capped to the last 100).
   */
  const handleAppendChat = useCallback((entries) => {
    if (!activeProjectId || !Array.isArray(entries) || entries.length === 0) return;
    setProjects(prev => prev.map(p => {
      if (p.id !== activeProjectId) return p;
      const chat = [...(p.chat || []), ...entries];
      return { ...p, chat: chat.slice(-100), updatedAt: Date.now() };
    }));
  }, [activeProjectId]);

  /**
   * Force sync to storage
   */
  const forceSync = useCallback(() => {
    return saveProjects(projects);
  }, [projects]);

  return {
    projects: projectList,
    activeProject,
    activeProjectId,
    setActiveProjectId,
    isProjectLocked,
    storageStatus,
    lastSavedAt,
    handleNewProject,
    handleImportDocument,
    handleDeleteProject,
    handleRenameProject,
    handleUpdateDocument,
    handleUpdateContent,
    handleAppendChat,
    forceSync,
    getModelName,
    labsModelName
  };
}
