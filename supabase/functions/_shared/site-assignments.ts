// Assignment due dates from a course website. Heuristic and pure: no fetching,
// no model calls, no Deno globals, so Node's test runner covers it.
//
// Two passes over a page:
//   1. Schedule tables. A row whose first date-like cell gives the day, and
//      whose other cells hold items; an item that says "due" is an assignment
//      due that day ("Homework 0 Due · Prerequisite Math").
//   2. Everything outside tables, line by line: a line with "due" and a date
//      ("Project 2 is due Friday, Oct 9 at 5pm").
// A date without a year takes the year that matches its weekday (when one is
// given) closest to now; a date without a time takes the default (11:59 PM).
// Results far from now (a template's 2024 sample, a 2031 typo) are dropped.
//
// Each result is meant to become one `site_assignment` source: content_role
// 'assignment', due_at set, its stored text from assignmentDocument().
import { decodeEntities, stripHtmlToText } from "./canvas.ts";

export const DEFAULT_TIME_ZONE = "America/Los_Angeles";
export const DEFAULT_DUE_TIME = { hour: 23, minute: 59 };

// Keep due dates within this window around now.
const PAST_WINDOW_DAYS = 200;
const FUTURE_WINDOW_DAYS = 400;
const DAY_MS = 86_400_000;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const WEEKDAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export interface LocalDate {
  year: number | null;
  month: number;
  day: number;
  weekday: number | null;
}

export interface LocalTime {
  hour: number;
  minute: number;
}

const MONTH_NAME_DATE = new RegExp(
  String.raw`(?:\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s+)?` +
    String.raw`\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?`,
  "i",
);
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const NUMERIC_DATE = /(?:\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s+)?\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/i;
const TIME_12H = /\b(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap])\.?\s*m\b\.?/i;
const TIME_24H = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;

function validDay(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/** The first date in `text`, or null. Weekday is 0 (Sunday) – 6 when written. */
export function parseDate(text: string): LocalDate | null {
  const value = String(text ?? "");
  const iso = value.match(ISO_DATE);
  if (iso) {
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (validDay(month, day)) return { year: Number(iso[1]), month, day, weekday: null };
  }
  const named = value.match(MONTH_NAME_DATE);
  if (named) {
    const month = MONTHS[named[2]!.toLowerCase().slice(0, named[2]!.toLowerCase().startsWith("sept") ? 4 : 3)]!;
    const day = Number(named[3]);
    if (validDay(month, day)) {
      return {
        year: named[4] ? Number(named[4]) : null,
        month,
        day,
        weekday: named[1] ? WEEKDAYS[named[1].toLowerCase().slice(0, 3)]! : null,
      };
    }
  }
  const numeric = value.match(NUMERIC_DATE);
  if (numeric) {
    const month = Number(numeric[2]);
    const day = Number(numeric[3]);
    let year = numeric[4] ? Number(numeric[4]) : null;
    if (year !== null && year < 100) year += 2000;
    if (validDay(month, day)) {
      return { year, month, day, weekday: numeric[1] ? WEEKDAYS[numeric[1].toLowerCase().slice(0, 3)]! : null };
    }
  }
  return null;
}

/** The first time of day in `text` ("11:59 PM", "5pm", "23:59", "noon", "midnight"), or null. */
export function parseTime(text: string): LocalTime | null {
  const value = String(text ?? "");
  const twelve = value.match(TIME_12H);
  if (twelve) {
    let hour = Number(twelve[1]) % 12;
    if (twelve[3]!.toLowerCase() === "p") hour += 12;
    const minute = twelve[2] ? Number(twelve[2]) : 0;
    if (hour <= 23 && minute <= 59) return { hour, minute };
  }
  if (/\bnoon\b/i.test(value)) return { hour: 12, minute: 0 };
  if (/\bmidnight\b/i.test(value)) return { hour: 23, minute: 59 };
  const day24 = value.match(TIME_24H);
  if (day24) return { hour: Number(day24[1]), minute: Number(day24[2]) };
  return null;
}

/** The time zone a line names ("PT", "Eastern"), or null. */
export function parseTimeZone(text: string): string | null {
  const value = String(text ?? "");
  if (/\b(P[SD]?T|Pacific)\b/.test(value)) return "America/Los_Angeles";
  if (/\b(E[SD]?T|Eastern)\b/.test(value)) return "America/New_York";
  if (/\b(C[SD]?T|Central)\b/.test(value)) return "America/Chicago";
  if (/\b(M[SD]?T|Mountain)\b/.test(value)) return "America/Denver";
  return null;
}

function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Wall-clock time in `timeZone` → the UTC instant (DST-aware). */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - tzOffsetMs(wall, timeZone);
  const second = wall - tzOffsetMs(first, timeZone);
  return new Date(second);
}

