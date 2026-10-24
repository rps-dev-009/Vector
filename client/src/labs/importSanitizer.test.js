import { describe, expect, it } from "vitest";
import { generateJSON } from "@tiptap/core";
import { sanitizeDocxHtml } from "./importSanitizer.js";
import { buildLabsExtensions } from "./extensions/buildExtensions.js";

describe("DOCX HTML import", () => {
  it("sanitizes descendants before unwrapping unsupported containers", () => {
    const html = sanitizeDocxHtml('<div><span><h2 style="font-size:99pt" onclick="bad()">Title</h2><p><a href="javascript:bad()">Body</a></p></span><script>bad()</script><svg><text>active content</text></svg></div>');
    expect(html).toBe("<h2>Title</h2><p><a>Body</a></p>");
  });

  it("retains bounded list numbering and merged table cells through Tiptap parsing", () => {
    const html = sanitizeDocxHtml('<ol start="4"><li>Fourth</li></ol><table><tr><th colspan="2">Heading</th></tr><tr><td rowspan="2">Cell</td><td>Second</td></tr><tr><td>Third</td></tr></table>');
    const json = generateJSON(html, buildLabsExtensions());
    expect(json.content[0].attrs.start).toBe(4);
    const table = json.content.find(node => node.type === "table");
    expect(table.content[0].content[0].attrs.colspan).toBe(2);
    expect(table.content[1].content[0].attrs.rowspan).toBe(2);
  });

  it("drops invalid structural attributes and obfuscated unsafe links", () => {
    const html = sanitizeDocxHtml('<ol start="Infinity"><li>Item</li></ol><table><tr><td colspan="1000000" rowspan="-2">Cell</td></tr></table><a href="java&#10;script:bad()">Unsafe</a><a href="https://example.com">Safe</a><a href="#section">Anchor</a>');
    expect(html).not.toMatch(/start=|colspan=|rowspan=|javascript/);
    expect(html).toContain('<a>Unsafe</a>');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="#section"');
  });
});
