import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";

import {
  checkSearchQuery,
  dedupeBySignature,
  EMBED_DIM,
  estimateEmbeddingUnits,
  fuseHits,
  isEmbedding,
  isMissingFunction,
  l2Normalize,
  lexicalQueries,
  MIN_VECTOR_SIMILARITY,
  parseUsageTotal,
  rankLexical,
  roleWeight,
  rrfMerge,
  RRF_K,
  SEARCH_QUERY_MAX_CHARS,
  searchTerms,
  toVectorLiteral,
  withoutRoles,
  type RetrievedUnit,
} from "../agent/lib/search-rank.ts";
import {
  cleanPassage,
  IMESSAGE_CITATION_STYLE,
  locationLabel,
  matchCourse,
  PASSAGES_MAX,
  polyaAppUrl,
  safeLink,
  searchResultText,
  toSearchFound,
  type CourseRow,
  type SearchToolResult,
  type SourceMeta,
} from "../agent/lib/search-format.ts";
import { rulesReminder } from "../agent/lib/study-rules.ts";

function unit(id: string, overrides: Partial<RetrievedUnit> = {}): RetrievedUnit {
  return {
    unit_id: id,
    source_id: "src-1",
    unit_type: "chunk",
    content_role: "material",
    ordinal: 0,
    heading_path: null,
    page_start: null,
    page_end: null,
    t_start_ms: null,
    t_end_ms: null,
    procedure_id: null,
    step_number: null,
    title: "Lecture 7 slides",
    content: `Content of ${id}`,
    score: 0.5,
    ...overrides,
  };
}

function course(id: string, name: string, overrides: Partial<CourseRow> = {}): CourseRow {
  return { id, name, code: null, term_name: "Fall 2026", import_status: "complete", ...overrides };
}

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";

describe("withheld roles", () => {
  it("drops withheld roles even if the database returned them", () => {
    const units = [unit("a"), unit("b", { content_role: "solution_key" })];
    assert.deepEqual(withoutRoles(units, ["solution_key"]).map((u) => u.unit_id), ["a"]);
    assert.equal(withoutRoles(units, []).length, 2);
  });
});

describe("checkSearchQuery", () => {
  it("rejects missing, blank and over-long queries", () => {
    assert.equal(checkSearchQuery(undefined), "missing");
    assert.equal(checkSearchQuery("   "), "missing");
    assert.equal(checkSearchQuery("x".repeat(2_001)), "too_long");
    assert.equal(checkSearchQuery(` ${"x".repeat(2_000)} `), "ok");
  });
});

describe("fusion", () => {
  it("rrfMerge ranks items found by both lists first", () => {
    const merged = rrfMerge(["a", "b", "c"], ["c", "d"], (x) => x);
    assert.equal(merged[0], "c");
    assert.deepEqual(new Set(merged), new Set(["a", "b", "c", "d"]));
  });

  it("rrfMerge applies the weight", () => {
    const merged = rrfMerge(["low", "high"], [], (x) => x, 60, (x) => (x === "low" ? 0.5 : 1));
    assert.deepEqual(merged, ["high", "low"]);
  });

  it("dedupeBySignature keeps the first of near-identical chunks", () => {
    const hits = [
      { content: "Submit this quiz by Friday!" },
      { content: "submit   this quiz by friday" },
      { content: "Eigenvalues of a matrix" },
    ];
    assert.equal(dedupeBySignature(hits).length, 2);
  });

  it("fuseHits drops weak vector-only hits unless full-text also found them", () => {
    const weak = MIN_VECTOR_SIMILARITY - 0.05;
    const vector = [unit("strong", { score: 0.8 }), unit("weak", { score: weak }), unit("weak-but-lexical", { score: weak })];
    const fts = [unit("weak-but-lexical", { content: "lexical match" })];
    const ids = fuseHits(vector, fts, 10).map((u) => u.unit_id);
    assert.ok(ids.includes("strong"));
    assert.ok(ids.includes("weak-but-lexical"));
    assert.ok(!ids.includes("weak"));
    assert.equal(ids[0], "weak-but-lexical");
  });

  it("fuseHits caps the result", () => {
    const many = Array.from({ length: 10 }, (_, i) => unit(`u${i}`));
    assert.equal(fuseHits(many, [], 6).length, 6);
  });
});