/** Fills in a missing year: the one matching the weekday (if written) that lands closest to now. */
export function resolveYear(date: LocalDate, now: Date): number {
  if (date.year !== null) return date.year;
  const thisYear = now.getUTCFullYear();
  const candidates = [thisYear - 1, thisYear, thisYear + 1].filter((year) => {
    if (date.weekday === null) return true;
    return new Date(Date.UTC(year, date.month - 1, date.day)).getUTCDay() === date.weekday;
  });
  const pool = candidates.length > 0 ? candidates : [thisYear];
  return pool.reduce((best, year) => {
    const distance = Math.abs(Date.UTC(year, date.month - 1, date.day) - now.getTime());
    const bestDistance = Math.abs(Date.UTC(best, date.month - 1, date.day) - now.getTime());
    return distance < bestDistance ? year : best;
  });
}

export interface ItemLink {
  url: string;
  text: string;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// The links inside one schedule item, resolved against the page.
function itemLinks(html: string, base: URL): ItemLink[] {
  const out: ItemLink[] = [];
  for (const match of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    const href = decodeEntities((match[1] ?? match[2] ?? "").trim());
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(href)) continue;
    try {
      const url = new URL(href, base);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      out.push({ url: url.toString(), text: textOf(match[3] ?? "").slice(0, 200) });
    } catch {
      continue;
    }
  }
  return out;
}

export interface SiteAssignment {
  /** Stable identity (polya_sources.canvas_id), e.g. "due:homework-0-prerequisite-math". */
  key: string;
  title: string;
  /** UTC ISO instant. */
  dueAt: string;
  timeZone: string;
  /** True when the page gave a time, not just a date. */
  timeGiven: boolean;
  /** Links in the same schedule item (the assignment's handout, notebook, …). */
  links: ItemLink[];
  pageUrl: string;
}

