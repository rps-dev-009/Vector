import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  plugins: [react()],

  server: {
    proxy: {
      "/chat": {
        target: "http://localhost:3000",
        // Critical: disable response buffering for SSE streaming
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            // Prevent http-proxy from buffering the SSE stream
            proxyRes.headers["cache-control"] = "no-cache, no-transform";
            proxyRes.headers["x-accel-buffering"] = "no";
          });
        },
      },
      "/models": "http://localhost:3000",
      "/labs-model": "http://localhost:3000",
      "/labs/agent": {
        target: "http://localhost:3000",
        // SSE: disable proxy buffering like the chat path
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            proxyRes.headers["cache-control"] = "no-cache, no-transform";
            proxyRes.headers["x-accel-buffering"] = "no";
          });
        },
      },
      "/labs-edit": "http://localhost:3000",
      "/labs-edit-selection": "http://localhost:3000",
      "/predict": "http://localhost:3000"
    }
  },

  build: {
    outDir: path.resolve(__dirname, "../server/public"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 600,

    rollupOptions: {
      output: {
        manualChunks: {
          // React core — always first to load, tiny and stable
          "vendor-react": ["react", "react-dom"],

          // Animation — large but only needed for UI interactions
          "vendor-motion": ["framer-motion"],

          // Markdown rendering stack
          "vendor-markdown": [
            "react-markdown",
            "remark-gfm",
            "remark-math",
            "rehype-katex",
            "rehype-sanitize"
          ],

          // Math rendering (KaTeX is huge — ~300KB)
          "vendor-katex": ["katex"],

          // Document processing — only needed in Labs
          "vendor-docx": ["docx", "mammoth"],

          // PDF/canvas export — only needed in Labs
          "vendor-pdf": ["jspdf", "html2canvas"],

          // Tiptap editor — loaded lazily with the Labs workspace chunk.
          // (@tiptap/react is NOT listed: listing it hoists react/react-dom
          // into this chunk, which the main bundle then loads eagerly.
          // @tiptap/pm also has no root entry — subpaths resolve normally.)
          "vendor-tiptap": [
            "@tiptap/core",
            "@tiptap/starter-kit",
            "@tiptap/extension-text-style",
            "@tiptap/extension-highlight",
            "@tiptap/extension-text-align",
            "@tiptap/extension-table",
            "@tiptap/extension-list",
            "@tiptap/extension-task-list",
            "@tiptap/extension-task-item",
            "@tiptap/extensions",
            "@tiptap/markdown",
            "diff"
          ],

          // SSE parsing
          "vendor-sse": ["eventsource-parser"]
        }
      }
    }
  }
});
