import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mcpResourceUrl,
  protectedResourceMetadata,
  wwwAuthenticateHeader,
  authorizationServerMetadataUrl,
} from "../src/lib/mcp/config.ts";
import { locationOf, toRulesResult, toSearchResult, searchText } from "../src/lib/mcp/format.ts";
import type { CourseRow, SearchHit } from "../src/lib/mcp/data.ts";

const course: CourseRow = {
  id: "11111111-2222-3333-4444-555555555555",
  name: "Data 100",
  code: "DATA C100",
  term_name: "Fall 2026",
  import_status: "complete",
};

function hit(overrides: Partial<SearchHit>): SearchHit {
  return {
    n: 1,
    unit_id: "unit-secret-id",
    title: "Lecture 7: Gradient descent",
    unit_type: "pdf_chunk",
    page_start: 4,
    page_end: 5,
    t_start_ms: null,
    t_end_ms: null,
    snippet: "Short snippet.",
    ...overrides,
  };
}

test("protected-resource metadata names /mcp and the Supabase auth issuer", () => {
  const meta = protectedResourceMetadata();
  assert.equal(meta.resource, mcpResourceUrl());
  assert.ok(meta.resource.endsWith("/mcp"));
  assert.equal(meta.authorization_servers.length, 1);
  assert.ok(meta.authorization_servers[0]!.endsWith("/auth/v1"));
  assert.match(wwwAuthenticateHeader(), /^Bearer resource_metadata="https:\/\/.+\/\.well-known\/oauth-protected-resource\/mcp"$/);
  assert.match(authorizationServerMetadataUrl(), /\/\.well-known\/oauth-authorization-server\/auth\/v1$/);
});

test("rules result reports the mode and leaves assignment rules empty for now", () => {
  const result = toRulesResult(course, "practice");
  assert.equal(result.label, "Practice");
  assert.ok(result.not_allowed.length > 0);
  assert.deepEqual(result.assignment_rules, []);
  assert.ok(result.open_in_polya.endsWith(`/app/courses/${course.id}`));
});

test("search result carries no unit ids and prefers the longer passage", () => {
  const hits = [hit({}), hit({ n: 2, unit_id: "other", t_start_ms: 65_000, t_end_ms: 130_000, page_start: null, page_end: null })];
  const result = toSearchResult(course, "guided", hits, new Map([["unit-secret-id", "Full passage text."]]));
  const serialized = JSON.stringify(result) + searchText(result);
  assert.ok(!serialized.includes("unit-secret-id"));
  assert.equal(result.passages[0]!.text, "Full passage text.");
  assert.equal(result.passages[1]!.text, "Short snippet.");
  assert.equal(result.passages[1]!.location, "lecture 1:05–2:10");
  assert.ok(result.rules_summary.startsWith("Guided mode:"));
});

test("location labels", () => {
  assert.equal(locationOf(hit({})), "pages 4–5");
  assert.equal(locationOf(hit({ page_end: 4 })), "page 4");
  assert.equal(locationOf(hit({ page_start: null, page_end: null, unit_type: "page_chunk" })), "page chunk");
});