export interface ExtractOptions {
  pageUrl: URL;
  /** Title of the page, used when a "due" line names nothing else. */
  pageTitle?: string;
  now?: Date;
  timeZone?: string;
  defaultTime?: LocalTime;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function textOf(html: string): string {
  return collapse(stripHtmlToText(html));
}

// Date/time fragments removed from a title.
const DATE_BITS = new RegExp(
  [
    MONTH_NAME_DATE.source,
    ISO_DATE.source,
    String.raw`\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b`,
    TIME_12H.source,
    TIME_24H.source,
    String.raw`\b(P[SD]?T|E[SD]?T|C[SD]?T|M[SD]?T|Pacific|Eastern|Central|Mountain)( Time)?\b`,
    String.raw`\b(sun|mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?)(day)?\b\.?`,
    String.raw`\b(noon|midnight)\b`,
  ].join("|"),
  "gi",
);

const EDGE_PUNCTUATION = /^[\s•*·:,.()[\]\-–—]+|[\s•*·:,.()[\]\-–—]+$/g;
const TRAILING_FILLER = /\b(is|are|will be|must be|should be|to be|on|at|by|before|date|deadline)$/i;
const LEADING_FILLER = /^(at|by|on|before|from)\b/i;

function cleanTitlePart(text: string): string {
  let out = collapse(text.replace(DATE_BITS, " ")).replace(EDGE_PUNCTUATION, "");
  // Once the date is gone, "(… at …)" leaves its connector words behind.
  for (let i = 0; i < 4; i++) {
    const next = collapse(out.replace(TRAILING_FILLER, "").replace(LEADING_FILLER, "")).replace(EDGE_PUNCTUATION, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

/** "Homework 0 Due Prerequisite Math" → "Homework 0: Prerequisite Math". */
export function titleFromDueText(text: string, fallback = ""): string {
  const parts = collapse(text).split(/\bdue\b/i);
  let left = cleanTitlePart(parts[0] ?? "");
  // A sentence ("…option after the Pre-Semester Survey is due"): keep the
  // thing that's due, the words after the last article or preposition.
  if (left.length > 50) {
    const tail = left.split(/\b(?:the|your|our|a|an|after|before|until|when|once)\b/i).at(-1) ?? "";
    left = cleanTitlePart(tail).length >= 3 ? cleanTitlePart(tail) : "";
  }
  const right = cleanTitlePart(parts.slice(1).join(" ").replace(/^\s*(at|by|on|:)\s*/i, ""));
  if (left && right && left.toLowerCase() !== right.toLowerCase()) return `${left}: ${right}`;
  return left || right || fallback;
}

interface Candidate {
  title: string;
  date: LocalDate;
  time: LocalTime | null;
  timeZone: string | null;
  links: ItemLink[];
}

const DUE_WORD = /\bdue\b/i;
const BLOCK_SPLIT_ALL = /<\/?(?:div|li|p|br|ul|ol|dd|dt)\b[^>]*>/gi;

function rowCandidates(html: string, base: URL): Candidate[] {
  const out: Candidate[] = [];
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
    const cells = Array.from(row[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi)).map((m) => m[1]!);
    let rowDate: LocalDate | null = null;
    let dateCell = -1;
    for (let i = 0; i < cells.length; i++) {
      const text = textOf(cells[i]!);
      if (text.length > 0 && text.length <= 40) {
        const date = parseDate(text);
        if (date) {
          rowDate = date;
          dateCell = i;
          break;
        }
      }
    }
    if (!rowDate) continue;
    cells.forEach((cell, i) => {
      if (i === dateCell) return;
      for (const block of splitBlocks(cell)) {
        const text = textOf(block);
        if (!DUE_WORD.test(text)) continue;
        const own = parseDate(text);
        out.push({
          title: titleFromDueText(text),
          date: own ?? rowDate!,
          time: parseTime(text),
          timeZone: parseTimeZone(text),
          links: itemLinks(block, base),
        });
      }
    });
  }
  return out;
}

// Split a cell into items: one per block-level element (a schedule cell often
// holds several <div class="item">s).
function splitBlocks(cellHtml: string): string[] {
  return cellHtml.split(BLOCK_SPLIT_ALL).filter((piece) => textOf(piece).length > 0);
}

function lineCandidates(html: string, pageTitle: string): Candidate[] {
  const withoutTables = html.replace(/<table\b[\s\S]*?<\/table\s*>/gi, " ");
  const out: Candidate[] = [];
  for (const line of stripHtmlToText(withoutTables).split("\n")) {
    const text = collapse(line);
    if (text.length > 300 || !DUE_WORD.test(text)) continue;
    const date = parseDate(text);
    if (!date) continue;
    out.push({
      title: titleFromDueText(text, pageTitle),
      date,
      time: parseTime(text),
      timeZone: parseTimeZone(text),
      links: [],
    });
  }
  return out;
}

/** Assignments with due dates found on one page. */
export function extractAssignments(html: string, opts: ExtractOptions): SiteAssignment[] {
  const now = opts.now ?? new Date();
  const defaultZone = opts.timeZone ?? DEFAULT_TIME_ZONE;
  const defaultTime = opts.defaultTime ?? DEFAULT_DUE_TIME;
  const candidates = [
    ...rowCandidates(String(html ?? ""), opts.pageUrl),
    ...lineCandidates(String(html ?? ""), opts.pageTitle ?? ""),
  ];

  const byKey = new Map<string, SiteAssignment>();
  for (const candidate of candidates) {
    const title = candidate.title.slice(0, 200);
    const slug = slugify(title);
    if (!slug) continue;
    const year = resolveYear(candidate.date, now);
    const time = candidate.time ?? defaultTime;
    const timeZone = candidate.timeZone ?? defaultZone;
    const due = zonedTimeToUtc(year, candidate.date.month, candidate.date.day, time.hour, time.minute, timeZone);
    const offsetDays = (due.getTime() - now.getTime()) / DAY_MS;
    if (offsetDays < -PAST_WINDOW_DAYS || offsetDays > FUTURE_WINDOW_DAYS) continue;
    const key = `due:${slug}`;
    if (byKey.has(key)) continue; // first mention wins (schedule tables come first)
    byKey.set(key, {
      key,
      title,
      dueAt: due.toISOString(),
      timeZone,
      timeGiven: candidate.time !== null,
      links: candidate.links,
      pageUrl: opts.pageUrl.href,
    });
  }
  return Array.from(byKey.values());
}

/** "Friday, September 4, 2026 at 11:59 PM" in the assignment's own time zone. */
export function formatDue(assignment: Pick<SiteAssignment, "dueAt" | "timeZone">): string {
  const date = new Date(assignment.dueAt);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: assignment.timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: assignment.timeZone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
  return `${day} at ${time}`;
}

/** The stored copy of an assignment: what it is, when it's due, where its files are. */
export function assignmentDocument(assignment: SiteAssignment, courseName: string): string {
  const title = escapeHtml(assignment.title);
  const links = assignment.links
    .map((link) => {
      return `<li><a href="${escapeHtml(link.url)}">${escapeHtml(link.text || link.url)}</a></li>`;
    })
    .filter(Boolean)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>` +
    `<h1>${title}</h1>` +
    `<p>${escapeHtml(assignment.title)} for ${escapeHtml(courseName)} is due ${escapeHtml(formatDue(assignment))}.</p>` +
    (links ? `<p>Materials:</p><ul>${links}</ul>` : "") +
    `<p>From the course schedule: ${escapeHtml(assignment.pageUrl)}</p>` +
    `</body></html>`;
}
