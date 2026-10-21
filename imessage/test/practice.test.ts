import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { gradedView, parseAnswers, questionView, readChoices, type PracticeQuestion } from "../agent/lib/practice.ts";
import { callStudy, StudyApiError } from "../agent/lib/study-api.ts";

const QUESTION: PracticeQuestion = {
  id: "00000000-0000-4000-8000-0000000000b1",
  stem: "A fair die is rolled 4 times.",
  parts: [
    { kind: "numeric", prompt: "P(at least one six)?" },
    { kind: "mc", prompt: "Which rule did you use?", options: ["Complement", "Union bound", "Bayes"] },
    { kind: "select_all", prompt: "Which are independent?", options: ["Rolls 1 and 2", "Sum and roll 1", "Rolls 3 and 4"] },
    { kind: "free_response", prompt: "Explain why.", points: 2 },
  ],
  hideTopic: false,
};

describe("showing a question", () => {
  it("labels parts a-d and numbers choices from 1", () => {
    const view = questionView(QUESTION, "Complement rule");
    assert.equal(view.topic, "Complement rule");
    assert.deepEqual(view.parts.map((p) => p.part), ["a", "b", "c", "d"]);
    assert.deepEqual(view.parts[1]!.choices, [
      { number: 1, text: "Complement" },
      { number: 2, text: "Union bound" },
      { number: 3, text: "Bayes" },
    ]);
    assert.equal("choices" in view.parts[0]!, false);
  });

  it("hides the topic of a mixed review question", () => {
    assert.equal(questionView({ ...QUESTION, hideTopic: true }, "Complement rule").topic, null);
  });
});

describe("reading texted answers", () => {
  const options = ["Complement", "Union bound", "Bayes"];

  it("reads numbers, letters, lists, and exact choice text", () => {
    assert.deepEqual(readChoices("2", options), [1]);
    assert.deepEqual(readChoices("B", options), [1]);
    assert.deepEqual(readChoices("(b)", options), [1]);
    assert.deepEqual(readChoices("1.", options), [0]);
    assert.deepEqual(readChoices("1, 3", options), [0, 2]);
    assert.deepEqual(readChoices("a and c", options), [0, 2]);
    assert.deepEqual(readChoices("3 1 3", options), [0, 2]);
    assert.deepEqual(readChoices("union bound", options), [1]);
  });

  it("reads nothing for a choice that doesn't exist or isn't a choice", () => {
    assert.deepEqual(readChoices("4", options), []);
    assert.deepEqual(readChoices("1, 7", options), []);
    assert.deepEqual(readChoices("maybe the first", options), []);
  });

  it("turns one answer per part into what polya-study grades", () => {
    const parsed = parseAnswers(QUESTION.parts, ["1 - (5/6)^4", "1", "1, 3", "Each roll doesn't affect the others."]);
    assert.deepEqual(parsed, {
      ok: true,
      responses: [
        { kind: "numeric", answer: "1 - (5/6)^4" },
        { kind: "mc", choice: 0 },
        { kind: "select_all", choices: [0, 2] },
        { kind: "free_response", text: "Each roll doesn't affect the others." },
      ],
    });
  });

  it("names the part to fix", () => {
    assert.deepEqual(parseAnswers(QUESTION.parts, ["0.5", "1, 2", "1", "x"]), {
      ok: false,
      part: "b",
      reason: "Pick exactly one choice, by its number.",
    });
    assert.equal((parseAnswers(QUESTION.parts, ["0.5"]) as { ok: false; reason: string }).ok, false);
    assert.deepEqual(parseAnswers(QUESTION.parts, ["0.5", "1", "1", "  "]), {
      ok: false,
      part: "d",
      reason: "That part has no answer yet.",
    });
  });
});

describe("the graded result", () => {
  it("shows each part's answer key in words, the worked solution, and sources", () => {
    const parsed = parseAnswers(QUESTION.parts, ["0.5", "2", "1", "Because."]);
    assert.ok(parsed.ok);
    const view = gradedView(QUESTION, parsed.responses, {
      results: [{ ok: true, correct: false }, { ok: true, correct: false }, { ok: true, correct: false }, {
        ok: true,
        correct: false,
        awarded: 1,
        points: 2,
        feedback: "Name independence.",
      }],
      score: 0.1,
      all_correct: false,
      answers: [
        { kind: "numeric", expr: "1 - (5/6)^4", value: 0.5177469135802468 },
        { kind: "mc", correct: 0 },
        { kind: "select_all", correct: [0, 2] },
        { kind: "free_response", model_answer: "The rolls are independent.", points: 2 },
      ],
      explanation: "Use the complement.",
      sources: [{ n: 1, title: "Lecture 4", page_start: 3 }],
    });
    assert.equal(view.score, "10%");
    assert.equal(view.parts[0]!.correct_answer, "1 - (5/6)^4 (about 0.5177)");
    assert.equal(view.parts[1]!.your_answer, "2. Union bound");
    assert.equal(view.parts[1]!.correct_answer, "1. Complement");
    assert.equal(view.parts[2]!.correct_answer, "1. Rolls 1 and 2; 3. Rolls 3 and 4");
    assert.equal((view.parts[3] as { points?: string }).points, "1 of 2");
    assert.equal(view.worked_solution, "Use the complement.");
    assert.deepEqual(view.sources, [{ n: 1, title: "Lecture 4", page: 3 }]);
  });
});

describe("calling polya-study", () => {
  const env = { POLYA_SUPABASE_URL: "https://project.supabase.co/", POLYA_SUPABASE_SERVICE_ROLE_KEY: "service-key" } as NodeJS.ProcessEnv;
  const USER = "00000000-0000-4000-8000-000000000001";

  it("names the student and authenticates as the service caller", async () => {
    let seen: { url: string; headers: Headers; body: unknown } | null = null;
    const result = await callStudy<{ ok: boolean }>(
      USER,
      { action: "submit_attempt", question_id: QUESTION.id, responses: [] },
      env,
      async (url, init) => {
        seen = { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    );
    assert.deepEqual(result, { ok: true });
    assert.equal(seen!.url, "https://project.supabase.co/functions/v1/polya-study");
    assert.equal(seen!.headers.get("authorization"), "Bearer service-key");
    assert.equal(seen!.headers.get("x-polya-user-id"), USER);
    assert.deepEqual(seen!.body, { action: "submit_attempt", question_id: QUESTION.id, responses: [] });
  });

  it("keeps polya-study's error code and part", async () => {
    await assert.rejects(
      callStudy(USER, { action: "submit_attempt", question_id: QUESTION.id, responses: [] }, env, async () =>
        new Response(JSON.stringify({ error: "That answer couldn't be read.", code: "bad_answer", part: 1 }), { status: 400 })),
      (error: unknown) => error instanceof StudyApiError && error.code === "bad_answer" && error.part === 1 && error.status === 400,
    );
  });

  it("a network failure or timeout reads as unavailable or slow", async () => {
    await assert.rejects(
      callStudy(USER, { action: "generate_questions", exam_id: "e", topic_id: "t" }, env, async () => {
        throw new TypeError("fetch failed");
      }),
      (error: unknown) => error instanceof StudyApiError && error.code === "unavailable",
    );
    await assert.rejects(
      callStudy(USER, { action: "generate_questions", exam_id: "e", topic_id: "t" }, env, async () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      }),
      (error: unknown) => error instanceof StudyApiError && error.code === "slow",
    );
  });
});
