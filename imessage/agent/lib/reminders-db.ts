// Database side of submission-aware reminders, shared by the check-in loop and the tools that
// list, mark, or snooze assignments. serviceDb() bypasses RLS, so every query filters by the
// student's user_id, which comes from the session's auth (tools) or the link row (the loop),
// never from the model.
//
// Until the reminders migration is applied, the loop falls back to the polya_imessage_check_ins
// path (Canvas only) and marks are treated as absent, so production keeps working. Until the
// reminder-kinds migration is applied, the Gradescope baseline can't be written, so graded and
// new-on-Gradescope check-ins stay off (claims of the other new kinds are skipped by the runner).
import { z } from "zod";

import { CHECK_IN_RULES, type CheckInAssignment, type SentCheckIn } from "./check-ins.ts";
import {
  chunks,
  hasGradescopeBaseline,
  loadLegacySends,
  loadReminderSends,
  parseRows,
  writeGradescopeBaseline,
} from "./check-ins-db.ts";
import { serviceDb } from "./db.ts";
import { listGradescopeAssignments } from "./gradescope/store.ts";
import type { GsAssignment } from "./gradescope/types.ts";
import { isMissingTableError } from "./notes.ts";
import { needsGradescopeReconnect } from "./reconnect.ts";
import {
  BASELINE_SENT_AT,
  canvasItemKey,
  coursesMatch,
  gradescopeBaseline,
  gradescopeItemKey,
  hasScore,
  mergeAssignments,
  NEW_ASSIGNMENT_RULES,
  pickAssignment,
  prepareCheckIns,
  type AssignmentMark,
  type AssignmentPick,
  type CanvasAssignmentInput,
  type MarkStatus,
  type ReminderItem,
} from "./reminders.ts";

const MARKS_TABLE = "polya_imessage_assignment_marks";
const MAX_CANVAS_ROWS = 50;
/** Gradescope is read live (cached 10 minutes); a slow read shouldn't stall the loop. */
const GRADESCOPE_TIMEOUT_MS = 15_000;

/**
 * "error": connected, but it couldn't be read this time. "needs_reconnect": the sign-in stopped
 * working (expired session, rejected password, or school sign-in now required); only the student
 * can fix it.
 */
export type GradescopeState = "connected" | "not_connected" | "needs_reconnect" | "error";

export interface StudentAssignments {
  /** Merged Canvas and Gradescope items due in the window, soonest first. */
  readonly items: ReminderItem[];
  readonly gradescope: GradescopeState;
}

const SOURCE_COLUMNS = "id, user_id, course_id, title, due_at, created_at";

const sourceRow = z.object({
  id: z.string(),
  user_id: z.string(),
  course_id: z.string(),
  title: z.string(),
  due_at: z.string().nullable(),
  created_at: z.string().nullable().optional(),
});

const courseRow = z.object({
  id: z.string(),
  name: z.string().nullable(),
  code: z.string().nullable(),
  created_at: z.string().nullable().optional(),
});

type SourceRow = z.infer<typeof sourceRow>;
type CourseRow = z.infer<typeof courseRow>;

const markRow = z.object({
  item_key: z.string(),
  status: z.enum(["done", "snoozed"]),
  until: z.string().nullable(),
});

/**
 * One student's assignments due in (from, until]: Canvas assignments merged with Gradescope's
 * (when connected). With `courseId`, only that Polya course and the Gradescope course matching it.
 */
export async function loadStudentAssignments(
  userId: string,
  from: Date,
  until: Date,
  options: { readonly courseId?: string } = {},
): Promise<StudentAssignments> {
  let query = canvasAssignments(userId)
    .gt("due_at", from.toISOString())
    .lte("due_at", until.toISOString())
    .order("due_at", { ascending: true })
    .limit(MAX_CANVAS_ROWS);
  if (options.courseId) query = query.eq("course_id", options.courseId);
  const [sources, gradescope] = await Promise.all([query, readGradescope(userId)]);
  if (sources.error) throw new Error(`Couldn't load assignments: ${sources.error.message}`);
  const rows = parseRows(sourceRow, sources.data).filter((row) => row.user_id === userId);
  const courses = await loadCourses(userId, [...rows.map((row) => row.course_id), ...(options.courseId ? [options.courseId] : [])]);
  const canvas = toCanvasInputs(userId, rows, courses);

  let gsRows = gradescope.assignments ?? [];
  if (options.courseId) {
    const course = courses.get(options.courseId);
    gsRows = course ? gsRows.filter((gs) => coursesMatch([course.name, course.code], gs.course_name)) : [];
  }

  // Merge against every Gradescope assignment (its due date can differ a little from Canvas's),
  // then keep the window.
  const fromMs = from.getTime();
  const untilMs = until.getTime();
  const items = mergeAssignments(userId, canvas, gsRows)
    .filter((item) => {
      const due = dueMs(item);
      return Number.isFinite(due) && due > fromMs && due <= untilMs;
    })
    .sort((a, b) => dueMs(a) - dueMs(b) || a.itemKey.localeCompare(b.itemKey));
  return { items, gradescope: gradescope.state };
}

