/**
 * Sanitizer for imported .docx HTML (mammoth.convertToHtml output).
 * Imported files are UNTRUSTED input: strip every tag/attribute outside a
 * strict allowlist before the HTML is converted to Tiptap content.
 *
 * Allowed: headings h1-h6, p, strong/b, em/i, u, s, code, pre, a[href],
 * br, hr, ul, ol, li, blockquote, table, thead, tbody, tr, th, td.
 * Other wrappers are unwrapped; active content is dropped. Preserve only safe
 * links and bounded list/table structural attributes, never arbitrary styles.
 */

const ALLOWED_TAGS = new Set([
  "H1", "H2", "H3", "H4", "H5", "H6",
  "P", "STRONG", "B", "EM", "I", "U", "S", "CODE", "PRE",
  "A", "BR", "HR",
  "UL", "OL", "LI", "BLOCKQUOTE",
  "TABLE", "THEAD", "TBODY", "TR", "TH", "TD"
]);
const DROP_TAGS = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "TEMPLATE"]);

function safeHref(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/[\u0000-\u0020\u007f]/.test(trimmed)) return null;
  return /^(https?:|mailto:|tel:|#)/i.test(trimmed) ? trimmed : null;
}

function sanitizeNode(node, parent) {
  if (node.nodeType === 3) return; // text node — keep
  if (node.nodeType !== 1) {
    parent.removeChild(node);
    return;
  }

  const tag = node.tagName.toUpperCase();
  if (DROP_TAGS.has(tag)) {
    parent.removeChild(node);
    return;
  }

  if (!ALLOWED_TAGS.has(tag)) {
    for (const child of [...node.childNodes]) sanitizeNode(child, node);
    // Unwrap: move children up, drop the element itself.
    while (node.firstChild) {
      parent.insertBefore(node.firstChild, node);
    }
    parent.removeChild(node);
    return;
  }

  // Strip appearance and event handlers without destroying list/table structure.
  const attributes = [...node.attributes];
  for (const attr of attributes) {
    if (tag === "A" && attr.name.toLowerCase() === "href") {
      const href = safeHref(attr.value);
      if (href) {
        attr.value = href;
        continue;
      }
    }
    const name = attr.name.toLowerCase();
    const max = tag === "OL" && name === "start" ? 2147483647
      : ["TH", "TD"].includes(tag) && ["colspan", "rowspan"].includes(name) ? 100 : 0;
    if (max && /^\d+$/.test(attr.value) && Number(attr.value) >= 1 && Number(attr.value) <= max) continue;
    node.removeAttribute(attr.name);
  }

  // Recurse (children may include nodes that will be unwrapped into this one).
  const children = [...node.childNodes];
  for (const child of children) sanitizeNode(child, node);

  // Clean up any stray text directly inside ul/ol/table rows.
  if (tag === "UL" || tag === "OL") {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3 && !child.textContent.trim()) node.removeChild(child);
      else if (child.nodeType === 1 && child.tagName !== "LI") {
        // Wrap stray block content into an li so list parsing stays valid.
        const li = node.ownerDocument.createElement("li");
        node.replaceChild(li, child);
        li.appendChild(child);
      }
    }
  }
  if (tag === "TABLE" || tag === "THEAD" || tag === "TBODY" || tag === "TR") {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 1 && child.tagName !== "TR" && child.tagName !== "TD" && child.tagName !== "TH" && child.tagName !== "THEAD" && child.tagName !== "TBODY") {
        node.removeChild(child);
      } else if (child.nodeType === 3 && !child.textContent.trim()) {
        node.removeChild(child);
      }
    }
  }
  if (tag === "TR") {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 1 && child.tagName !== "TD" && child.tagName !== "TH") node.removeChild(child);
    }
  }
}

export function sanitizeDocxHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const children = [...doc.body.childNodes];
  for (const child of children) sanitizeNode(child, doc.body);
  return doc.body.innerHTML;
}