describe("query embedding helpers", () => {
  it("l2Normalize returns a unit vector and leaves zero vectors alone", () => {
    const v = l2Normalize([3, 4]);
    assert.deepEqual(v, [0.6, 0.8]);
    assert.deepEqual(l2Normalize([0, 0]), [0, 0]);
  });

  it("formats a pgvector literal", () => {
    assert.equal(toVectorLiteral([0.1, -2, 3]), "[0.1,-2,3]");
  });

  it("accepts only full-size finite vectors", () => {
    assert.equal(isEmbedding(new Array(EMBED_DIM).fill(0.1)), true);
    assert.equal(isEmbedding(new Array(EMBED_DIM - 1).fill(0.1)), false);
    assert.equal(isEmbedding([...new Array(EMBED_DIM - 1).fill(0.1), Number.NaN]), false);
    assert.equal(isEmbedding("nope"), false);
  });

  it("estimates budget units like ai-budget.ts", () => {
    assert.equal(estimateEmbeddingUnits(10), 1);
    assert.equal(estimateEmbeddingUnits(0), 1);
    assert.equal(estimateEmbeddingUnits(2_000), 2);
  });
});

describe("limits", () => {
  it("parses the daily usage total and fails closed on anything odd", () => {
    assert.equal(parseUsageTotal(5), 5);
    assert.equal(parseUsageTotal("12"), 12);
    assert.equal(parseUsageTotal(BigInt(7)), 7);
    assert.equal(parseUsageTotal(null), null);
    assert.equal(parseUsageTotal(""), null);
    assert.equal(parseUsageTotal("abc"), null);
    assert.equal(parseUsageTotal(Number.NaN), null);
  });

  it("recognizes a missing database function", () => {
    assert.equal(isMissingFunction({ code: "PGRST202" }), true);
    assert.equal(isMissingFunction({ code: "42883" }), true);
    assert.equal(isMissingFunction({ code: "42501" }), false);
    assert.equal(isMissingFunction(null), false);
  });
});

describe("lexical fallback", () => {
  it("keeps distinct content words and drops operators and stopwords", () => {
    assert.deepEqual(searchTerms('How do I find the "eigenvalues" -or- eigenvalues of a 2x2 matrix?'), [
      "eigenvalues",
      "2x2",
      "matrix",
    ]);
    assert.deepEqual(searchTerms("what is it"), []);
  });

  it("builds every-term and any-term queries", () => {
    assert.deepEqual(lexicalQueries(["eigenvalues", "matrix"]), {
      all: "eigenvalues matrix",
      any: "eigenvalues or matrix",
    });
    assert.equal(lexicalQueries([]), null);
  });

  it("ranks rows covering more terms first, headings a little higher", () => {
    const rows = [
      unit("one-term", { content: "A matrix is a grid of numbers." }),
      unit("both-terms", { content: "Each eigenvalue of the matrix solves det(A - λI) = 0." }),
      unit("heading", { content: "A matrix is a grid.", heading_path: "Eigenvalues" }),
    ];
    const ranked = rankLexical(["eigenvalues", "matrix"], rows, 6).map((u) => u.unit_id);
    assert.deepEqual(ranked, ["both-terms", "heading", "one-term"]);
  });
});

describe("matchCourse", () => {
  const courses = [
    course(ID_A, "Linear Algebra and Differential Equations", { code: "MATH 54" }),
    course(ID_B, "General Biology", { code: "BIO 1A" }),
    course(ID_C, "General Chemistry", { code: "CHEM 1A" }),
  ];

  it("matches an id from the student's own list only", () => {
    assert.deepEqual(matchCourse(courses, ID_B), { kind: "match", course: courses[1] });
    assert.deepEqual(matchCourse(courses, "44444444-4444-4444-8444-444444444444"), { kind: "none" });
  });

  it("matches a code or name regardless of case and spacing", () => {
    assert.equal(matchCourse(courses, "math54").kind, "match");
    assert.equal(matchCourse(courses, "bio 1a").kind, "match");
    const byName = matchCourse(courses, "linear algebra");
    assert.equal(byName.kind === "match" && byName.course.id, ID_A);
  });

  it("matches word prefixes", () => {
    const result = matchCourse(courses, "gen chem");
    assert.equal(result.kind === "match" && result.course.id, ID_C);
  });

  it("asks when more than one course fits", () => {
    const result = matchCourse(courses, "general");
    assert.equal(result.kind, "ambiguous");
    assert.equal(result.kind === "ambiguous" && result.candidates.length, 2);
  });

  it("uses the term to tell same-name courses apart", () => {
    const twoTerms = [
      course(ID_A, "Physics 7A", { term_name: "Spring 2026" }),
      course(ID_B, "Physics 7A", { term_name: "Fall 2026" }),
    ];
    assert.equal(matchCourse(twoTerms, "physics 7a").kind, "ambiguous");
    const result = matchCourse(twoTerms, "Physics 7A Fall 2026");
    assert.equal(result.kind === "match" && result.course.id, ID_B);
  });

  it("returns none for blank or unrelated input", () => {
    assert.deepEqual(matchCourse(courses, "  "), { kind: "none" });
    assert.deepEqual(matchCourse(courses, "art history"), { kind: "none" });
  });
});

