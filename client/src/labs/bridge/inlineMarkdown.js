/**
 * Inline Markdown <-> Tiptap inline nodes.
 *
 * Pure functions, no dependencies. Supports the inline subset the Labs block
 * bridge needs: **bold**, *italic*, `code`, ~~strike~~, [text](href) and hard
 * line breaks. This is NOT a general markdown engine — it exists so the block
 * text the server sends (canonical Markdown) maps onto Tiptap inline content,
 * and back, with stable round trips for the tested corpus.
 *
 * Known limitations (documented in the Phase 2 report):
 *  - Text that merely looks like markdown becomes markdown (inherent).
 *  ] Link text containing ] or cell text containing un-escaped | can re-parse
 *    differently; the table serializer escapes | like the server does.
 *  - Emphasis markers must be paired; lone * _ ~ characters stay literal.
 */

/* ── Parsing: markdown string -> inline node JSON array ──────────────────── */

// Order matters: code spans are atomic (no nesting); links wrap text; then
// paired emphasis. Each pattern is anchored at the current scan position.
const CODE_RE = /^`([^`\n]+)`/;
const LINK_RE = /^\[([^\]]*)\]\(([^)\s]*)\)/;
const BOLD_RE = /^\*\*([\s\S]+?)\*\*(?!\*)/;
const STRIKE_RE = /^~~(?!\s)([\s\S]+?)~~/;
const STAR_ITALIC_RE = /^\*(?!\s)([^*\n]+?)\*(?!\*)/;
const UNDER_ITALIC_RE = /^_(?![\s_])([^_\n]+?)_(?!\w)/;

function textNode(text, marks) {
  return { type: "text", text, ...(marks && marks.length ? { marks: [...marks] } : {}) };
}

/**
 * Parse inline markdown into a Tiptap inline content array.
 * @param {string} text markdown text (no block-level syntax)
 * @param {Array} marks inherited marks (used by recursion)
 * @returns {Array} nodes: {type:'text',text,marks?} | {type:'hardBreak'}
 */
export function parseInlineMarkdown(text, marks = []) {
  const nodes = [];
  let buffer = "";
  let rest = text;
  let prevChar = "";

  const flush = () => {
    if (buffer) {
      nodes.push(textNode(buffer, marks));
      buffer = "";
    }
  };

  while (rest.length > 0) {
    // Hard line break: a newline inside block text becomes a hardBreak node.
    if (rest.startsWith("\n")) {
      flush();
      nodes.push({ type: "hardBreak" });
      prevChar = "\n";
      rest = rest.slice(1);
      continue;
    }

    let matched = false;

    // Code span (atomic — content stays literal).
    let m = rest.match(CODE_RE);
    if (m) {
      flush();
      nodes.push(textNode(m[1], [...marks, { type: "code" }]));
      prevChar = "`";
      rest = rest.slice(m[0].length);
      matched = true;
    }

    // Link (inner text can carry other marks).
    if (!matched) {
      m = rest.match(LINK_RE);
      if (m) {
        flush();
        const inner = parseInlineMarkdown(m[1], [...marks, { type: "link", attrs: { href: m[2] } }]);
        nodes.push(...inner);
        prevChar = ")";
        rest = rest.slice(m[0].length);
        matched = true;
      }
    }

    if (!matched) {
      m = rest.match(BOLD_RE);
      if (m) {
        flush();
        nodes.push(...parseInlineMarkdown(m[1], [...marks, { type: "bold" }]));
        prevChar = "*";
        rest = rest.slice(m[0].length);
        matched = true;
      }
    }

    if (!matched) {
      m = rest.match(STRIKE_RE);
      if (m) {
        flush();
        nodes.push(...parseInlineMarkdown(m[1], [...marks, { type: "strike" }]));
        prevChar = "~";
        rest = rest.slice(m[0].length);
        matched = true;
      }
    }

    if (!matched) {
      m = rest.match(STAR_ITALIC_RE);
      if (m) {
        flush();
        nodes.push(...parseInlineMarkdown(m[1], [...marks, { type: "italic" }]));
        prevChar = "*";
        rest = rest.slice(m[0].length);
        matched = true;
      }
    }

    // Underscore italic only when not glued to a word char on either side
    // (avoids snake_case identifiers turning into italics).
    if (!matched && !/[\w]/.test(prevChar)) {
      m = rest.match(UNDER_ITALIC_RE);
      if (m) {
        flush();
        nodes.push(...parseInlineMarkdown(m[1], [...marks, { type: "italic" }]));
        prevChar = "_";
        rest = rest.slice(m[0].length);
        matched = true;
      }
    }

    if (!matched) {
      buffer += rest[0];
      prevChar = rest[0];
      rest = rest.slice(1);
    }
  }

  flush();
  return nodes.filter((n) => n.type !== "text" || n.text !== "");
}

