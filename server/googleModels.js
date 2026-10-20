const DEFAULT_MODEL_ID = "gemini-3.5-flash-lite";

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeModelId(value) {
  return clean(value).replace(/^models\//, "");
}

function modelCapabilities(modelId) {
  let levels = [];
  let defaultLevel = "";
  let thinkingMode = "";
  const specialized = /(?:image|tts|live|native-audio|computer-use)/.test(modelId);
  if (!specialized && (/^gemini-3(?:\.5)?-flash(?:-|$)/.test(modelId) || /^gemini-3\.1-flash-lite(?:-|$)/.test(modelId))) {
    levels = ["minimal", "low", "medium", "high"];
    defaultLevel = /^gemini-3\.(?:1|5)-flash-lite/.test(modelId) ? "minimal" : "high";
    thinkingMode = "level";
  } else if (!specialized && /^gemini-3\.1-pro(?:-|$)/.test(modelId)) {
    levels = ["low", "medium", "high"];
    defaultLevel = "high";
    thinkingMode = "level";
  } else if (!specialized && /^gemini-3-pro(?:-|$)/.test(modelId)) {
    levels = ["low", "high"];
    defaultLevel = "high";
    thinkingMode = "level";
  } else if (!specialized && /^gemini-2\.5-(?:flash|pro)(?:-|$)/.test(modelId)) {
    levels = modelId.startsWith("gemini-2.5-pro") ? ["low", "medium", "high"] : ["off", "low", "medium", "high"];
    defaultLevel = "medium";
    thinkingMode = "budget";
  } else if (/^gemma-?4(?:-|$)/.test(modelId)) {
    levels = ["minimal", "high"];
    defaultLevel = "minimal";
    thinkingMode = "level";
  }
  const isGemma = modelId.startsWith("gemma");
  const isGemma4 = /^gemma-?4(?:-|$)/.test(modelId);
  return {
    thinking: { levels, defaultLevel },
    thinkingMode,
    supportsTools: (!isGemma && !specialized) || isGemma4,
    supportsSystem: !isGemma || isGemma4,
    supportsUploads: !isGemma || (/^gemma-?[34](?:-|$)/.test(modelId) && !/^gemma-?3-1b(?:-|$)/.test(modelId))
  };
}

function loadGoogleModels(env = {}) {
  const models = [];
  const seen = new Set();
  const add = (rawId, rawName, rawLevel) => {
    const modelId = normalizeModelId(rawId);
    if (!/^(?:gemini|gemma)[a-z0-9._-]{1,120}$/.test(modelId) || seen.has(modelId)) return;
    const capabilities = modelCapabilities(modelId);
    const level = clean(rawLevel).toLowerCase();
    if (capabilities.thinking.levels.includes(level)) capabilities.thinking.defaultLevel = level;
    models.push({
      id: modelId,
      modelId,
      name: clean(rawName) || modelId,
      ...capabilities,
      thinkingLevel: capabilities.thinking.defaultLevel
    });
    seen.add(modelId);
  };
  const indices = [...new Set(Object.keys(env).map(key => /^GEMINI_MODEL_(\d+)_ID$/.exec(key)?.[1]).filter(Boolean))]
    .sort((a, b) => Number(a) - Number(b));
  for (const index of indices) {
    add(env[`GEMINI_MODEL_${index}_ID`], env[`GEMINI_MODEL_${index}_NAME`], env[`GEMINI_MODEL_${index}_THINKING_LEVEL`]);
  }
  add(env.GEMINI_MODEL, "", env.GEMINI_THINKING_LEVEL);
  add(env.LABS_LLM_MODEL, "", env.LABS_LLM_THINKING_LEVEL);
  if (!models.length) add(DEFAULT_MODEL_ID);
  return models;
}

function resolveGoogleModel(env = {}, modelId, thinkingLevel, scope = "chat") {
  const models = loadGoogleModels(env);
  const configuredDefault = normalizeModelId(scope === "labs" ? env.LABS_LLM_MODEL : env.GEMINI_MODEL);
  if (modelId != null && typeof modelId !== "string") return { model: null, error: "Invalid Google model ID" };
  const selectedId = normalizeModelId(modelId) || configuredDefault || models[0].modelId;
  const configured = models.find(model => model.modelId === selectedId);
  if (!configured) return { model: null, error: "Google model is not configured" };
  if (thinkingLevel != null && typeof thinkingLevel !== "string") return { model: null, error: "Invalid thinking level" };
  const scopeLevel = selectedId === (configuredDefault || models[0].modelId)
    ? clean(scope === "labs" ? env.LABS_LLM_THINKING_LEVEL : env.GEMINI_THINKING_LEVEL).toLowerCase() : "";
  const defaultLevel = configured.thinking.levels.includes(scopeLevel) ? scopeLevel : configured.thinking.defaultLevel;
  const selectedLevel = clean(thinkingLevel).toLowerCase() || defaultLevel;
  if (selectedLevel && !configured.thinking.levels.includes(selectedLevel)) {
    return { model: null, error: `Thinking level is not supported by ${selectedId}` };
  }
  return {
    model: { ...configured, thinking: { ...configured.thinking, defaultLevel }, thinkingLevel: selectedLevel },
    error: null
  };
}

function publicGoogleModel(model) {
  return {
    id: model.modelId,
    name: model.name,
    features: { uploads: model.supportsUploads, tts: false, stt: false, status: "ok" },
    thinking: { levels: [...model.thinking.levels], defaultLevel: model.thinking.defaultLevel }
  };
}

function googleProviderOptions(model) {
  if (!model?.thinking?.levels?.length) return {};
  const level = model.thinkingLevel || model.thinking.defaultLevel;
  if (!model.thinking.levels.includes(level)) throw new Error("Invalid Google thinking level");
  const thinkingConfig = model.thinkingMode === "budget"
    ? { thinkingBudget: { off: 0, low: 1024, medium: 8192, high: model.modelId.startsWith("gemini-2.5-pro") ? 32768 : 24576 }[level] }
    : { thinkingLevel: level };
  return { google: { thinkingConfig } };
}

module.exports = { loadGoogleModels, resolveGoogleModel, publicGoogleModel, googleProviderOptions };
