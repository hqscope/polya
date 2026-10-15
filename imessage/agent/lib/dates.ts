// Dates in the student's own timezone, worded for a text message. Pure (tests import it).

/** True for an IANA timezone name the runtime knows, such as "America/New_York". */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The timezone to use, falling back when the stored one is missing or unknown. */
export function safeTimeZone(timeZone: string | null | undefined, fallback = "America/Los_Angeles"): string {
  return timeZone && isValidTimeZone(timeZone) ? timeZone : fallback;
}

/** Calendar date (YYYY-MM-DD) of an instant in a timezone. */
export function localDateKey(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Whole calendar days from `now` to `then` in the timezone (0 = same day, 1 = tomorrow). */
export function calendarDaysBetween(now: Date, then: Date, timeZone: string): number {
  const a = Date.parse(`${localDateKey(now, timeZone)}T00:00:00Z`);
  const b = Date.parse(`${localDateKey(then, timeZone)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** "Thu, Oct 16, 11:59 PM" in the student's timezone. */
export function formatLocalDateTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(instant);
}

function formatLocalTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(instant);
}

function formatLocalWeekday(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(instant);
}

/**
 * A due time as a student would say it: "today at 11:59 PM", "tomorrow at 9:00 AM",
 * "Friday at 5:00 PM" (within a week), else "Thu, Oct 30, 11:59 PM".
 */
export function describeDue(due: Date, now: Date, timeZone: string): string {
  const days = calendarDaysBetween(now, due, timeZone);
  if (days === 0) return `today at ${formatLocalTime(due, timeZone)}`;
  if (days === 1) return `tomorrow at ${formatLocalTime(due, timeZone)}`;
  if (days > 1 && days < 7) return `${formatLocalWeekday(due, timeZone)} at ${formatLocalTime(due, timeZone)}`;
  return formatLocalDateTime(due, timeZone);
}

/** One context line for the model so "tonight" and "this week" mean the student's own clock. */
export function localTimeContext(now: Date, timeZone: string): string {
  const stamp = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(now);
  return `The student's local time is ${stamp} (${timeZone}).`;
}

/** Whole hours (rounded up) until the next UTC midnight, when daily usage counters reset. */
export function hoursUntilUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 3_600_000));
}