/* ── Serialization: inline nodes -> markdown string ──────────────────────── */

function wrapWithMark(text, mark) {
  switch (mark.type) {
    case "bold":
      return `**${text}**`;
    case "italic":
      return `*${text}*`;
    case "strike":
      return `~~${text}~~`;
    case "code":
      // Keep code spans intact when the content itself contains backticks.
      if (text.includes("`")) return "`` " + text + " ``";
      return "`" + text + "`";
    case "link": {
      const href = mark.attrs?.href || "";
      return `[${text}](${href})`;
    }
    default:
      return text;
  }
}

const OPENERS = {
  bold: "**",
  italic: "*",
  strike: "~~",
  link: "["
};

function closerFor(mark) {
  if (mark.type === "link") return `](${mark.attrs?.href || ""})`;
  if (mark.type === "bold") return "**";
  if (mark.type === "italic") return "*";
  if (mark.type === "strike") return "~~";
  return "";
}

// Canonical nesting order for serialization: outermost first.
const MARK_ORDER = ["link", "bold", "italic", "strike"];

function orderedMarks(marks) {
  return MARK_ORDER.map((t) => (marks || []).find((m) => m.type === t)).filter(Boolean);
}

/**
 * Serialize inline nodes to markdown with a mark-span serializer: delimiters
 * are opened only when a mark starts and closed when it ends, so adjacent
 * nodes sharing a mark do not produce abutting `****` delimiter runs.
 * Code spans are atomic per node (never span nodes).
 */
export function serializeInlineNodes(nodes) {
  let out = "";
  const open = []; // stack of open marks, innermost last

  const closeMark = (mark) => {
    out += closerFor(mark);
  };

  for (const node of nodes || []) {
    if (node.type === "hardBreak") {
      out += "\n";
      continue;
    }
    if (node.type !== "text" || !node.text) continue;

    const marks = orderedMarks(node.marks);

    // Close marks that ended (innermost first).
    while (open.length > 0 && !marks.some((m) => m.type === open[open.length - 1].type)) {
      closeMark(open.pop());
    }
    // Open new marks in canonical (outermost first) order.
    for (const mark of marks) {
      if (!open.some((m) => m.type === mark.type)) {
        // Retain canonical nesting: if an inner mark is open, close it and
        // reopen after, so delimiters nest instead of interleaving.
        while (
          open.length > 0 &&
          MARK_ORDER.indexOf(open[open.length - 1].type) > MARK_ORDER.indexOf(mark.type)
        ) {
          closeMark(open.pop());
        }
        open.push(mark);
        out += OPENERS[mark.type] || "";
      }
    }

    // Code spans wrap this node only.
    const codeMark = (node.marks || []).find((m) => m.type === "code");
    if (codeMark) {
      out += wrapWithMark(node.text, codeMark);
    } else {
      out += node.text;
    }
  }

  while (open.length > 0) closeMark(open.pop());
  return out;
}
