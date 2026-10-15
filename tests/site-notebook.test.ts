import { test } from "node:test";
import assert from "node:assert/strict";

import { notebookToHtml, textToHtml } from "../supabase/functions/_shared/site-notebook.ts";
import { stripHtmlToText } from "../supabase/functions/_shared/canvas.ts";

const notebook = {
  nbformat: 4,
  cells: [
    { cell_type: "markdown", source: ["# Question 1\n", "Compute the mean of `x` & explain <why>.\n"] },
    { cell_type: "code", source: "import numpy as np\nnp.mean(x)", outputs: [{ data: { "image/png": "iVBORw0KGgo=" } }] },
    { cell_type: "markdown", source: "![plot](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==)" },
    { cell_type: "raw", source: "" },
  ],
};

test("a notebook becomes readable text: questions and code, no outputs or inline images", () => {
  const html = notebookToHtml(JSON.stringify(notebook), "Homework 1: Food Safety I");
  assert.ok(html);
  const text = stripHtmlToText(html);
  assert.match(text, /Homework 1: Food Safety I/);
  assert.match(text, /# Question 1/);
  assert.match(text, /Compute the mean of `x` & explain <why>\./);
  assert.match(text, /import numpy as np\nnp\.mean\(x\)/);
  assert.doesNotMatch(text, /iVBORw0KGgo/);
});

test("anything that isn't a notebook is refused", () => {
  assert.equal(notebookToHtml("not json", "x"), null);
  assert.equal(notebookToHtml(JSON.stringify({ cells: [] }), "x"), null);
  assert.equal(notebookToHtml(JSON.stringify({ hello: "world" }), "x"), null);
});

test("plain text keeps its line breaks and is escaped", () => {
  const text = stripHtmlToText(textToHtml("Line one\n<b>Line two</b>", "Notes"));
  assert.match(text, /Line one\n<b>Line two<\/b>/);
});
