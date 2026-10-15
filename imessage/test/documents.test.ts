import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PDFDocument } from "pdf-lib";

import { attachmentName, extractPage, isSendOutput, pickDocument, queryTerms, scoreTitle, type DocumentMatch } from "../agent/lib/documents.ts";

const doc = (id: string, title: string): DocumentMatch => ({ id, title, storage_path: `u/${id}.pdf`, page_count: 30, course_id: "c" });
const rows = [doc("a", "Lecture-04-Wed-Sept-2.pdf"), doc("b", "Lecture-14-Fri-Oct-2.pdf"), doc("c", "Week 2 Lab 1 Handout.pdf")];

describe("send_document matching", () => {
  it("keeps meaningful words", () => assert.deepEqual(queryTerms("lecture 4 slide 7"), ["lecture", "4", "7"].filter((w) => w !== "7").concat("7")));
  it("matches numbers as whole numbers", () => {
    assert.ok(scoreTitle("Lecture-04-Wed", ["lecture", "4"]) > 0);
    assert.equal(scoreTitle("Lecture-14-Fri", ["lecture", "4"]), 0);
  });
  it("picks the one document, by title words or id", () => {
    assert.equal((pickDocument(rows, "lecture 4") as DocumentMatch).id, "a");
    assert.equal((pickDocument(rows, "lab 1 handout") as DocumentMatch).id, "c");
    assert.equal((pickDocument(rows, "b") as DocumentMatch).id, "b");
  });
  it("returns candidates when ambiguous and nothing when unknown", () => {
    assert.equal((pickDocument(rows, "lecture") as DocumentMatch[]).length, 2);
    assert.deepEqual(pickDocument(rows, "quantum"), []);
  });
  it("names the attachment", () => {
    assert.equal(attachmentName("Lecture-04-Wed-Sept-2.pdf", 7), "Lecture-04-Wed-Sept-2-p7.pdf");
    assert.equal(attachmentName("Week 2 Lab 1 Handout.pdf", null), "Week-2-Lab-1-Handout.pdf");
  });
});

describe("page extraction", () => {
  it("cuts one page and refuses pages that don't exist", async () => {
    const src = await PDFDocument.create();
    for (let i = 0; i < 3; i++) src.addPage([200 + i, 200]);
    const bytes = await src.save();
    const one = await extractPage(bytes, 2);
    assert.ok(one);
    const out = await PDFDocument.load(one!);
    assert.equal(out.getPageCount(), 1);
    assert.equal(out.getPage(0).getWidth(), 201);
    assert.equal(await extractPage(bytes, 9), null);
  });
});

describe("isSendOutput", () => {
  it("accepts only https sends", () => {
    assert.equal(isSendOutput({ status: "sending", url: "https://x/y", filename: "a.pdf", page: 2, title: "t" }), true);
    assert.equal(isSendOutput({ status: "sending", url: "http://x/y", filename: "a.pdf", page: null, title: "t" }), false);
    assert.equal(isSendOutput({ status: "not_found" }), false);
  });
});