/**
 * The check-in loop's per-student read, minus submitted, done and snoozed assignments, plus the
 * earlier sends needed for dedupe, the gap between check-ins, and the daily cap:
 * - Canvas assignments due in the next 48 hours (due_soon, due_today, last_call);
 * - Canvas assignments Polya stored in the last 24 hours and due later than that (new_assignment);
 * - every Gradescope assignment it can read (due reminders, new_assignment, graded).
 * Uses polya_imessage_reminders when it exists, else the legacy polya_imessage_check_ins path. On
 * the student's first run with Gradescope it records their baseline before selecting anything.
 */
export async function loadStudentReminderData(
  userId: string,
  now: Date,
): Promise<{ assignments: CheckInAssignment[]; sent: SentCheckIn[] }> {
  const soonUntil = new Date(now.getTime() + CHECK_IN_RULES.dueSoonMaxMs).toISOString();
  const [dueSoon, recent, gradescope] = await Promise.all([
    canvasAssignments(userId).gt("due_at", now.toISOString()).lte("due_at", soonUntil).order("due_at", { ascending: true }).limit(MAX_CANVAS_ROWS),
    canvasAssignments(userId)
      .gt("created_at", new Date(now.getTime() - NEW_ASSIGNMENT_RULES.recentMs).toISOString())
      .gt("due_at", soonUntil)
      .order("due_at", { ascending: true })
      .limit(MAX_CANVAS_ROWS),
    readGradescope(userId),
  ]);
  if (dueSoon.error) throw new Error(`Couldn't load assignments: ${dueSoon.error.message}`);
  if (recent.error) throw new Error(`Couldn't load new assignments: ${recent.error.message}`);
  const rows = new Map<string, SourceRow>();
  for (const row of [...parseRows(sourceRow, dueSoon.data), ...parseRows(sourceRow, recent.data)]) {
    if (row.user_id === userId) rows.set(row.id, row);
  }
  const courses = await loadCourses(userId, [...rows.values()].map((row) => row.course_id));
  const canvas = toCanvasInputs(userId, [...rows.values()], courses);

  // Gradescope's own window (14 days back, 60 ahead): past-due ones only matter for grades.
  const gsAll = gradescope.assignments ?? [];
  const items = mergeAssignments(userId, canvas, gsAll).filter((item) => dueMs(item) > now.getTime());
  const keys = [...new Set([...items.flatMap((item) => item.keys), ...gsAll.filter(hasScore).map(gradescopeItemKey)])];
  if (keys.length === 0) return { assignments: [], sent: [] };

  const canvasIds = items.flatMap((item) => (item.canvasSourceId ? [item.canvasSourceId] : []));
  const [marks, reminderSends, legacySends] = await Promise.all([
    loadMarks(userId, keys),
    loadReminderSends(userId, keys, now),
    loadLegacySends(userId, canvasIds, now),
  ]);

  if (reminderSends === null) {
    return prepareCheckIns({ userId, mode: "legacy", items, marks: marks ?? [], sent: legacySends, now });
  }
  // Sends recorded before the migration still count, under their Canvas item key.
  const sent = [...reminderSends, ...legacySends.map((row) => ({ ...row, sourceId: canvasItemKey(row.sourceId) }))];
  const baseline = gradescope.state === "connected" && gsAll.length > 0 ? await ensureGradescopeBaseline(userId, gsAll) : null;
  return prepareCheckIns({
    userId,
    mode: "reminders",
    items,
    // Graded and new-on-Gradescope check-ins only run once the baseline is recorded.
    gradescope: baseline === null ? null : gsAll,
    marks: marks ?? [],
    sent: [...sent, ...(baseline ?? [])],
    now,
  });
}

/**
 * Makes sure the student's Gradescope baseline is recorded. Returns the rows written now (as sends
 * dated BASELINE_SENT_AT, so this run sees them), [] when it already was, or null when it can't be
 * written yet (the reminder-kinds migration isn't applied).
 */
async function ensureGradescopeBaseline(userId: string, gradescope: readonly GsAssignment[]): Promise<SentCheckIn[] | null> {
  const recorded = await hasGradescopeBaseline(userId);
  if (recorded === null) return null;
  if (recorded) return [];
  const rows = gradescopeBaseline(gradescope);
  if ((await writeGradescopeBaseline(userId, rows)) === "unavailable") return null;
  console.log("[polya reminders] recorded Gradescope baseline", { userId, rows: rows.length });
  return rows.map((row) => ({ userId, sourceId: row.itemKey, kind: row.kind, sentAt: BASELINE_SENT_AT }));
}

