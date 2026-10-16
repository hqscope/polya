// Pure HTML parsing for Gradescope pages. Gradescope has no public API, so these read the same
// markup a browser renders. Ported from Lectra's GradescopeHTMLParser.swift (June 2026) and the
// nyuoss/gradescope-api helpers. Regex-based on purpose: no DOM dependency, and every selector
// has a fallback because the markup drifts.
import type { GsAssignment, GsAssignmentStatus, GsCourse, GsCourseRole } from "./types.ts";

export const GRADESCOPE_BASE_URL = "https://www.gradescope.com";

// ---------------------------------------------------------------------------------------------
// Small HTML helpers

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Strips tags, decodes entities, and collapses whitespace. */
export function cleanText(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Attributes of one opening tag, lower-cased names, entity-decoded values. */
export function tagAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const body = tag.replace(/^<\s*[a-z0-9-]+/i, "").replace(/\/?>$/, "");
  const re = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  for (const m of body.matchAll(re)) {
    const name = m[1]?.toLowerCase();
    if (!name) continue;
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

function openingTags(html: string, tagName: string): string[] {
  return [...html.matchAll(new RegExp(`<${tagName}\\b[^>]*>`, "gi"))].map((m) => m[0]);
}

function firstMatch(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  return m ? (m[1] ?? m[0]) : null;
}

function hasClass(attrs: Record<string, string>, className: string): boolean {
  return (attrs.class ?? "").split(/\s+/).includes(className);
}

// ---------------------------------------------------------------------------------------------
// Login, CSRF, flash messages, page kind

/** The hidden authenticity_token in the login form on the home page (or any form, as fallback). */
export function parseLoginAuthenticityToken(html: string): string | null {
  const formInner = firstMatch(html, /<form\b[^>]*action=["']\/login["'][^>]*>([\s\S]*?)<\/form>/i);
  for (const scope of formInner ? [formInner, html] : [html]) {
    for (const tag of openingTags(scope, "input")) {
      const attrs = tagAttributes(tag);
      if (attrs.name === "authenticity_token" && attrs.value) return attrs.value;
    }
  }
  return null;
}

/** <meta name="csrf-token" content="..."> */
export function parseCsrfToken(html: string): string | null {
  for (const tag of openingTags(html, "meta")) {
    const attrs = tagAttributes(tag);
    if (attrs.name === "csrf-token" && attrs.content) return attrs.content;
  }
  return null;
}

/** Text of an error flash (e.g. "Invalid email/password combination."), or null. */
export function parseFlashError(html: string): string | null {
  const inline = firstMatch(
    html,
    /<div[^>]*class=["'][^"']*\balert-error\b[^"']*["'][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i,
  );
  const compact = inline ?? firstMatch(html, /<div[^>]*class=["'][^"']*\balert-error\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  if (compact === null) return null;
  const text = cleanText(compact).replace(/^×\s*/, "");
  return text.length > 0 ? text : null;
}

export type FlashKind = "invalid_credentials" | "sso_required" | "other";

export function classifyFlashError(message: string): FlashKind {
  const m = message.toLowerCase();
  if (/single sign[- ]?on|\bsso\b|school credentials|log in (?:through|with|using) your (?:school|institution)/.test(m)) {
    return "sso_required";
  }
  if (/invalid (?:email|password)|email\/password|incorrect (?:email|password)/.test(m)) return "invalid_credentials";
  return "other";
}

export function isLoginPage(html: string): boolean {
  const lower = html.toLowerCase();
  const hasLoginForm = /<form\b[^>]*action=["']\/login["']/.test(lower);
  const hasPasswordField = lower.includes("session[password]");
  return hasLoginForm || hasPasswordField;
}

export function isAuthenticatedPage(html: string): boolean {
  const lower = html.toLowerCase();
  if (isLoginPage(html)) return false;
  return (
    lower.includes("account-show") ||
    lower.includes("coursebox--shortname") ||
    lower.includes('href="/logout"') ||
    /href=["']\/courses\/\d+["']/.test(lower)
  );
}

// ---------------------------------------------------------------------------------------------
// Courses (/account)

/**
 * Course cards from the account page. Instructor and student courses sit under separate
 * "Instructor Courses" / "Student Courses" headings; an account with no heading is all-student
 * unless the page offers "Create Course" (staff only), as nyuoss/gradescope-api does.
 */
export function parseAccountCourses(html: string): GsCourse[] {
  const start = html.search(/id=["']account-show["']/i);
  const scope = start >= 0 ? html.slice(start) : html;
  let role: GsCourseRole = /js-createNewCourse/i.test(html) ? "instructor" : "student";
  let term: string | null = null;

  const token =
    /<h2\b[^>]*class=["'][^"']*\bpageHeading\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>|<div\b[^>]*class=["'][^"']*\bcourseList--term\b[^"']*["'][^>]*>([\s\S]*?)<\/div>|(<a\b[^>]*href=["'](?:https?:\/\/[^"'/]*gradescope\.com)?\/courses\/(\d+)\/?["'][^>]*>)([\s\S]*?)<\/a>/gi;

  const cards: GsCourse[] = [];
  const loose: GsCourse[] = [];
  const seen = new Set<string>();
  for (const m of scope.matchAll(token)) {
    if (m[1] !== undefined) {
      const heading = cleanText(m[1]).toLowerCase();
      if (heading.includes("instructor")) role = "instructor";
      else if (heading.includes("student")) role = "student";
      continue;
    }
    if (m[2] !== undefined) {
      const text = cleanText(m[2]);
      term = text.length > 0 ? text : null;
      continue;
    }
    const courseId = m[4];
    const inner = m[5] ?? "";
    if (!courseId || seen.has(courseId)) continue;
    const shortName = cleanText(firstMatch(inner, /<h3[^>]*courseBox--shortname[^>]*>([\s\S]*?)<\/h3>/i) ?? "");
    const fullName = cleanText(firstMatch(inner, /<div[^>]*courseBox--name[^>]*>([\s\S]*?)<\/div>/i) ?? "");
    const isCard = shortName.length > 0 || hasClass(tagAttributes(m[3] ?? ""), "courseBox");
    const fallback = cleanText(inner);
    const short = shortName || fullName || fallback;
    if (!short) continue;
    seen.add(courseId);
    const course: GsCourse = { course_id: courseId, short_name: short, name: fullName || short, term, role };
    (isCard ? cards : loose).push(course);
  }
  // Prefer real course cards; bare /courses/<id> links are the fallback when the markup changed.
  return cards.length > 0 ? cards : loose;
}

/** Course title from a course page header, used when the caller didn't pass a name. */
export function parseCourseTitle(html: string): string | null {
  const raw =
    firstMatch(html, /<h1[^>]*courseHeader--title[^>]*>([\s\S]*?)<\/h1>/i) ??
    firstMatch(html, /<title>([\s\S]*?)<\/title>/i);
  if (raw === null) return null;
  const text = cleanText(raw).replace(/\s*\|\s*Gradescope\s*$/i, "");
  return text.length > 0 ? text : null;
}

// ---------------------------------------------------------------------------------------------
// Dates

const DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2}|UTC)?$/i;

function offsetMinutes(raw: string): number {
  if (raw.toUpperCase() === "Z" || raw.toUpperCase() === "UTC") return 0;
  const sign = raw[0] === "-" ? -1 : 1;
  const digits = raw.slice(1).replace(":", "");
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
}

/** Offset (minutes east of UTC) of an IANA zone at a given instant. */
function zoneOffsetMinutes(timeZone: string, epochMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(epochMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - epochMs) / 60_000);
}

/**
 * Gradescope dates to an ISO UTC string. The student table uses `datetime="2026-10-17 23:59:00 -0700"`;
 * the instructor React props use ISO 8601 with an offset. A value without an offset is read in
 * `timeZone` (the page's zone when it names one, else the caller's fallback).
 */
export function parseGradescopeDate(raw: string | null | undefined, timeZone = "UTC"): string | null {
  if (!raw) return null;
  const m = DATE_RE.exec(raw.trim());
  if (!m) {
    const fallback = Date.parse(raw);
    return Number.isNaN(fallback) ? null : new Date(fallback).toISOString();
  }
  const [, y, mo, d, h = "0", mi = "0", s = "0", offset] = m;
  const localAsUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (Number.isNaN(localAsUtc)) return null;
  if (offset) return new Date(localAsUtc - offsetMinutes(offset) * 60_000).toISOString();
  try {
    let guess = localAsUtc - zoneOffsetMinutes(timeZone, localAsUtc) * 60_000;
    guess = localAsUtc - zoneOffsetMinutes(timeZone, guess) * 60_000;
    return new Date(guess).toISOString();
  } catch {
    return new Date(localAsUtc).toISOString();
  }
}

/** An IANA zone the page declares (data-time-zone / "time_zone" in JSON), if any. */
export function parsePageTimeZone(html: string): string | null {
  const raw =
    firstMatch(html, /data-time-?zone=["']([A-Za-z_]+\/[A-Za-z_/+-]+)["']/i) ??
    firstMatch(html, /&quot;time_?zone&quot;:&quot;([A-Za-z_]+\/[A-Za-z_/+-]+)&quot;/i) ??
    firstMatch(html, /"time_?zone"\s*:\s*"([A-Za-z_]+\/[A-Za-z_/+-]+)"/i);
  if (!raw) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
    return raw;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Assignments (/courses/{id})

export interface ParseAssignmentsOptions {
  courseId: string;
  courseName?: string | null;
  /** Zone for dates that carry no offset, when the page doesn't declare one. Default UTC. */
  timeZone?: string;
  baseUrl?: string;
}

const SCORE_RE = /(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/;

export function normalizeStatus(statusText: string): { status: GsAssignmentStatus; score: string | null } {
  const text = statusText.replace(/,/g, "").trim();
  const score = SCORE_RE.exec(text);
  if (score) return { status: "graded", score: `${score[1]} / ${score[2]}` };
  const lower = text.toLowerCase();
  if (!lower) return { status: "unknown", score: null };
  if (/no submission|not submitted|missing|unsubmitted/.test(lower)) return { status: "not_submitted", score: null };
  if (/\bgraded\b/.test(lower) && !/ungraded/.test(lower)) return { status: "graded", score: null };
  if (/submitted|late|ungraded|resubmit/.test(lower)) return { status: "submitted", score: null };
  return { status: "unknown", score: null };
}

function absoluteUrl(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return baseUrl;
  }
}

/** Student course page: a table with one `<tr role="row">` per assignment (nyuoss + Lectra). */
function parseStudentTable(html: string, opts: Required<Omit<ParseAssignmentsOptions, "courseName">> & { courseName: string }): GsAssignment[] {
  let rows = [...html.matchAll(/<tr\b[^>]*role=["']row["'][^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1] ?? "");
  if (rows.length === 0) rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1] ?? "");

  const out: GsAssignment[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    // Three shapes: submitted (link to the submission), open (submit button with
    // data-assignment-id), closed without a submission (plain text, no id: skipped).
    const href = firstMatch(row, /href=["']([^"']*\/courses\/\d+\/assignments\/\d+[^"']*)["']/i);
    const assignmentId =
      (href ? firstMatch(href, /\/assignments\/(\d+)/) : null) ?? firstMatch(row, /data-assignment-id=["']([^"']+)["']/i);
    if (!assignmentId || seen.has(assignmentId)) continue;
    seen.add(assignmentId);

    const titleRaw =
      firstMatch(row, /<th\b[^>]*>([\s\S]*?)<\/th>/i) ??
      firstMatch(row, /<a\b[^>]*href=["'][^"']*\/assignments\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/i) ??
      "";
    const title = cleanText(titleRaw) || `Assignment ${assignmentId}`;

    const dueDates = [...row.matchAll(/<time\b[^>]*>/gi)]
      .map((m) => tagAttributes(m[0]))
      .filter((a) => hasClass(a, "submissionTimeChart--dueDate"))
      .map((a) => a.datetime ?? "");
    const statusCell = firstMatch(row, /<td\b[^>]*>([\s\S]*?)<\/td>/i) ?? "";
    const { status, score } = normalizeStatus(cleanText(statusCell));

    out.push({
      course_id: opts.courseId,
      course_name: opts.courseName,
      assignment_id: assignmentId,
      title,
      due_at: parseGradescopeDate(dueDates[0], opts.timeZone),
      late_due_at: parseGradescopeDate(dueDates[1], opts.timeZone),
      status,
      score,
      url: absoluteUrl(href ?? `/courses/${opts.courseId}/assignments/${assignmentId}`, opts.baseUrl),
    });
  }
  return out;
}

interface ReactAssignmentRow {
  type?: unknown;
  title?: unknown;
  url?: unknown;
  total_points?: unknown;
  submission_window?: { release_date?: unknown; due_date?: unknown; hard_due_date?: unknown } | null;
}

/** Instructor/TA view: `<div data-react-class="AssignmentsTable" data-react-props="{json}">`. */
function parseReactTable(html: string, opts: Required<Omit<ParseAssignmentsOptions, "courseName">> & { courseName: string }): GsAssignment[] {
  const div = openingTags(html, "div")
    .map(tagAttributes)
    .find((a) => a["data-react-class"] === "AssignmentsTable" && a["data-react-props"]);
  if (!div) return [];
  let table: unknown;
  try {
    table = (JSON.parse(div["data-react-props"] ?? "") as { table_data?: unknown }).table_data;
  } catch {
    return [];
  }
  if (!Array.isArray(table)) return [];

  const out: GsAssignment[] = [];
  for (const item of table as ReactAssignmentRow[]) {
    if (item?.type !== "assignment" || typeof item.url !== "string") continue;
    const assignmentId = firstMatch(item.url, /\/assignments\/(\d+)/);
    if (!assignmentId) continue;
    const window = item.submission_window ?? {};
    const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
    out.push({
      course_id: opts.courseId,
      course_name: opts.courseName,
      assignment_id: assignmentId,
      title: (typeof item.title === "string" ? item.title.trim() : "") || `Assignment ${assignmentId}`,
      due_at: parseGradescopeDate(str(window.due_date), opts.timeZone),
      late_due_at: parseGradescopeDate(str(window.hard_due_date), opts.timeZone),
      status: "unknown",
      score: null,
      url: absoluteUrl(item.url, opts.baseUrl),
    });
  }
  return out;
}

/** Assignments on a course page, either layout. An empty list is valid (a course with none). */
export function parseCourseAssignments(html: string, options: ParseAssignmentsOptions): GsAssignment[] {
  const opts = {
    courseId: options.courseId,
    courseName: options.courseName?.trim() || parseCourseTitle(html) || `Course ${options.courseId}`,
    timeZone: parsePageTimeZone(html) ?? options.timeZone ?? "UTC",
    baseUrl: options.baseUrl ?? GRADESCOPE_BASE_URL,
  };
  const instructor = parseReactTable(html, opts);
  return instructor.length > 0 ? instructor : parseStudentTable(html, opts);
}
