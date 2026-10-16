// Decides which assignment check-ins to text right now. Pure: no I/O and no clock reads. The
// caller passes `now`, the linked students, their upcoming assignments, and the check-ins already
// recorded in polya_imessage_check_ins. Everything time-of-day related is evaluated in the
// student's own time zone with Intl, so "today" and quiet hours mean what the student expects.
//
// Check-ins help a student plan and start. They never do the work: the message is a list of facts
// that the agent turns into one or two sentences (see agent/instructions/check-ins.md).

export type CheckInKind = "due_today" | "due_soon";

/** One row of polya_imessage_links, reduced to what the loop needs. */
export interface CheckInLink {
  readonly userId: string;
  readonly threadId: string | null;
  readonly timezone: string;
  readonly checkInsEnabled: boolean;
  /** Local hour (0-23). Check-ins are never sent from quietStart up to, not including, quietEnd. */
  readonly quietStart: number;
  readonly quietEnd: number;
}

/** A polya_sources row with origin 'canvas_assignment', joined to its course name. */
export interface CheckInAssignment {
  readonly sourceId: string;
  readonly userId: string;
  readonly courseName: string | null;
  readonly title: string;
  /** ISO timestamp, or null when Canvas has no due date. */
  readonly dueAt: string | null;
  /** Submission fact for the hand-off, e.g. "not submitted on Gradescope" (reminders.ts). */
  readonly status?: string;
  /** `canvas:<source id>` or `gs:<course>:<assignment>`, for mark_assignment_done. */
  readonly itemKey?: string;
}

/** A polya_imessage_check_ins row. `kind` may be one this loop doesn't send (new_assignment). */
export interface SentCheckIn {
  readonly userId: string;
  readonly sourceId: string;
  readonly kind: string;
  readonly sentAt: string;
}

export interface CheckInItem {
  readonly sourceId: string;
  readonly kind: CheckInKind;
  readonly courseName: string | null;
  readonly title: string;
  readonly dueAt: Date;
  readonly status?: string;
  readonly itemKey?: string;
}

/** One message to one student: up to two assignments, earliest due first. */
export interface PlannedCheckIn {
  readonly userId: string;
  readonly threadId: string;
  /** The resolved IANA time zone used for every local-time decision and for the message. */
  readonly timezone: string;
  readonly items: readonly CheckInItem[];
  readonly message: string;
}

export interface SelectCheckInsInput {
  readonly links: readonly CheckInLink[];
  readonly assignments: readonly CheckInAssignment[];
  readonly sent: readonly SentCheckIn[];
  readonly now: Date;
}

const HOUR_MS = 60 * 60 * 1000;

export const CHECK_IN_RULES = {
  /** Assignments per message, which is also the most one run sends a student. */
  maxPerRun: 2,
  /** Assignments per student per local calendar day, across runs. */
  maxPerLocalDay: 3,
  /** due_today only fires while the deadline is more than this far away. */
  dueTodayMinLeadMs: 2 * HOUR_MS,
  /** due_soon fires while the deadline is between these two distances (inclusive). */
  dueSoonMinMs: 24 * HOUR_MS,
  dueSoonMaxMs: 48 * HOUR_MS,
} as const;

export const CHECK_IN_PREFIX = "[polya check-in]";
export const DEFAULT_TIME_ZONE = "America/Los_Angeles";
const DEFAULT_QUIET_START = 22;
const DEFAULT_QUIET_END = 8;
const MAX_FIELD_LENGTH = 120;

