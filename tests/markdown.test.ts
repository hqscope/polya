import { test } from "node:test";
import assert from "node:assert/strict";

import { parseBlocks, parseInline, type MdBlock, type MdInline } from "../src/lib/markdown.ts";

// Compact view of inline tokens: text as-is, others tagged.
function inline(text: string): string[] {
  const walk = (nodes: MdInline[]): string[] =>
    nodes.flatMap((node): string[] => {
      switch (node.type) {
        case "text":
          return [node.text];
        case "break":
          return ["<br>"];
        case "cite":
          return [`[#${node.n}]`];
        case "code":
          return [`<code:${node.text}>`];
        case "math":
          return [`<${node.display ? "D" : "I"}:${node.tex}>`];
        case "strong":
        case "em":
          return [`<${node.type}>`, ...walk(node.children), `</${node.type}>`];
        case "link":
          return [`<a ${node.href}>`, ...walk(node.children), "</a>"];
      }
    });
  return walk(parseInline(text));
}

const types = (blocks: MdBlock[]) => blocks.map((block) => block.type);

// ---- Blocks ------------------------------------------------------------------

test("ATX headings need a space after the hashes", () => {
  assert.deepEqual(parseBlocks("## Plan for today"), [{ type: "heading", level: 2, text: "Plan for today" }]);
  assert.deepEqual(parseBlocks("### Traps ###"), [{ type: "heading", level: 3, text: "Traps" }]);
  assert.deepEqual(parseBlocks("#1 priority is sleep"), [{ type: "paragraph", text: "#1 priority is sleep" }]);
});

test("bullet and ordered lists, with the ordered start number kept", () => {
  assert.deepEqual(parseBlocks("- one\n- two"), [
    {
      type: "list",
      ordered: false,
      start: 1,
      items: [
        { text: "one", children: [] },
        { text: "two", children: [] },
      ],
    },
  ]);
  const [list] = parseBlocks("3. three\n4. four");
  assert.equal(list?.type, "list");
  assert.equal(list?.type === "list" && list.start, 3);
  assert.equal(list?.type === "list" && list.ordered, true);
});

test("blank-separated numbered items stay one list", () => {
  const blocks = parseBlocks("1. Define X.\n\n2. Find E[X].\n\n3. Find Var(X).");
  assert.equal(blocks.length, 1);
  const [list] = blocks;
  assert.ok(list?.type === "list");
  assert.deepEqual(
    list.items.map((item) => item.text),
    ["Define X.", "Find E[X].", "Find Var(X)."],
  );
});

test("one nesting level; deeper levels flatten into it", () => {
  const [list] = parseBlocks("1. Parent\n   - child\n     - grandchild\n2. Next");
  assert.ok(list?.type === "list");
  assert.equal(list.items.length, 2);
  const child = list.items[0]!.children[0];
  assert.ok(child?.type === "list");
  assert.equal(child.ordered, false);
  assert.deepEqual(
    child.items.map((item) => item.text),
    ["child", "grandchild"],
  );
  assert.deepEqual(list.items[1], { text: "Next", children: [] });
});

test("continuation lines join their item; a list can interrupt a paragraph", () => {
  const blocks = parseBlocks("Steps:\n1. Condition on N\n   then sum over n\n2. Recognize the series\nlazy line");
  assert.deepEqual(types(blocks), ["paragraph", "list"]);
  const list = blocks[1];
  assert.ok(list?.type === "list");
  assert.equal(list.items[0]!.text, "Condition on N\nthen sum over n");
  assert.equal(list.items[1]!.text, "Recognize the series\nlazy line");
});

test("a different list type or a plain paragraph after a blank ends the list", () => {
  assert.deepEqual(types(parseBlocks("- a\n\n1. b")), ["list", "list"]);
  assert.deepEqual(types(parseBlocks("- a\n\nAfter the list.")), ["list", "paragraph"]);
});

