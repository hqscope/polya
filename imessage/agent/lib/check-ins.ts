// Decides which assignment check-ins to text right now. Pure: no I/O and no clock reads. The
// caller passes `now`, the linked students, their upcoming assignments, and the check-ins already
// recorded in polya_imessage_check_ins. Everything time-of-day related is evaluated in the
// student's own time zone with Intl, so "today" and quiet hours mean what the student expects.
//
// Check-ins help a student plan and start. They never do the work: the message is a list of facts
// that the agent turns into one or two sentences (see agent/instructions/check-ins.md).
//
// Kinds, most urgent first: last_call (due within 6 hours), due_today, due_soon (24 to 48 hours
// out), new_assignment (just posted, due more than 48 hours out), graded (a Gradescope score came
// back). The last three were added after polya_imessage_reminders; until the database accepts them
// a claim throws CheckInKindUnavailableError and the run selects again without them.

export type CheckInKind = "due_today" | "due_soon" | "last_call" | "graded" | "new_assignment";

/** Thrown by a claim when the database doesn't accept this kind yet (its check constraint, 23514). */
export class CheckInKindUnavailableError extends Error {
  readonly kind: CheckInKind;
  constructor(kind: CheckInKind) {
    super(`The database doesn't accept ${kind} check-ins yet`);
    this.name = "CheckInKindUnavailableError";
    this.kind = kind;
  }
}

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
  /**
   * Score as Gradescope shows it ("8.0 / 10.0"). Set only on a graded entry, which can only get a
   * `graded` check-in (reminders.ts adds one per graded Gradescope assignment).
   */
  readonly score?: string;
  /** Just posted (reminders.ts decides): it gets `new_assignment` while due more than 48 hours out. */
  readonly isNew?: boolean;
}

/** A sent row from polya_imessage_reminders or polya_imessage_check_ins. */
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
  readonly score?: string;
}

/** One message to one student: up to two assignments, most urgent kind first (compareCheckInItems). */
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
  /** Kinds the database doesn't accept yet: never selected. last_call falls back to due_today. */
  readonly unavailableKinds?: ReadonlySet<CheckInKind>;
}

const HOUR_MS = 60 * 60 * 1000;

export const CHECK_IN_RULES = {
  /** Assignments per message, which is also the most one run sends a student. */
  maxPerRun: 2,
  /** Assignments per student per local calendar day, across runs and kinds. */
  maxPerLocalDay: 4,
  /** last_call fires while the deadline is at most lastCallMaxLeadMs and at least lastCallMinLeadMs away. */
  lastCallMaxLeadMs: 6 * HOUR_MS,
  lastCallMinLeadMs: 30 * 60 * 1000,
  /**
   * due_today fires while the deadline is more than this far away and still today. With last_call
   * available, due_today stops where last_call starts (6 hours) instead.
   */
  dueTodayMinLeadMs: 2 * HOUR_MS,
  /** due_soon fires while the deadline is between these two distances (inclusive). */
  dueSoonMinMs: 24 * HOUR_MS,
  dueSoonMaxMs: 48 * HOUR_MS,
  /** new_assignment fires only while the deadline is more than this far away. */
  newAssignmentMinLeadMs: 48 * HOUR_MS,
  /** Two check-ins about the same assignment are at least this far apart; the later kind waits. */
  sameItemGapMs: 6 * HOUR_MS,
} as const;

/** Which candidates fill a message first when the budget is short. Ties go to the earliest due. */
const KIND_PRIORITY: Readonly<Record<CheckInKind, number>> = {
  last_call: 0,
  due_today: 1,
  due_soon: 2,
  new_assignment: 3,
  graded: 4,
};

/** The `type:` line of each block in the hand-off message. */
const KIND_LABEL: Readonly<Record<CheckInKind, string>> = {
  last_call: "last call",
  due_today: "due today",
  due_soon: "due soon",
  new_assignment: "new assignment",
  graded: "graded",
};

const NO_KINDS: ReadonlySet<CheckInKind> = new Set();

export const CHECK_IN_PREFIX = "[polya check-in]";
export const DEFAULT_TIME_ZONE = "America/Los_Angeles";
const DEFAULT_QUIET_START = 22;
const DEFAULT_QUIET_END = 8;
const MAX_FIELD_LENGTH = 120;

/** Selects the check-ins to send now: at most one message per student. */
export function selectCheckIns({
  links,
  assignments,
  sent,
  now,
  unavailableKinds = NO_KINDS,
}: SelectCheckInsInput): PlannedCheckIn[] {
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
    const lastSentMs = new Map<string, number>();
    for (const row of sentForStudent) {
      const at = Date.parse(row.sentAt);
      if (Number.isFinite(at) && at > (lastSentMs.get(row.sourceId) ?? -Infinity)) lastSentMs.set(row.sourceId, at);
    }
    const seen = new Set<string>();
    const candidates: CheckInItem[] = [];
    for (const assignment of assignments) {
      if (assignment.userId !== link.userId || seen.has(assignment.sourceId)) continue;
      if (assignment.dueAt === null) continue;
      const dueAt = new Date(assignment.dueAt);
      const kind = classifyAssignment(assignment, dueAt, now, timezone, unavailableKinds);
      if (!kind || alreadySent.has(sentKey(assignment.sourceId, kind))) continue;
      // A check-in about this same assignment went out within the last few hours: wait.
      if (nowMs - (lastSentMs.get(assignment.sourceId) ?? -Infinity) < CHECK_IN_RULES.sameItemGapMs) continue;
      seen.add(assignment.sourceId);
      candidates.push({
        sourceId: assignment.sourceId,
        kind,
        courseName: assignment.courseName,
        title: assignment.title,
        dueAt,
        ...(assignment.status ? { status: assignment.status } : {}),
        ...(assignment.itemKey ? { itemKey: assignment.itemKey } : {}),
        ...(kind === "graded" && assignment.score ? { score: assignment.score } : {}),
      });
    }
    candidates.sort(compareCheckInItems);

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

/** Message order, which is also who goes first when the budget is short: most urgent kind, then earliest due. */
export function compareCheckInItems(a: CheckInItem, b: CheckInItem): number {
  return (
    KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] ||
    a.dueAt.getTime() - b.dueAt.getTime() ||
    a.sourceId.localeCompare(b.sourceId)
  );
}

