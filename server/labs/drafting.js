// Deterministic length guidance, deliberately conservative about edit intent.
function countDocumentWords(doc) {
  return doc.reduce((total, block) => {
    const text = String(block.text || "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]*>/g, " ")
      .replace(/^\s*(?:\d+[.)]|[-*+])\s+/gm, "");
    return total + (text.match(/[\p{L}\p{N}]+(?:['\u2019-][\p{L}\p{N}]+)*/gu) || []).length;
  }, 0);
}

const NAMED_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const NUMBER = `(?:\\d+(?:,\\d{3})*(?:\\.\\d+)?k?|${Object.keys(NAMED_NUMBERS).join("|")})`;

// Only enforce a narrow formatting-only contract when both the blank-space
// request and an explicit no-writing restriction are present.
function isBlankSpaceOnlyRequest(instruction) {
  const text = String(instruction || "").toLowerCase().replace(/[\u2018\u2019]/g, "'");
  const blankSpace = /\b(?:blank|empty|white)\s+spaces?\b|\b(?:leave|reserve)\s+(?:some\s+)?(?:spaces?|room)\b/.test(text);
  const noWriting = /\b(?:do\s+not|don't|dont|never)\s+(?:(?:write|wrie)(?:\s+(?:anything|(?:any\s+|new\s+)?(?:text|content|words)|at\s+all)\b|(?=\s*[,;.!?]|$))|(?:add|generate)\s+(?:any\s+|new\s+)?(?:text|content|words)\b)|\b(?:no|without)\s+(?:new\s+|any\s+)?(?:text|writing|content)\b/.test(text);
  return blankSpace && noWriting;
}

function extractLengthTarget(instruction) {
  const text = String(instruction || "").toLowerCase();
  const pattern = new RegExp(`\\b(${NUMBER})(?:\\s*(?:-|\\u2013|\\u2014|to|and)\\s*(${NUMBER}))?\\s*[- ]?\\s*(words?|pages?)\\b`, "g");
  const matches = [...text.matchAll(pattern)];
  // A word count is more precise than a page estimate when both are supplied.
  const match = matches.find(m => m[3].startsWith("word")) || matches[0];
  if (!match) return null;
  const number = value => NAMED_NUMBERS[value] || Number(value.replace(/,/g, "").replace(/k$/, "")) * (value.endsWith("k") ? 1000 : 1);
  const first = number(match[1]);
  const second = match[2] ? number(match[2]) : first;
  if (!Number.isFinite(first) || !Number.isFinite(second) || first <= 0 || second <= 0) return null;
  const page = match[3].startsWith("page");
  const wordsPerPage = /single[- ]spac/.test(text) ? 500 : /double[- ]spac/.test(text) ? 250 : 350;
  const multiplier = page ? wordsPerPage : 1;
  const prefix = text.slice(Math.max(0, match.index - 35), match.index);
  const upperOnly = /(?:up to|at most|no more than|maximum(?: of)?|under|less than)\s*$/.test(prefix);
  const lowerOnly = /(?:at least|minimum(?: of)?|no fewer than)\s*$/.test(prefix);
  // A page count cannot be exact without a rendering/layout engine. Likewise,
  // an explicitly approximate word target should not fail for a few words.
  const tolerance = page ? 10 : /(?:about|around|roughly|approximately|approx\.?|~)\s*$/.test(prefix) ? 5 : 0;
  return {
    minWords: upperOnly ? 0 : Math.ceil(Math.min(first, second) * multiplier * (100 - tolerance) / 100),
    maxWords: lowerOnly ? null : Math.ceil(Math.max(first, second) * multiplier * (100 + tolerance) / 100),
    source: page ? "pages" : "words",
    ...(page ? { wordsPerPage } : {})
  };
}

function getDraftingTarget({ instruction, doc, selection }) {
  if (selection || isBlankSpaceOnlyRequest(instruction)) return null;
  const text = String(instruction || "").trim().toLowerCase()
    .replace(/^(?:please\s+|kindly\s+)?(?:(?:can|could|would|will) you\s+)?(?:please\s+)?/, "");
  if (/\b(?:do not|don't|never)\s+(?:edit|change|write|create|generate|add|expand|rewrite)\b/.test(text)) return null;
  const create = /^(?:write|draft|create|generate|compose|prepare|produce|develop|build|give me|i (?:need|want))\b/.test(text) ||
    /^make\s+(?:me\s+)?(?:(?:a|an|new|another|full|complete)\s+|(?:assignment|project|report|essay)\b)/.test(text);
  const expand = /^(?:expand|extend|lengthen|continue|complete|finish|add)\b/.test(text) ||
    /^make\s+(?:it|this|(?:the|my) (?:document|assignment|project|report|essay))\b/.test(text) ||
    new RegExp(`^i (?:need|want)\\s+${NUMBER}\\b`).test(text);
  const rewrite = /^rewrite\b/.test(text) && /\b(?:entire|whole|full|complete)\b/.test(text);
  if (!create && !expand && !rewrite) return null;
  // Inspect the requested deliverable, not its contents ("assignment with an
  // introduction" is a full draft; "introduction for my assignment" is not).
  const deliverable = text.split(/\b(?:on|about|for|with|using|covering|including)\b/)[0];
  if (/\b(?:selected|selection|paragraphs?|sentences?|headings?|titles?|introductions?|intro|conclusions?|sections?|abstracts?|captions?|outlines?|plans?|proposals?|summary|summaries|summarize|summarise|style[ds]?|restyle[ds]?|format(?:ted|ting)?|fonts?|colou?rs?)\b/.test(deliverable)) return null;
  if (/^(?:i (?:need|want)|give me)\s+(?:my|this|the|it)\b/.test(text) && !/\b(?:expanded|longer|extended|rewritten)\b/.test(deliverable)) return null;
  const initialWords = countDocumentWords(doc);
  let target = extractLengthTarget(text);
  if (!target) {
    if (!create || !/\b(?:assignment|project)\b/.test(deliverable) || /\b(?:short|brief|concise)\b/.test(deliverable)) return null;
    target = { minWords: 2500, maxWords: 3500, source: "default" };
  }
  // New drafts in populated documents are additions unless a full rewrite was
  // requested. "Expand to N words" counts existing text; "add/by N" does not.
  const additive = !rewrite && ((!expand && create) || /^add\b/.test(text) || /\bby\s+\d/.test(text));
  const baseline = additive ? initialWords : 0;
  return { ...target, initialWords, minWords: baseline + target.minWords,
    maxWords: target.maxWords == null ? null : baseline + target.maxWords };
}

function draftingProgress({ doc, target, edits, maxEdits, steps, maxSteps }) {
  const words = countDocumentWords(doc);
  const parts = [`Current document word count: ${words} (text words, excluding Markdown markers).`,
    `Remaining budget: ${Math.max(0, maxEdits - edits)} block edits and ${Math.max(0, maxSteps - steps)} model steps. Each inserted block costs one edit; a batch is not one edit.`];
  if (target) {
    parts.push(`Document length target: ${target.minWords}${target.maxWords == null ? "+" : `-${target.maxWords}`} words (${target.source}).`);
    if (target.source === "pages") parts.push(`Page target is an estimate${target.wordsPerPage ? ` using ${target.wordsPerPage} words/page` : ""}; actual pages depend on layout. Do not change fonts, spacing or margins to pad the length.`);
    parts.push(words < target.minWords
      ? `Still needed: at least ${target.minWords - words} words of substantive content. An outline or short introduction is not a completed draft.`
      : "Check the requested coverage, length, structure and source honesty before finishing; do not add filler.");
  }
  return parts.join("\n");
}

module.exports = { countDocumentWords, extractLengthTarget, getDraftingTarget, draftingProgress, isBlankSpaceOnlyRequest };