test("GFM tables with alignment, ragged rows padded", () => {
  const [table] = parseBlocks("| Dist | Mean | Var |\n|:--|:-:|--:|\n| Bin | np | np(1-p) |\n| Pois | λ |");
  assert.deepEqual(table, {
    type: "table",
    align: ["left", "center", "right"],
    header: ["Dist", "Mean", "Var"],
    rows: [
      ["Bin", "np", "np(1-p)"],
      ["Pois", "λ", ""],
    ],
  });
});

test("table cells don't split on pipes inside math, code, or \\|", () => {
  const [table] = parseBlocks("| a | b | c |\n|---|---|---|\n| \\(|x|\\) | `p|q` | x \\| y |");
  assert.ok(table?.type === "table");
  assert.deepEqual(table.rows, [["\\(|x|\\)", "`p|q`", "x \\| y"]]);
});

test("a table can follow a lead-in line directly", () => {
  assert.deepEqual(types(parseBlocks("Compare:\n| a | b |\n|---|---|\n| 1 | 2 |")), ["paragraph", "table"]);
});

test("fenced code keeps its language and ignores markdown and math inside", () => {
  assert.deepEqual(parseBlocks("```python\n# not a heading\n\\[x\\] [1]\n```\nafter"), [
    { type: "code", lang: "python", text: "# not a heading\n\\[x\\] [1]", open: false },
    { type: "paragraph", text: "after" },
  ]);
});

test("an unclosed fence renders as open code", () => {
  assert.deepEqual(parseBlocks("~~~\nline 1\nline 2"), [
    { type: "code", lang: "", text: "line 1\nline 2", open: true },
  ]);
});

test("blockquotes nest at most two deep", () => {
  const [quote] = parseBlocks("> outer\n> > inner\n> > > deepest");
  assert.ok(quote?.type === "quote");
  assert.equal(quote.blocks[0]?.type, "paragraph");
  const inner = quote.blocks[1];
  assert.ok(inner?.type === "quote");
  assert.deepEqual(inner.blocks, [{ type: "paragraph", text: "inner\n> deepest" }]);
});

test("a rule wins over a list made of dashes", () => {
  assert.deepEqual(parseBlocks("---"), [{ type: "hr" }]);
  assert.deepEqual(parseBlocks("- - -"), [{ type: "hr" }]);
  assert.deepEqual(parseBlocks("***"), [{ type: "hr" }]);
});

test("display math spanning lines, blank lines, and list-like lines stays one block", () => {
  const src = "Then\n\\[\nP(X=k)\n\n- \\sum_n | a\n# b\n\\]\nso done.";
  assert.deepEqual(parseBlocks(src), [{ type: "paragraph", text: src }]);
  assert.deepEqual(inline(src), ["Then", "<br>", "<D:P(X=k)\n\n- \\sum_n | a\n# b>", "<br>", "so done."]);
});

test("$5 is money, never math", () => {
  assert.deepEqual(parseBlocks("Win $5 or lose $3."), [{ type: "paragraph", text: "Win $5 or lose $3." }]);
  assert.deepEqual(inline("Win $5 or lose $3."), ["Win $5 or lose $3."]);
});

test("CRLF line endings parse like LF", () => {
  assert.deepEqual(parseBlocks("# Title\r\n\r\n- a\r\n- b\r\n"), parseBlocks("# Title\n\n- a\n- b\n"));
});

// ---- Streaming partials ------------------------------------------------------

test("streaming: an unclosed display-math run holds the rest together", () => {
  const blocks = parseBlocks("Intro\n\\[\nx = 1\n\n- y", { streaming: true });
  assert.deepEqual(types(blocks), ["paragraph"]);
  // Finished text with a stray opener doesn't swallow the structure after it.
  assert.deepEqual(types(parseBlocks("Intro\n\\[\nx = 1\n\n- y")), ["paragraph", "list"]);
});

