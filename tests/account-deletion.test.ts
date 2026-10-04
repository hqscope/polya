import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chunk,
  confirmMatches,
  isUnderPrefix,
  LIST_PAGE,
  listUnder,
  type ListStorage,
  matchUserByEmail,
  parseArgs,
  type StorageEntry,
  USER_PREFIXED_BUCKETS,
  USER_TABLES,
} from "../scripts/lib/account-deletion.ts";

const USER = "0e5f0000-0000-4000-8000-0000000000a1";
const OTHER = "0e5f0000-0000-4000-8000-0000000000b2";

test("parseArgs: bare email is a dry run", () => {
  assert.deepEqual(parseArgs(["a_b@berkeley.edu"]), {
    mode: "email",
    email: "a_b@berkeley.edu",
    confirm: null,
  });
});

test("parseArgs: --confirm is captured, not validated", () => {
  assert.deepEqual(parseArgs(["a@x.edu", "--confirm", "b@x.edu"]), {
    mode: "email",
    email: "a@x.edu",
    confirm: "b@x.edu",
  });
});

test("parseArgs: --user-id sweep mode lowercases the id", () => {
  assert.deepEqual(parseArgs(["--user-id", USER.toUpperCase()]), {
    mode: "user-id",
    userId: USER,
    confirm: null,
  });
});

test("parseArgs: rejects bad input", () => {
  for (const argv of [
    [],
    ["not-an-email"],
    ["a@x.edu", "b@x.edu"],
    ["a@x.edu", "--confirm"],
    ["a@x.edu", "--confirm", "--user-id"],
    ["--user-id", "nope"],
    ["a@x.edu", "--user-id", USER],
    ["a@x.edu", "--force"],
  ]) {
    assert.equal(parseArgs(argv).mode, "error", JSON.stringify(argv));
  }
});

test("confirmMatches: must repeat the target", () => {
  assert.equal(confirmMatches(null, "a@x.edu"), false);
  assert.equal(confirmMatches("a@x.edu", "a@x.edu"), true);
  assert.equal(confirmMatches(" A@X.edu ", "a@x.edu"), true);
  assert.equal(confirmMatches("b@x.edu", "a@x.edu"), false);
  assert.equal(confirmMatches("yes", "a@x.edu"), false);
  assert.equal(confirmMatches(USER.toUpperCase(), USER), true);
  assert.equal(confirmMatches(OTHER, USER), false);
});

test("matchUserByEmail: exactly one, case-insensitive", () => {
  const users = [
    { id: USER, email: "Noel_S@berkeley.edu" },
    { id: OTHER, email: "noelxs@berkeley.edu" },
  ];
  const match = matchUserByEmail(users, "noel_s@BERKELEY.edu ");
  assert.equal(match.kind, "one");
  assert.equal(match.kind === "one" && match.user.id, USER);
});

test("matchUserByEmail: underscore is literal, not a wildcard", () => {
  assert.deepEqual(matchUserByEmail([{ id: OTHER, email: "noelxs@berkeley.edu" }], "noel_s@berkeley.edu"), {
    kind: "none",
  });
});

test("matchUserByEmail: none and many are distinct", () => {
  assert.deepEqual(matchUserByEmail([{ id: USER, email: null }], "a@x.edu"), { kind: "none" });
  assert.deepEqual(
    matchUserByEmail(
      [
        { id: USER, email: "a@x.edu" },
        { id: OTHER, email: "A@x.edu" },
      ],
      "a@x.edu",
    ),
    { kind: "many", count: 2 },
  );
});

test("isUnderPrefix: only strictly under the owner's id", () => {
  assert.equal(isUnderPrefix(`${USER}/c/s/original.pdf`, USER), true);
  assert.equal(isUnderPrefix(`${USER.toUpperCase()}/x`, USER), true);
  assert.equal(isUnderPrefix(USER, USER), false);
  assert.equal(isUnderPrefix(`${OTHER}/x`, USER), false);
  assert.equal(isUnderPrefix(`${USER}/../${OTHER}/x`, USER), false);
  assert.equal(isUnderPrefix(`${USER}//x`, USER), false);
  assert.equal(isUnderPrefix(`/${USER}/x`, USER), false);
});

test("listUnder: recurses into folders and follows pages", async () => {
  const tree: Record<string, StorageEntry[]> = {
    [USER]: [
      { name: "course", id: null },
      ...Array.from({ length: LIST_PAGE + 2 }, (_, i) => ({ name: `f${i}`, id: `id${i}` })),
    ],
    [`${USER}/course`]: [{ name: "a.pdf", id: "x" }],
  };
  const calls: string[] = [];
  const list: ListStorage = async (bucket, prefix, { limit, offset }) => {
    calls.push(`${bucket}:${prefix}:${offset}`);
    return (tree[prefix] ?? []).slice(offset, offset + limit);
  };
  const paths = await listUnder(list, "polya_documents", USER);
  assert.equal(paths.length, LIST_PAGE + 3);
  assert.ok(paths.includes(`${USER}/course/a.pdf`));
  assert.ok(paths.every((p) => isUnderPrefix(p, USER)));
  assert.deepEqual(calls, [
    `polya_documents:${USER}:0`,
    `polya_documents:${USER}/course:0`,
    `polya_documents:${USER}:${LIST_PAGE}`,
  ]);
});

test("chunk splits into batches", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 2), []);
});

test("bucket and table inventory covers Polya", () => {
  assert.ok(USER_PREFIXED_BUCKETS.includes("polya_documents"));
  const polya = USER_TABLES.filter((t) => t.table.startsWith("polya_"));
  assert.equal(polya.length, 13);
  assert.ok(polya.every((t) => t.onDelete === "cascade"));
  assert.ok(USER_TABLES.some((t) => t.table === "activity_hours" && t.onDelete === "none"));
});