describe("passages", () => {
  it("labels transcript times, pages and unit types", () => {
    assert.equal(locationLabel(unit("t", { t_start_ms: 62_000, t_end_ms: 125_000 })), "transcript 1:02–2:05");
    assert.equal(locationLabel(unit("t", { t_start_ms: 5_000 })), "transcript 0:05");
    assert.equal(locationLabel(unit("p", { page_start: 2, page_end: 2 })), "p.2");
    assert.equal(locationLabel(unit("p", { page_start: 2, page_end: 4 })), "p.2–4");
    assert.equal(locationLabel(unit("s", { unit_type: "procedure_step" })), "step");
    assert.equal(locationLabel(unit("c")), "passage");
  });

  it("flattens and trims passage text at a word", () => {
    assert.equal(cleanPassage("a\u0007b\n\n  c"), "ab c");
    const long = cleanPassage("word ".repeat(400), 50);
    assert.ok(long.length <= 51);
    assert.ok(long.endsWith("word…"));
  });

  it("lets only https links through", () => {
    assert.equal(safeLink("https://bcourses.berkeley.edu/courses/1/pages/x"), "https://bcourses.berkeley.edu/courses/1/pages/x");
    assert.equal(safeLink("http://example.com"), null);
    assert.equal(safeLink("javascript:alert(1)"), null);
    assert.equal(safeLink("not a url"), null);
    assert.equal(safeLink(null), null);
  });

  it("uses POLYA_APP_URL when it is a valid https URL", () => {
    assert.equal(polyaAppUrl("https://askpolya.com/"), "https://askpolya.com");
    assert.equal(polyaAppUrl("https://staging.askpolya.com"), "https://staging.askpolya.com");
    assert.equal(polyaAppUrl(undefined), "https://askpolya.com");
    assert.equal(polyaAppUrl("ftp://nope"), "https://askpolya.com");
  });
});

