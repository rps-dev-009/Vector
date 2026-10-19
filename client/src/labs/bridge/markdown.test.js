/**
 * Bridge round-trip tests (vitest).
 *
 * For each block type: markdown -> node -> markdown must be stable, block
 * attrs must survive, an empty doc must work, tables with inline formatting
 * must round-trip. Lossy cases found are asserted as documented behavior.
 */

import { describe, it, expect } from "vitest";
import {
  blockToNodeJSON,
  nodeToBlock,
  editorToBlocks
} from "./markdown.js";
import { parseInlineMarkdown, serializeInlineNodes } from "./inlineMarkdown.js";
import { generateClientBlockId } from "../constants/palette.js";

function roundTripBlock(block) {
  const node = blockToNodeJSON(block);
  const back = nodeToBlock(node);
  return { node, back };
}

function roundTripNode(node) {
  const block = nodeToBlock(node);
  const back = blockToNodeJSON(block);
  return { block, back };
}

const gen = () => generateClientBlockId(new Set());

describe("inline markdown", () => {
  it("round-trips bold, italic, code, strike and links", () => {
    const text = "plain **bold** and *ital* and `code` and ~~gone~~ and [docs](https://example.com/x)";
    const nodes = parseInlineMarkdown(text);
    expect(serializeInlineNodes(nodes)).toBe(text);
  });

  it("keeps lone marker characters literal", () => {
    const text = "a * b and c _ d and e ~~ f";
    const nodes = parseInlineMarkdown(text);
    expect(serializeInlineNodes(nodes)).toBe(text);
  });

  it("does not italicize snake_case words", () => {
    const text = "use my_var_name here";
    const nodes = parseInlineMarkdown(text);
    const serialized = serializeInlineNodes(nodes);
    expect(serialized).toBe(text);
    expect(nodes.some((n) => n.marks?.some((m) => m.type === "italic"))).toBe(false);
  });

  it("round-trips hard line breaks", () => {
    const text = "line one\nline two";
    const nodes = parseInlineMarkdown(text);
    expect(nodes.some((n) => n.type === "hardBreak")).toBe(true);
    expect(serializeInlineNodes(nodes)).toBe(text);
  });

  it("nests marks inside-out and stays stable", () => {
    const text = "**bold with `code` inside**";
    const once = serializeInlineNodes(parseInlineMarkdown(text));
    expect(once).toBe(text);
    expect(serializeInlineNodes(parseInlineMarkdown(once))).toBe(once);
  });
});

describe("paragraph blocks", () => {
  it("round-trips text and attrs", () => {
    const block = {
      id: "b01",
      type: "paragraph",
      text: "Hello **world**, see [the docs](https://example.com).",
      attrs: { textColor: "blue", backgroundColor: "#1a2b3c", align: "center" }
    };
    const { node, back } = roundTripBlock(block);
    expect(back.text).toBe(block.text);
    expect(back.id).toBe("b01");
    expect(back.attrs.textColor).toBe("blue");
    expect(back.attrs.backgroundColor).toBe("#1a2b3c");
    expect(back.attrs.align).toBe("center");
    expect(node.attrs.textAlign).toBe("center");
  });

  it("treats text starting with a list marker as plain paragraph text", () => {
    const block = { id: "b02", type: "paragraph", text: "1. not a list here", attrs: {} };
    const { back } = roundTripBlock(block);
    expect(back.type).toBe("paragraph");
    expect(back.text).toBe("1. not a list here");
  });
});

describe("heading blocks", () => {
  it("stores text WITHOUT the # prefix and keeps level in attrs", () => {
    const block = { id: "h1", type: "heading", text: "Remote Work Playbook", attrs: { level: 1 } };
    const { node, back } = roundTripBlock(block);
    expect(node.type).toBe("heading");
    expect(node.attrs.level).toBe(1);
    expect(back.text).toBe("Remote Work Playbook");
    expect(back.attrs.level).toBe(1);
    expect(back.text).not.toContain("#");
  });
});

describe("blockquote blocks", () => {
  it("stores text WITHOUT the > prefix", () => {
    const block = { id: "q1", type: "blockquote", text: "quoted words", attrs: {} };
    const { back } = roundTripBlock(block);
    expect(back.text).toBe("quoted words");
  });

  it("round-trips multi-paragraph quotes via blank lines", () => {
    const block = { id: "q2", type: "blockquote", text: "first para\n\nsecond para", attrs: {} };
    const { node, back } = roundTripBlock(block);
    expect(node.content.length).toBe(2);
    expect(back.text).toBe("first para\n\nsecond para");
  });
});

describe("code blocks", () => {
  it("keeps raw code verbatim, including backticks and literal \\n", () => {
    const code = 'echo "hi"\nif true; then\n  exit 0\nfi';
    const block = { id: "c1", type: "codeBlock", text: code, attrs: { language: "bash" } };
    const { node, back } = roundTripBlock(block);
    expect(node.content[0].text).toBe(code);
    expect(back.text).toBe(code);
    expect(back.attrs.language).toBe("bash");
  });
});

