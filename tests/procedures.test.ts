import { test } from "node:test";
import assert from "node:assert/strict";

import { extractProcedures, procedureText, stepText } from "../supabase/functions/_shared/procedures.ts";

test("extracts a numbered imperative method as a procedure", () => {
  const page = {
    pageNum: 3,
    text: [
      "Choosing a Statistical Test",
      "1. Identify the type of outcome variable.",
      "2. Determine the number of groups.",
      "3. Check whether the observations are paired.",
      "4. Select the test that matches those answers.",
    ].join("\n"),
  };
  const procedures = extractProcedures([page]);
  assert.equal(procedures.length, 1);
  assert.equal(procedures[0]!.steps.length, 4);
  assert.equal(procedures[0]!.pageStart, 3);
  assert.match(procedures[0]!.title, /Statistical Test|Identify/);
  assert.equal(procedures[0]!.steps[1]!.stepNumber, 2);
});

test("ignores a short numbered list (< 3 steps) and non-imperative lists", () => {
  const shortList = { pageNum: 1, text: "1. Apples\n2. Oranges" };
  assert.equal(extractProcedures([shortList]).length, 0);

  const nonImperative = {
    pageNum: 1,
    text: "1. The Krebs cycle\n2. The electron transport chain\n3. Oxidative phosphorylation\n4. ATP yield",
  };
  // Mostly noun phrases, not imperative steps → not a procedure.
  assert.equal(extractProcedures([nonImperative]).length, 0);
});

test("procedureText and stepText format for retrieval", () => {
  const [procedure] = extractProcedures([
    {
      pageNum: 1,
      text: "1. Compute the mean.\n2. Subtract the mean from each value.\n3. Square the residuals.",
    },
  ]);
  assert.ok(procedure);
  assert.match(procedureText(procedure!), /Method:/);
  assert.match(stepText(procedure!, procedure!.steps[0]!), /Step 1 of 3/);
});

test("handles steps flowed onto one line (pdf text extraction style)", () => {
  // getTextContent often joins a slide's lines with spaces.
  const page = {
    pageNum: 5,
    text: "Solving by substitution 1. Isolate one variable. 2. Substitute into the other equation. 3. Solve for the remaining variable. 4. Back-substitute to find the first.",
  };
  const procedures = extractProcedures([page]);
  assert.equal(procedures.length, 1);
  assert.equal(procedures[0]!.steps.length, 4);
});