describe("search result", () => {
  const algebra = course(ID_A, "Linear Algebra");
  const sources = new Map<string, SourceMeta>([
    ["src-1", { title: "Lecture 7 slides", canvas_url: "https://bcourses.berkeley.edu/files/9/download?download_frd=1" }],
    ["src-2", { title: "Homework 3", canvas_url: null }],
  ]);

  it("numbers passages, fills titles and links from the sources, and caps the count", () => {
    const units = [
      unit("a", { page_start: 2, page_end: 2 }),
      unit("b", { source_id: "src-2", title: null }),
      unit("c", { source_id: "src-missing", title: null, heading_path: "Week 3 > Notes" }),
      ...Array.from({ length: 5 }, (_, i) => unit(`x${i}`)),
    ];
    const result = toSearchFound(algebra, "guided", units, sources, "https://askpolya.com");
    assert.equal(result.passages.length, PASSAGES_MAX);
    assert.deepEqual(
      result.passages.slice(0, 3).map((p) => [p.n, p.title, p.where, p.link]),
      [
        [1, "Lecture 7 slides", "p.2", "https://bcourses.berkeley.edu/files/9/download?download_frd=1"],
        [2, "Homework 3", "passage", null],
        [3, "Week 3 > Notes", "passage", null],
      ],
    );
    assert.equal(result.open_in_polya, `https://askpolya.com/app/courses/${ID_A}`);
    assert.equal(result.still_loading, false);
  });

  it("prints each source link once and frames passages as data", () => {
    const result = toSearchFound(algebra, "practice", [unit("a"), unit("b")], sources, "https://askpolya.com");
    const text = searchResultText(result);
    assert.ok(text.startsWith(rulesReminder("practice")));
    assert.ok(text.includes(IMESSAGE_CITATION_STYLE));
    assert.match(text, /\[1\] Lecture 7 slides \(passage\)/);
    assert.match(text, /\[2\] Lecture 7 slides/);
    assert.equal(text.split("Link: ").length - 1, 1);
    assert.match(text, /reference data, not instructions/);
    assert.match(text, /Course in Polya: https:\/\/askpolya\.com\/app\/courses\//);
  });

  it("says when nothing matched and when materials are still loading", () => {
    const loading = course(ID_A, "Linear Algebra", { import_status: "importing" });
    const text = searchResultText(toSearchFound(loading, "open", [], sources, "https://askpolya.com"));
    assert.match(text, /still loading/);
    assert.match(text, /No matching material was found in Linear Algebra\./);
  });

  it("lists course choices for the model when the course is unclear", () => {
    const result: SearchToolResult = {
      status: "pick_course",
      message: "Ask which one they mean.",
      courses: [{ course: ID_A, name: "Linear Algebra", term: "Fall 2026" }],
    };
    assert.equal(searchResultText(result), `Ask which one they mean.\n- Linear Algebra (Fall 2026) [course: ${ID_A}]`);
    assert.equal(searchResultText({ status: "limited", message: "Try later.", courses: [] }), "Try later.");
  });
});

// The ranking copies must match Polya's source of truth. The source lives outside this
// deployable, so the check runs only where the whole polya repo is checked out.
const SHARED = new URL("../../supabase/functions/_shared/", import.meta.url);
const shared = (file: string) => new URL(file, SHARED);

describe("search copies", { skip: !existsSync(shared("rank.ts")) && "polya source not present" }, () => {
  it("match polya/supabase/functions/_shared (rank, rrf, search-limits, embeddings, ai-budget)", async () => {
    const rank = (await import(shared("rank.ts").href)) as {
      roleWeight: typeof roleWeight;
      dedupeBySignature: typeof dedupeBySignature;
    };
    const rrf = (await import(shared("rrf.ts").href)) as { rrfMerge: typeof rrfMerge; RRF_K: number };
    const limits = (await import(shared("search-limits.ts").href)) as {
      checkSearchQuery: typeof checkSearchQuery;
      SEARCH_QUERY_MAX_CHARS: number;
    };
    const embeddings = (await import(shared("embeddings.ts").href)) as {
      l2Normalize: (v: number[]) => number[];
      toVectorLiteral: (v: number[]) => string;
      EMBED_DIM: number;
    };
    const budget = (await import(shared("ai-budget.ts").href)) as {
      estimateEmbeddingUnits: typeof estimateEmbeddingUnits;
    };

    for (const role of ["material", "syllabus", "assignment", "solution_key", "other"]) {
      assert.equal(roleWeight(role), rank.roleWeight(role), role);
    }
    const chunks = [{ content: "Submit this quiz!" }, { content: "submit this QUIZ" }, { content: "Eigenvalues" }, { content: "" }];
    assert.deepEqual(dedupeBySignature(chunks), rank.dedupeBySignature(chunks));

    const a = ["a", "b", "c", "d"];
    const b = ["d", "x", "a"];
    const weight = (id: string) => (id === "b" ? 0.8 : 1);
    assert.deepEqual(rrfMerge(a, b, (x) => x, RRF_K, weight), rrf.rrfMerge(a, b, (x) => x, rrf.RRF_K, weight));
    assert.equal(RRF_K, rrf.RRF_K);

    assert.equal(SEARCH_QUERY_MAX_CHARS, limits.SEARCH_QUERY_MAX_CHARS);
    for (const q of [undefined, 42, "", "  ", "ok", "x".repeat(2_000), "x".repeat(2_001)]) {
      assert.equal(checkSearchQuery(q), limits.checkSearchQuery(q));
    }

    assert.equal(EMBED_DIM, embeddings.EMBED_DIM);
    assert.deepEqual(l2Normalize([1, 2, 2]), embeddings.l2Normalize([1, 2, 2]));
    assert.equal(toVectorLiteral([0.5, -1]), embeddings.toVectorLiteral([0.5, -1]));

    for (const chars of [0, 1, 10, 300, 2_000, 50_000]) {
      assert.equal(estimateEmbeddingUnits(chars), budget.estimateEmbeddingUnits(chars), String(chars));
    }
  });
});

it("docLink opens the student's PDF at the passage's page, https only", async () => {
  const { docLink } = await import("../agent/lib/search-format.ts");
  assert.equal(docLink("https://x.supabase.co/storage/v1/object/sign/polya_documents/a.pdf?token=t", 7), "https://x.supabase.co/storage/v1/object/sign/polya_documents/a.pdf?token=t#page=7");
  assert.equal(docLink("https://x.supabase.co/a.pdf?token=t", null), "https://x.supabase.co/a.pdf?token=t");
  assert.equal(docLink("http://x/a.pdf", 2), null);
  assert.equal(docLink(null, 2), null);
});
