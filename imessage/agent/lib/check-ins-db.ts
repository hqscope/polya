// Database side of the check-in loop. serviceDb() bypasses RLS, so every read of student data
// filters by that student's user_id. The one cross-student read is loadCheckInLinks, which is how
// the loop finds who to look at; it selects only the fields the loop needs (never the handle).
import { z } from "zod";

import { CHECK_IN_RULES, type CheckInAssignment, type CheckInKind, type CheckInLink, type SentCheckIn } from "./check-ins.ts";
import { serviceDb } from "./db.ts";

/** polya_imessage_check_ins.id (bigint identity). */
export type CheckInClaimId = number | string;

export interface StudentCheckInData {
  readonly assignments: readonly CheckInAssignment[];
  readonly sent: readonly SentCheckIn[];
}

const PAGE_SIZE = 1000;
const MAX_ASSIGNMENTS_PER_STUDENT = 50;
// A local calendar day lasts at most 25 hours (DST fall-back), so 26 hours of history always
// covers "check-ins sent today" in any time zone.
const SENT_TODAY_LOOKBACK_MS = 26 * 60 * 60 * 1000;
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

const linkRow = z.object({
  user_id: z.string(),
  thread_id: z.string().nullable(),
  timezone: z.string(),
  check_ins_enabled: z.boolean(),
  quiet_start: z.number(),
  quiet_end: z.number(),
});

const sourceRow = z.object({
  id: z.string(),
  user_id: z.string(),
  course_id: z.string(),
  title: z.string(),
  due_at: z.string().nullable(),
});

const courseRow = z.object({
  id: z.string(),
  name: z.string().nullable(),
  code: z.string().nullable(),
});

const claimId = z.union([z.number(), z.string()]);

const sentRow = z.object({
  id: claimId,
  source_id: z.string(),
  kind: z.string(),
  sent_at: z.string(),
});

/** Linked students who have check-ins on and a thread to text. */
export async function loadCheckInLinks(): Promise<CheckInLink[]> {
  const links: CheckInLink[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await serviceDb()
      .from("polya_imessage_links")
      .select("user_id, thread_id, timezone, check_ins_enabled, quiet_start, quiet_end")
      .eq("check_ins_enabled", true)
      .not("thread_id", "is", null)
      .order("user_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Couldn't load iMessage links: ${error.message}`);

    const rows = data ?? [];
    for (const raw of rows) {
      const row = linkRow.safeParse(raw);
      if (!row.success) continue;
      links.push({
        userId: row.data.user_id,
        threadId: row.data.thread_id,
        timezone: row.data.timezone,
        checkInsEnabled: row.data.check_ins_enabled,
        quietStart: row.data.quiet_start,
        quietEnd: row.data.quiet_end,
      });
    }
    if (rows.length < PAGE_SIZE) return links;
  }
}

/**
 * One student's Canvas assignments due in the next 48 hours, plus the check-in rows needed to
 * dedupe them (every earlier send for those assignments) and to apply the daily cap (every send
 * in the last 26 hours). Returns nothing to send when there are no upcoming assignments.
 */
export async function loadStudentCheckInData(userId: string, now: Date): Promise<StudentCheckInData> {
  const db = serviceDb();
  const sources = await db
    .from("polya_sources")
    .select("id, user_id, course_id, title, due_at")
    .eq("user_id", userId)
    .eq("origin", "canvas_assignment")
    .gt("due_at", now.toISOString())
    .lte("due_at", new Date(now.getTime() + CHECK_IN_RULES.dueSoonMaxMs).toISOString())
    .order("due_at", { ascending: true })
    .limit(MAX_ASSIGNMENTS_PER_STUDENT);
  if (sources.error) throw new Error(`Couldn't load assignments: ${sources.error.message}`);

  const rows = parseRows(sourceRow, sources.data).filter((row) => row.user_id === userId);
  if (rows.length === 0) return { assignments: [], sent: [] };

  const sourceIds = rows.map((row) => row.id);
  const courseIds = [...new Set(rows.map((row) => row.course_id))];
  const [courses, sentForSources, sentRecently] = await Promise.all([
    db.from("polya_courses").select("id, name, code").eq("user_id", userId).in("id", courseIds),
    db
      .from("polya_imessage_check_ins")
      .select("id, source_id, kind, sent_at")
      .eq("user_id", userId)
      .in("source_id", sourceIds),
    db
      .from("polya_imessage_check_ins")
      .select("id, source_id, kind, sent_at")
      .eq("user_id", userId)
      .gte("sent_at", new Date(now.getTime() - SENT_TODAY_LOOKBACK_MS).toISOString()),
  ]);
  if (courses.error) throw new Error(`Couldn't load courses: ${courses.error.message}`);
  if (sentForSources.error) throw new Error(`Couldn't load sent check-ins: ${sentForSources.error.message}`);
  if (sentRecently.error) throw new Error(`Couldn't load sent check-ins: ${sentRecently.error.message}`);

  const courseNames = new Map(
    parseRows(courseRow, courses.data).map((course) => [course.id, course.name || course.code || null]),
  );
  // The two check-in reads overlap; key by row id so the daily count sees each send once.
  const sentById = new Map<string, z.infer<typeof sentRow>>();
  for (const row of [...parseRows(sentRow, sentForSources.data), ...parseRows(sentRow, sentRecently.data)]) {
    sentById.set(String(row.id), row);
  }

  return {
    assignments: rows.map((row) => ({
      sourceId: row.id,
      userId,
      courseName: courseNames.get(row.course_id) ?? null,
      title: row.title,
      dueAt: row.due_at,
    })),
    sent: [...sentById.values()].map((row) => ({
      userId,
      sourceId: row.source_id,
      kind: row.kind,
      sentAt: row.sent_at,
    })),
  };
}

/**
 * Records a check-in before it's sent. Returns the new row id when this run won the
 * (user_id, source_id, kind) unique constraint, or null when another run already claimed it
 * (or the assignment was deleted meanwhile). Only a winner may send.
 */
export async function claimCheckIn(userId: string, sourceId: string, kind: CheckInKind): Promise<CheckInClaimId | null> {
  const { data, error } = await serviceDb()
    .from("polya_imessage_check_ins")
    .insert({ user_id: userId, source_id: sourceId, kind })
    .select("id")
    .single();
  if (error) {
    if (error.code === UNIQUE_VIOLATION || error.code === FOREIGN_KEY_VIOLATION) return null;
    throw new Error(`Couldn't record check-in: ${error.message}`);
  }
  const row = z.object({ id: claimId }).safeParse(data);
  if (!row.success) throw new Error("Couldn't record check-in: the insert returned no id");
  return row.data.id;
}

/** Deletes claims whose message failed to send, so a later run can try again. */
export async function releaseCheckIns(userId: string, ids: readonly CheckInClaimId[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await serviceDb()
    .from("polya_imessage_check_ins")
    .delete()
    .eq("user_id", userId)
    .in("id", ids.map(String));
  if (error) throw new Error(`Couldn't release check-in claims: ${error.message}`);
}

function parseRows<T>(schema: z.ZodType<T>, data: unknown): T[] {
  if (!Array.isArray(data)) return [];
  const rows: T[] = [];
  for (const raw of data) {
    const row = schema.safeParse(raw);
    if (row.success) rows.push(row.data);
  }
  return rows;
}