describe("list blocks", () => {
  it("round-trips bullet lists", () => {
    const block = { id: "l1", type: "bulletList", text: "- one\n- two\n- three", attrs: {} };
    const { node, back } = roundTripBlock(block);
    expect(node.type).toBe("bulletList");
    expect(node.content.length).toBe(3);
    expect(back.text).toBe("- one\n- two\n- three");
  });

  it("renumbers ordered lists from 1 (canonical form)", () => {
    const block = { id: "l2", type: "orderedList", text: "7. seven\n9. nine", attrs: {} };
    const { back } = roundTripBlock(block);
    expect(back.text).toBe("1. seven\n2. nine");
  });

  it("round-trips task list checkbox states", () => {
    const block = { id: "l3", type: "taskList", text: "- [x] done\n- [ ] todo", attrs: {} };
    const { node, back } = roundTripBlock(block);
    expect(node.content[0].attrs.checked).toBe(true);
    expect(node.content[1].attrs.checked).toBe(false);
    expect(back.text).toBe("- [x] done\n- [ ] todo");
  });

  it("round-trips inline formatting inside items", () => {
    const block = { id: "l4", type: "bulletList", text: "- **bold** item\n- plain", attrs: {} };
    const { back } = roundTripBlock(block);
    expect(back.text).toBe("- **bold** item\n- plain");
  });

  it("round-trips one nesting level with 2-space indentation", () => {
    const block = {
      id: "l5",
      type: "bulletList",
      text: "- top\n  - nested\n- top two",
      attrs: {}
    };
    const { node, back } = roundTripBlock(block);
    expect(node.content[0].content[1]?.type).toBe("bulletList");
    expect(back.text).toBe("- top\n  - nested\n- top two");
  });
});

describe("table blocks", () => {
  it("round-trips a canonical pipe table with header row", () => {
    const text = "| Tool | Purpose |\n| --- | --- |\n| chat | coordination |\n| docs | decisions |";
    const block = { id: "t1", type: "table", text, attrs: {} };
    const { node, back } = roundTripBlock(block);
    expect(node.content[0].content[0].type).toBe("tableHeader");
    expect(back.text).toBe(text);
  });

  it("escapes pipes in cells like the server builder", () => {
    const block = {
      id: "t2",
      type: "table",
      text: "| A | B |\n| --- | --- |\n| a\\|b | x |",
      attrs: {}
    };
    const { back } = roundTripBlock(block);
    expect(back.text).toBe("| A | B |\n| --- | --- |\n| a\\|b | x |");
  });

  it("round-trips inline formatting inside cells", () => {
    const block = {
      id: "t3",
      type: "table",
      text: "| Tool | Notes |\n| --- | --- |\n| **chat** | `daily` use |",
      attrs: {}
    };
    const { back } = roundTripBlock(block);
    expect(back.text).toBe("| Tool | Notes |\n| --- | --- |\n| **chat** | `daily` use |");
  });

  it("handles rows padded with empty cells", () => {
    const block = {
      id: "t4",
      type: "table",
      text: "| A | B |\n| --- | --- |\n| c |  |",
      attrs: {}
    };
    const { node, back } = roundTripBlock(block);
    // The empty cell contains a (content-less) paragraph node.
    expect(node.content[1].content[1].content[0].type).toBe("paragraph");
    expect(back.text).toBe("| A | B |\n| --- | --- |\n| c |  |");
  });
});

describe("horizontal rules", () => {
  it("round-trips with empty text", () => {
    const block = { id: "r1", type: "horizontalRule", text: "", attrs: {} };
    const { node, back } = roundTripBlock(block);
    expect(node.type).toBe("horizontalRule");
    expect(back.text).toBe("");
  });
});

describe("editorToBlocks", () => {
  it("handles an empty doc", () => {
    expect(editorToBlocks({ type: "doc", content: [] }, gen)).toEqual([]);
    expect(editorToBlocks(null, gen)).toEqual([]);
  });

  it("walks top-level nodes and keeps ids", () => {
    const doc = {
      type: "doc",
      content: [
        blockToNodeJSON({ id: "a", type: "heading", text: "Title", attrs: { level: 1 } }),
        blockToNodeJSON({ id: "b", type: "paragraph", text: "Body.", attrs: {} })
      ]
    };
    const blocks = editorToBlocks(doc, gen);
    expect(blocks.map((b) => b.id)).toEqual(["a", "b"]);
    expect(blocks[0].type).toBe("heading");
    expect(blocks[1].text).toBe("Body.");
  });

  it("generates ids for nodes that lack one (defensive)", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text: "x" }] }] };
    const blocks = editorToBlocks(doc, gen);
    expect(blocks[0].id).toMatch(/^b_[0-9a-f]{8}$/);
  });
});

describe("node round trips", () => {
  it("node -> block -> node is stable for every block type", () => {
    const samples = [
      { id: "n1", type: "paragraph", text: "plain text", attrs: {} },
      { id: "n2", type: "heading", text: "Heading text", attrs: { level: 2 } },
      { id: "n3", type: "blockquote", text: "quote", attrs: {} },
      { id: "n4", type: "codeBlock", text: "let x = 1;", attrs: { language: "js" } },
      { id: "n5", type: "bulletList", text: "- a\n- b", attrs: {} },
      { id: "n6", type: "orderedList", text: "1. a\n2. b", attrs: {} },
      { id: "n7", type: "taskList", text: "- [ ] a\n- [x] b", attrs: {} },
      { id: "n8", type: "table", text: "| A |\n| --- |\n| 1 |", attrs: {} },
      { id: "n9", type: "horizontalRule", text: "", attrs: {} }
    ];
    for (const block of samples) {
      const { back } = roundTripBlock(block);
      expect(back.text).toBe(block.text);
      expect(back.type).toBe(block.type);
      expect(back.attrs).toEqual(block.attrs);
    }
  });
});