/**
 * The deadline kind an assignment qualifies for at `now`, or null. last_call: due in 30 minutes to
 * 6 hours. due_today: due later in the student's current local day and more than 6 hours away
 * (more than 2 hours when last_call is unavailable). due_soon: due 24 to 48 hours from now. The
 * windows never overlap: the local day always ends less than 24 hours ahead (25 on a DST day,
 * where due_soon is checked first).
 */
export function classifyDue(
  dueAt: Date,
  now: Date,
  timezone: string,
  unavailable: ReadonlySet<CheckInKind> = NO_KINDS,
): CheckInKind | null {
  const lead = dueAt.getTime() - now.getTime();
  if (!Number.isFinite(lead) || lead <= 0) return null;
  const lastCall = !unavailable.has("last_call");
  if (lastCall && lead <= CHECK_IN_RULES.lastCallMaxLeadMs) {
    return lead >= CHECK_IN_RULES.lastCallMinLeadMs ? "last_call" : null;
  }
  if (lead >= CHECK_IN_RULES.dueSoonMinMs && lead <= CHECK_IN_RULES.dueSoonMaxMs) {
    return unavailable.has("due_soon") ? null : "due_soon";
  }
  const zone = resolveTimeZone(timezone);
  const minLead = lastCall ? CHECK_IN_RULES.lastCallMaxLeadMs : CHECK_IN_RULES.dueTodayMinLeadMs;
  if (lead > minLead && !unavailable.has("due_today") && localClock(dueAt, zone).day === localClock(now, zone).day) {
    return "due_today";
  }
  return null;
}

/** The kind one candidate qualifies for: graded entries only get `graded`; the rest go by due date. */
function classifyAssignment(
  assignment: CheckInAssignment,
  dueAt: Date,
  now: Date,
  timezone: string,
  unavailable: ReadonlySet<CheckInKind>,
): CheckInKind | null {
  if (assignment.score !== undefined) return assignment.score && !unavailable.has("graded") ? "graded" : null;
  const kind = classifyDue(dueAt, now, timezone, unavailable);
  if (kind) return kind;
  const lead = dueAt.getTime() - now.getTime();
  if (assignment.isNew && lead > CHECK_IN_RULES.newAssignmentMinLeadMs && !unavailable.has("new_assignment")) {
    return "new_assignment";
  }
  return null;
}

/** True when it's the student's quiet hours right now, in their own time zone. */
export function inQuietHours(link: Pick<CheckInLink, "timezone" | "quietStart" | "quietEnd">, now: Date): boolean {
  return isQuietHour(localClock(now, resolveTimeZone(link.timezone)).hour, link.quietStart, link.quietEnd);
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
 * The hand-off message: the prefix line, then one block of plain facts per assignment, led by its
 * `type:`. A graded block carries the score instead of a due date; a new-assignment block leaves
 * out the submission status; a last-call block adds the time left. Course and assignment names come
 * from Canvas and Gradescope, so they're flattened to one line and capped.
 */
export function formatCheckInMessage(items: readonly CheckInItem[], timezone: string, now: Date): string {
  const zone = resolveTimeZone(timezone);
  const blocks = items.map((item) => {
    const lines = [`type: ${KIND_LABEL[item.kind]}`, `assignment: ${cleanText(item.title) || "Untitled assignment"}`];
    const course = item.courseName ? cleanText(item.courseName) : "";
    if (course) lines.push(`course: ${course}`);
    if (item.kind === "graded") {
      if (item.score) lines.push(`score: ${cleanText(item.score)}`);
    } else {
      lines.push(`due: ${describeDue(item.dueAt, now, zone)}`);
      if (item.kind === "last_call") lines.push(`time left: ${describeTimeLeft(item.dueAt, now)}`);
      if (item.status && item.kind !== "new_assignment") lines.push(`status: ${cleanText(item.status)}`);
    }
    if (item.itemKey) lines.push(`item_key: ${cleanText(item.itemKey)}`);
    return lines.join("\n");
  });
  return [CHECK_IN_PREFIX, ...blocks].join("\n\n");
}

/** "about 45 minutes" under an hour and a half, else "about 5 hours". */
export function describeTimeLeft(dueAt: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((dueAt.getTime() - now.getTime()) / 60_000));
  if (minutes < 90) return `about ${Math.max(5, Math.round(minutes / 5) * 5)} minutes`;
  return `about ${Math.round(minutes / 60)} hours`;
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
