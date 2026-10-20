import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSession } from "./useChatSession.js";
import { useLabsProjects } from "./useLabsProjects.js";
import ThinkingSelector from "../components/ThinkingSelector.jsx";

const models = [
  { id: "gemini-3.5-flash-lite", name: "Gemini", thinking: { levels: ["minimal", "low", "medium", "high"], defaultLevel: "medium" } },
  { id: "gemma-4-31b-it", name: "Gemma", thinking: { levels: ["minimal", "high"], defaultLevel: "high" } }
];
let root;
let host;
let state;

function Probe({ hook }) {
  state = hook();
  return null;
}

async function mount(hook) {
  await act(async () => {
    root.render(<Probe hook={hook} />);
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ models, model: models[0] }) })));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Model selection", () => {
  it("switches a populated chat to Gemma with the same session and history", async () => {
    const messages = [{ id: "u1", role: "user", content: "My project is Vector" }, { id: "a1", role: "assistant", content: "Noted" }];
    localStorage.setItem("flowise_history_global", JSON.stringify([
      { id: "same-chat", title: "Project", mode: "chat", modelId: models[0].id, thinkingLevel: "medium", messages }
    ]));
    await mount(useChatSession);
    expect(state.isSessionLocked).toBe(false);
    await act(async () => state.setSelectedModelId(models[1].id));
    expect(state.activeSession.id).toBe("same-chat");
    expect(state.activeSession.messages).toEqual(messages);
    expect(state.selectedModelId).toBe(models[1].id);
    expect(state.thinkingLevel).toBe("high");
    await act(async () => state.setThinkingLevel("minimal"));
    await act(async () => state.setMessage("What is my project?"));
    fetch.mockImplementationOnce(async () => ({
      ok: true,
      body: new ReadableStream({ start(controller) { controller.close(); } })
    }));
    await act(async () => state.handleSend());
    const request = JSON.parse(fetch.mock.calls.find(([url]) => url === "/chat")[1].body);
    expect(request).toMatchObject({ sessionId: "same-chat", modelId: models[1].id, thinkingLevel: "minimal" });
    expect(request.messages).toEqual(messages.map(({ role, content }) => ({ role, content })));
    const saved = JSON.parse(localStorage.getItem("flowise_history_global"))[0];
    expect(saved.modelId).toBe(models[1].id);
    expect(saved.thinkingLevel).toBe("minimal");
    expect(saved.messages.at(-1).modelId).toBe(models[1].id);
  });

  it("keeps each chat's last model and thinking selection when navigating history", async () => {
    localStorage.setItem("flowise_history_global", JSON.stringify([
      { id: "one", modelId: models[0].id, thinkingLevel: "low", messages: [] },
      { id: "two", modelId: models[1].id, thinkingLevel: "minimal", messages: [] }
    ]));
    await mount(useChatSession);
    await act(async () => state.handleSelectSession("two"));
    expect(state.selectedModelId).toBe(models[1].id);
    expect(state.thinkingLevel).toBe("minimal");
    await act(async () => state.handleSelectSession("one"));
    expect(state.selectedModelId).toBe(models[0].id);
    expect(state.thinkingLevel).toBe("low");
  });

  it("changes the model on an existing Labs project without losing document or chat", async () => {
    const project = { id: "project", sessionId: "session", name: "Brief", document: "Keep this document", chat: [{ id: "1", role: "user", text: "Write a brief" }] };
    localStorage.setItem("labs_projects_global", JSON.stringify([project]));
    await mount(useLabsProjects);
    await act(async () => state.handleSelectModel(models[1].id));
    await act(async () => state.handleThinkingLevelChange("minimal"));
    expect(state.activeProject).toMatchObject({ ...project, modelId: models[1].id, thinkingLevel: "minimal" });
    expect(state.thinkingLevel).toBe("minimal");
    expect(JSON.parse(localStorage.getItem("labs_projects_global"))[0]).toMatchObject(project);
  });

  it("renders only the selected model's supported thinking levels", async () => {
    await act(async () => root.render(<ThinkingSelector thinking={models[1].thinking} value="high" onChange={() => {}} />));
    expect([...host.querySelectorAll("option")].map(option => option.value)).toEqual(["minimal", "high"]);
    await act(async () => root.render(<ThinkingSelector thinking={models[0].thinking} value="medium" onChange={() => {}} />));
    expect([...host.querySelectorAll("option")].map(option => option.value)).toEqual(["minimal", "low", "medium", "high"]);
    await act(async () => root.render(<ThinkingSelector thinking={{ levels: [] }} onChange={() => {}} />));
    expect(host.querySelector("select")).toBeNull();
  });
});