/** Selects the check-ins to send now: at most one message per student. */
export function selectCheckIns({ links, assignments, sent, now }: SelectCheckInsInput): PlannedCheckIn[] {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return [];

  const plans: PlannedCheckIn[] = [];
  for (const link of links) {
    if (!link.checkInsEnabled || !link.threadId) continue;

    const timezone = resolveTimeZone(link.timezone);
    const local = localClock(now, timezone);
    if (isQuietHour(local.hour, link.quietStart, link.quietEnd)) continue;

    const sentForStudent = sent.filter((row) => row.userId === link.userId);
    const sentToday = sentForStudent.filter((row) => {
      const at = new Date(row.sentAt);
      return Number.isFinite(at.getTime()) && localClock(at, timezone).day === local.day;
    }).length;
    const budget = Math.min(CHECK_IN_RULES.maxPerRun, CHECK_IN_RULES.maxPerLocalDay - sentToday);
    if (budget <= 0) continue;

    const alreadySent = new Set(sentForStudent.map((row) => sentKey(row.sourceId, row.kind)));
    const seen = new Set<string>();
    const candidates: CheckInItem[] = [];
    for (const assignment of assignments) {
      if (assignment.userId !== link.userId || seen.has(assignment.sourceId)) continue;
      if (assignment.dueAt === null) continue;
      const dueAt = new Date(assignment.dueAt);
      const kind = classifyDue(dueAt, now, timezone);
      if (!kind || alreadySent.has(sentKey(assignment.sourceId, kind))) continue;
      seen.add(assignment.sourceId);
      candidates.push({
        sourceId: assignment.sourceId,
        kind,
        courseName: assignment.courseName,
        title: assignment.title,
        dueAt,
        ...(assignment.status ? { status: assignment.status } : {}),
        ...(assignment.itemKey ? { itemKey: assignment.itemKey } : {}),
      });
    }
    candidates.sort(
      (a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.sourceId.localeCompare(b.sourceId),
    );

    const items = candidates.slice(0, budget);
    if (items.length === 0) continue;
    plans.push({
      userId: link.userId,
      threadId: link.threadId,
      timezone,
      items,
      message: formatCheckInMessage(items, timezone, now),
    });
  }
  return plans;
}

/**
 * The check-in kind an assignment qualifies for at `now`, or null. due_today: due later in the
 * student's current local day and more than ~2h away. due_soon: due 24 to 48 hours from now.
 * The two windows never overlap, because the local day always ends less than 24h ahead.
 */
export function classifyDue(dueAt: Date, now: Date, timezone: string): CheckInKind | null {
  const lead = dueAt.getTime() - now.getTime();
  if (!Number.isFinite(lead) || lead <= 0) return null;
  if (lead >= CHECK_IN_RULES.dueSoonMinMs && lead <= CHECK_IN_RULES.dueSoonMaxMs) return "due_soon";
  const zone = resolveTimeZone(timezone);
  if (lead > CHECK_IN_RULES.dueTodayMinLeadMs && localClock(dueAt, zone).day === localClock(now, zone).day) {
    return "due_today";
  }
  return null;
}

/**
 * True when `hour` falls in [start, end), wrapping past midnight when start > end
 * (22 -> 8 covers 22:00 to 07:59). Equal start and end means no quiet hours.
 * Out-of-range values fall back to the table defaults (22 and 8).
 */
export function isQuietHour(hour: number, start: number, end: number): boolean {
  const from = validHour(start) ? start : DEFAULT_QUIET_START;
  const to = validHour(end) ? end : DEFAULT_QUIET_END;
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/**
 * The hand-off message: the prefix line, then one block of plain facts per assignment.
 * Course and assignment names come from Canvas, so they're flattened to one line and capped.
 */
export function formatCheckInMessage(items: readonly CheckInItem[], timezone: string, now: Date): string {
  const zone = resolveTimeZone(timezone);
  const blocks = items.map((item) => {
    const lines = [`assignment: ${cleanText(item.title) || "Untitled assignment"}`];
    const course = item.courseName ? cleanText(item.courseName) : "";
    if (course) lines.push(`course: ${course}`);
    lines.push(`due: ${describeDue(item.dueAt, now, zone)}`);
    if (item.status) lines.push(`status: ${cleanText(item.status)}`);
    if (item.itemKey) lines.push(`item_key: ${cleanText(item.itemKey)}`);
    return lines.join("\n");
  });
  return [CHECK_IN_PREFIX, ...blocks].join("\n\n");
}

/** "today at 11:59 PM PDT (Thu, Oct 15)", "tomorrow at ...", or "Sat, Oct 17 at 9:00 AM PDT". */
export function describeDue(dueAt: Date, now: Date, timezone: string): string {
  const zone = resolveTimeZone(timezone);
  const time = plain(formatter(zone, "time").format(dueAt));
  const date = plain(formatter(zone, "date").format(dueAt));
  const daysAway = localClock(dueAt, zone).day - localClock(now, zone).day;
  if (daysAway === 0) return `today at ${time} (${date})`;
  if (daysAway === 1) return `tomorrow at ${time} (${date})`;
  return `${date} at ${time}`;
}

/** The IANA zone when Intl accepts it, otherwise the table default. */
export function resolveTimeZone(timezone: string): string {
  try {
    return formatter(timezone, "clock").resolvedOptions().timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

interface LocalClock {
  /** Days since 1970-01-01 for the local calendar date: comparable across days and months. */
  readonly day: number;
  readonly hour: number;
}

function localClock(date: Date, timezone: string): LocalClock {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of formatter(timezone, "clock").formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const { year = 1970, month = 1, day = 1, hour = 0 } = parts;
  return { day: Date.UTC(year, month - 1, day) / (24 * HOUR_MS), hour: hour % 24 };
}

type FormatterKind = "clock" | "time" | "date";
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string, kind: FormatterKind): Intl.DateTimeFormat {
  const key = `${kind}|${timezone}`;
  let cached = formatters.get(key);
  if (!cached) {
    const options: Record<FormatterKind, Intl.DateTimeFormatOptions> = {
      clock: { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hourCycle: "h23" },
      time: { hour: "numeric", minute: "2-digit", timeZoneName: "short" },
      date: { weekday: "short", month: "short", day: "numeric" },
    };
    cached = new Intl.DateTimeFormat("en-US", { ...options[kind], timeZone: timezone });
    formatters.set(key, cached);
  }
  return cached;
}

function sentKey(sourceId: string, kind: string): string {
  return `${sourceId}|${kind}`;
}

function validHour(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 23;
}

/** Intl may use narrow no-break spaces ("11:59\u202fPM"); keep the message plain ASCII spacing. */
function plain(value: string): string {
  return value.replace(/\s+/gu, " ");
}

function cleanText(value: string): string {
  const flat = value.replace(/[\p{Cc}\u2028\u2029]+/gu, " ").replace(/\s+/gu, " ").trim();
  return flat.length > MAX_FIELD_LENGTH ? `${flat.slice(0, MAX_FIELD_LENGTH - 1).trimEnd()}…` : flat;
}