test("streaming: a header row shows as a table before its delimiter row", () => {
  const headerOnly = { type: "table", align: [null, null], header: ["a", "b"], rows: [] };
  assert.deepEqual(parseBlocks("| a | b |", { streaming: true }), [headerOnly]);
  assert.deepEqual(parseBlocks("| a | b |\n|--", { streaming: true }), [headerOnly]);
  assert.deepEqual(parseBlocks("| a | b |\n|", { streaming: true }), [headerOnly]);
  // Finished text: a lone pipe line is just text.
  assert.deepEqual(parseBlocks("| a | b |"), [{ type: "paragraph", text: "| a | b |" }]);
});

test("streaming: body rows stream into a table", () => {
  const [table] = parseBlocks("| a | b |\n|---|---|\n| 1", { streaming: true });
  assert.ok(table?.type === "table");
  assert.deepEqual(table.rows, [["1", ""]]);
});

test("streaming: a bare list marker is an empty item", () => {
  assert.deepEqual(parseBlocks("1."), [
    { type: "list", ordered: true, start: 1, items: [{ text: "", children: [] }] },
  ]);
});

// ---- Inline ------------------------------------------------------------------

test("snake_case stays plain; _word_ with boundaries is emphasis", () => {
  assert.deepEqual(inline("call snake_case_name now"), ["call snake_case_name now"]);
  assert.deepEqual(inline("an _important_ point"), ["an ", "<em>", "important", "</em>", " point"]);
});

test("*em* needs non-space edges, so arithmetic stays text", () => {
  assert.deepEqual(inline("*a* and a * b * c"), ["<em>", "a", "</em>", " and a * b * c"]);
});

test("bold can wrap math and a citation", () => {
  assert.deepEqual(inline("**see \\(np\\) [1]**"), ["<strong>", "see ", "<I:np>", " ", "[#1]", "</strong>"]);
  assert.deepEqual(inline("__also bold__"), ["<strong>", "also bold", "</strong>"]);
  assert.deepEqual(inline("**foo"), ["**foo"]);
});

test("[n] inside math or code is not a citation", () => {
  assert.deepEqual(inline("\\(x_{[1]}\\) and `a[2]` but [3]"), ["<I:x_{[1]}>", " and ", "<code:a[2]>", " but ", "[#3]"]);
});

test("emphasis rules never reach inside math", () => {
  assert.deepEqual(inline("\\(a_i b_j\\) and \\(x*y*z\\)"), ["<I:a_i b_j>", " and ", "<I:x*y*z>"]);
});

test("links: http(s) and mailto only", () => {
  assert.deepEqual(inline("[notes](https://ds100.org/x)"), ["<a https://ds100.org/x>", "notes", "</a>"]);
  assert.deepEqual(inline("[mail](mailto:gsi@berkeley.edu)"), ["<a mailto:gsi@berkeley.edu>", "mail", "</a>"]);
  assert.deepEqual(inline("[x](javascript:alert(1))"), ["[x](javascript:alert(1))"]);
  assert.deepEqual(inline("[2](p.4)"), ["[#2]", "(p.4)"]);
});

test("newlines become line breaks", () => {
  assert.deepEqual(inline("one\ntwo"), ["one", "<br>", "two"]);
});

test("backslash escapes, but \\( and \\[ stay math openers", () => {
  assert.deepEqual(inline("\\*not em\\* and \\_x\\_"), ["*not em* and _x_"]);
  assert.deepEqual(inline("\\[y\\]"), ["<D:y>"]);
});

test("an unclosed math opener stays text and stops math after it", () => {
  assert.deepEqual(inline("\\(a\\) then \\[b and \\(c\\)"), ["<I:a>", " then \\[b and \\(c\\)"]);
});

test("stray private-use characters in the input can't forge atoms", () => {
  const pua = String.fromCharCode(0xe000);
  assert.deepEqual(inline(`a${pua}b \\(x\\)`), ["ab ", "<I:x>"]);
});
