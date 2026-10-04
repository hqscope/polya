// Tool result shaping for the connector. Responses carry only what the user's
// request needs: no unit/source ids, timestamps or account details. The one id
// that does go out is the course handle, because every other tool needs it.
//
// Pure: Node tests import this file.
import { siteUrl } from "../seo.ts";
import { studyRulesFor } from "../../../supabase/functions/_shared/study-rules.ts";
import type { PolicyMode } from "../../../supabase/functions/_shared/prompts.ts";
import type { CourseRow, SearchHit } from "./data.ts";

export interface CourseSummary {
  course: string;
  name: string;
  code: string | null;
  term: string | null;
  ready: boolean;
}

export interface RulesResult {
  course_name: string;
  mode: PolicyMode;
  label: string;
  summary: string;
  allowed: string[];
  not_allowed: string[];
  assignment_rules: Array<{ assignment: string; rule: string; quote: string }>;
  open_in_polya: string;
}

export interface Passage {
  n: number;
  title: string;
  location: string;
  text: string;
}

export interface SearchResult {
  course_name: string;
  rules_summary: string;
  passages: Passage[];
  open_in_polya: string;
}

export function courseUrl(courseId: string): string {
  return `${siteUrl}/app/courses/${courseId}`;
}

export function toCourseSummary(row: CourseRow): CourseSummary {
  return {
    course: row.id,
    name: row.name,
    code: row.code,
    term: row.term_name,
    ready: row.import_status === "complete",
  };
}

export function toRulesResult(course: CourseRow, mode: PolicyMode): RulesResult {
  const rules = studyRulesFor(mode);
  return {
    course_name: course.name,
    mode,
    label: rules.label,
    summary: rules.summary,
    allowed: rules.allowed,
    not_allowed: rules.not_allowed,
    assignment_rules: [],
    open_in_polya: courseUrl(course.id),
  };
}

function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function locationOf(hit: SearchHit): string {
  if (hit.t_start_ms !== null) {
    return hit.t_end_ms !== null
      ? `lecture ${clock(hit.t_start_ms)}–${clock(hit.t_end_ms)}`
      : `lecture ${clock(hit.t_start_ms)}`;
  }
  if (hit.page_start !== null) {
    return hit.page_end !== null && hit.page_end !== hit.page_start
      ? `pages ${hit.page_start}–${hit.page_end}`
      : `page ${hit.page_start}`;
  }
  return hit.unit_type.replace(/_/g, " ");
}

export function toSearchResult(
  course: CourseRow,
  mode: PolicyMode,
  hits: SearchHit[],
  passages: Map<string, string>,
): SearchResult {
  return {
    course_name: course.name,
    rules_summary: `${studyRulesFor(mode).label} mode: ${studyRulesFor(mode).summary}`,
    passages: hits.map((hit) => ({
      n: hit.n,
      title: hit.title,
      location: locationOf(hit),
      text: passages.get(hit.unit_id) ?? hit.snippet,
    })),
    open_in_polya: courseUrl(course.id),
  };
}

// Short text twins of the structured results, for clients that only read text.
export function rulesText(result: RulesResult): string {
  const lines = [`${result.course_name}: ${result.label} mode. ${result.summary}`];
  if (result.allowed.length) lines.push(`Allowed: ${result.allowed.join("; ")}.`);
  if (result.not_allowed.length) lines.push(`Not allowed: ${result.not_allowed.join("; ")}.`);
  return lines.join("\n");
}

export function searchText(result: SearchResult): string {
  if (result.passages.length === 0) {
    return `${result.rules_summary}\nNo matching material was found in ${result.course_name}.`;
  }
  const body = result.passages
    .map((p) => `[${p.n}] ${p.title} (${p.location})\n${p.text}`)
    .join("\n\n");
  return `${result.rules_summary}\n\n${body}`;
}