/** The student's marks for these item keys, or null when the marks table doesn't exist yet. */
export async function loadMarks(userId: string, itemKeys: readonly string[]): Promise<AssignmentMark[] | null> {
  const db = serviceDb();
  const results = await Promise.all(
    chunks(itemKeys).map((keys) => db.from(MARKS_TABLE).select("item_key, status, until").eq("user_id", userId).in("item_key", keys)),
  );
  if (results.some((result) => isMissingTableError(result.error))) return null;
  const failed = results.find((result) => result.error);
  if (failed?.error) throw new Error(`Couldn't load assignment marks: ${failed.error.message}`);
  return results
    .flatMap((result) => parseRows(markRow, result.data))
    .map((row) => ({ itemKey: row.item_key, status: row.status, until: row.until }));
}

/**
 * Marks every key of one assignment done or snoozed (replacing an earlier mark), so the mark
 * holds whichever key a later reminder is claimed under. "unavailable" until the migration is
 * applied.
 */
export async function saveMarks(
  userId: string,
  itemKeys: readonly string[],
  status: MarkStatus,
  until: Date | null,
): Promise<"saved" | "unavailable"> {
  const now = new Date().toISOString();
  const { error } = await serviceDb()
    .from(MARKS_TABLE)
    .upsert(
      itemKeys.map((itemKey) => ({ user_id: userId, item_key: itemKey, status, until: until?.toISOString() ?? null, created_at: now })),
      { onConflict: "user_id,item_key" },
    );
  if (isMissingTableError(error)) return "unavailable";
  if (error) throw new Error(`Couldn't save that: ${error.message}`);
  return "saved";
}

/**
 * One read of the student's Gradescope assignments, with a timeout. Never throws. Cached 10 minutes
 * per process (store.ts), so the reconnect pass right after check-ins doesn't sign in again.
 */
export async function readGradescope(userId: string): Promise<{ assignments: GsAssignment[] | null; state: GradescopeState }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), GRADESCOPE_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([listGradescopeAssignments(userId), timeout]);
    if (result === "timeout") {
      console.error("[polya reminders] Gradescope read timed out", { userId });
      return { assignments: null, state: "error" };
    }
    return result === null ? { assignments: null, state: "not_connected" } : { assignments: result, state: "connected" };
  } catch (error) {
    // Reminders still go out without Gradescope; they say the status is unknown.
    console.error("[polya reminders] couldn't read Gradescope", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { assignments: null, state: needsGradescopeReconnect(error) ? "needs_reconnect" : "error" };
  } finally {
    clearTimeout(timer);
  }
}

function dueMs(item: ReminderItem): number {
  return item.dueAt ? Date.parse(item.dueAt) : Number.NaN;
}

/** The student's Canvas assignments (polya_sources), for the caller to filter further. */
function canvasAssignments(userId: string) {
  return serviceDb().from("polya_sources").select(SOURCE_COLUMNS).eq("user_id", userId).eq("origin", "canvas_assignment");
}

async function loadCourses(userId: string, courseIds: readonly string[]): Promise<Map<string, CourseRow>> {
  const courses = new Map<string, CourseRow>();
  const ids = [...new Set(courseIds)];
  if (ids.length === 0) return courses;
  const result = await serviceDb().from("polya_courses").select("id, name, code, created_at").eq("user_id", userId).in("id", ids);
  if (result.error) throw new Error(`Couldn't load courses: ${result.error.message}`);
  for (const course of parseRows(courseRow, result.data)) courses.set(course.id, course);
  return courses;
}

function toCanvasInputs(userId: string, rows: readonly SourceRow[], courses: ReadonlyMap<string, CourseRow>): CanvasAssignmentInput[] {
  return rows.map((row) => {
    const course = courses.get(row.course_id);
    return {
      sourceId: row.id,
      userId,
      courseName: course?.name ?? null,
      courseCode: course?.code ?? null,
      title: row.title,
      dueAt: row.due_at,
      createdAt: row.created_at ?? null,
      courseCreatedAt: course?.created_at ?? null,
    };
  });
}

/** How far back and ahead the mark and snooze tools look for the assignment the student means. */
const LOOKUP_PAST_MS = 3 * 86_400_000;
const LOOKUP_AHEAD_MS = 30 * 86_400_000;

/** The assignment a student's item key or title words point to, from recent and upcoming ones. */
export async function findStudentAssignment(
  userId: string,
  query: { readonly itemKey?: string | undefined; readonly title?: string | undefined },
  now: Date,
): Promise<AssignmentPick<ReminderItem>> {
  const { items } = await loadStudentAssignments(
    userId,
    new Date(now.getTime() - LOOKUP_PAST_MS),
    new Date(now.getTime() + LOOKUP_AHEAD_MS),
  );
  return pickAssignment(items, query);
}
