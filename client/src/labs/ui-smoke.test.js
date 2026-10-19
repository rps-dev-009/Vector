/**
 * Labs UI mount smoke test.
 *
 * Mounts the real Labs shell (top bar + lazy workspace + editor + assistant)
 * in jsdom and asserts the layout contract that the UI depends on:
 *   - the shell mounts without throwing
 *   - the assistant's message list is a bounded scroll container
 *     (min-h-0 + flex-1 + overflow-y-auto) — this is the chain that was
 *     broken when the chat could not scroll
 *   - the resizer exists and is a real separator
 *   - the run status collapses a whole trace into ONE line
 *
 * No testing-library: a plain createRoot mount keeps the dependency list
 * unchanged.
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import LabsArea from "../components/LabsArea.jsx";

// jsdom lacks the observers Tiptap's menus and our panes expect.
beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
  if (!globalThis.fetch) globalThis.fetch = () => Promise.reject(new Error("offline"));
  localStorage.clear();
  // Resolve the real lazy module before measuring UI mount behavior. Under
  // memory pressure, compiling Tiptap is slower than the DOM wait budget;
  // that is not a failed render. No component or editor is mocked here.
  await import("./LabsWorkspace.jsx");
}, 120000);

let container = null;
let root = null;

async function mountLabs() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(LabsArea, { toggleSidebar: () => {}, sidebarOpen: true }));
  });
  // Flush the lazy LabsWorkspace import chain (Tiptap) + the editor's first
  // paint. The dynamic import resolves over many turns and the whole suite
  // runs in parallel, so poll generously instead of guessing a tick count.
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (container.querySelector(".ProseMirror")) break;
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
  return container;
}

afterEach(() => {
  try {
    if (root) act(() => root.unmount());
  } catch {
    // A failed mount must never cascade into the next test.
  }
  root = null;
  container?.remove();
  container = null;
});

describe("Labs UI shell", () => {
  it("mounts the shell, the canvas and the assistant", { timeout: 60000 }, async () => {
    const el = await mountLabs();

    // Top bar chrome
    expect(el.querySelector(".labs-shell")).toBeTruthy();
    expect(el.textContent).toContain("Documents");

    // Document canvas + editor surface
    expect(el.querySelector(".labs-canvas")).toBeTruthy();
    expect(el.querySelector(".labs-page")).toBeTruthy();
    expect(el.querySelector(".ProseMirror")).toBeTruthy();

    // Assistant pane with its composer
    expect(el.querySelector(".labs-assistant")).toBeTruthy();
    expect(el.querySelector("textarea")).toBeTruthy();
  });

  it("gives the assistant message list a bounded scroll container", { timeout: 60000 }, async () => {
    const el = await mountLabs();
    const list = el.querySelector(".labs-assistant-messages");
    expect(list).toBeTruthy();
    const classes = list.className;
    // The exact chain that unlocks scrolling.
    expect(classes).toContain("min-h-0");
    expect(classes).toContain("flex-1");
    expect(classes).toContain("overflow-y-auto");

    // Every ancestor up to the shell must allow shrinking, or the bounded
    // height never reaches the scroll container.
    let node = list.parentElement;
    let guard = 0;
    while (node && !node.classList.contains("labs-shell") && guard < 12) {
      const c = node.className || "";
      const isFlexItem = /flex-1|flex h-full|min-h-0|shrink-0/.test(c);
      expect(isFlexItem, `ancestor without a height contract: "${c}"`).toBe(true);
      node = node.parentElement;
      guard += 1;
    }
    expect(node?.classList.contains("labs-shell")).toBe(true);
  });

  it("renders a resizer separator between the panes", { timeout: 60000 }, async () => {
    const el = await mountLabs();
    const handle = el.querySelector(".labs-resizer");
    expect(handle).toBeTruthy();
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
  });

  it("switches document themes and saves the style without rewriting content", { timeout: 60000 }, async () => {
    const el = await mountLabs();
    const before = el.querySelector(".ProseMirror").textContent;
    const toggle = el.querySelector('[aria-controls="labs-design-panel"]');
    await act(async () => toggle.click());
    const choices = [...el.querySelectorAll(".labs-theme-choice")];
    expect(choices).toHaveLength(5);
    await act(async () => choices.find(b => b.textContent.includes("Botanical")).click());
    expect(el.querySelector(".labs-page").dataset.documentTheme).toBe("botanical");
    expect(el.querySelector(".ProseMirror").textContent).toBe(before);
    await act(async () => { await new Promise(r => setTimeout(r, 600)); });
    const projects = JSON.parse(localStorage.getItem("labs_projects_global"));
    expect(projects[0].content.attrs.documentStyle).toEqual({ preset: "botanical" });
  });
});

describe("run status line", () => {
  it("collapses a whole tool trace into one line", async () => {
    const { default: AssistantPane } = await import("./AssistantPane.jsx");
    const run = {
      status: "active",
      steps: [
        { label: "Reading document" },
        { label: "Writing 8 blocks", tool: "insert_blocks" }
      ],
      liveText: "",
      error: null,
      done: null,
      review: [],
      skipped: [],
      usage: {},
      ops: { inserts: 8, replaces: 0, deletes: 0, attrs: 0 }
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const localRoot = createRoot(host);
    await act(async () => {
      localRoot.render(
        React.createElement(AssistantPane, {
          chat: [],
          run,
          instruction: "",
          setInstruction: () => {},
          selection: null,
          clearSelection: () => {},
          onSend: () => {},
          onStop: () => {},
          onKeepAll: () => {},
          onRejectAll: () => {},
          onJumpToFirstChange: () => {},
          onDismissError: () => {}
        })
      );
    });

    const status = host.querySelector(".labs-status");
    expect(status).toBeTruthy();
    expect(status.textContent).toContain("Writing document… 8 blocks");
    // ONE status row, not one row per tool call: the step list is collapsed.
    expect(host.querySelectorAll(".labs-status-steps").length).toBe(0);

    act(() => localRoot.unmount());
    host.remove();
  });
});
