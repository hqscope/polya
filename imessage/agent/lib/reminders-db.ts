// Database side of submission-aware reminders, shared by the check-in loop and the tools that
// list, mark, or snooze assignments. serviceDb() bypasses RLS, so every query filters by the
// student's user_id, which comes from the session's auth (tools) or the link row (the loop),
// never from the model.
//
// Until the reminders migration is applied, the loop falls back to the polya_imessage_check_ins
// path (Canvas only) and marks are treated as absent, so production keeps working.
import { z } from "zod";

import { CHECK_IN_RULES, type CheckInAssignment, type SentCheckIn } from "./check-ins.ts";
import { loadLegacySends, loadReminderSends, parseRows } from "./check-ins-db.ts";
import { serviceDb } from "./db.ts";
import { GradescopeError } from "./gradescope/client.ts";
import { listGradescopeAssignments } from "./gradescope/store.ts";
import type { GsAssignment } from "./gradescope/types.ts";
import { isMissingTableError } from "./notes.ts";
import {
  canvasItemKey,
  coursesMatch,
  mergeAssignments,
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

/** "error": connected, but it couldn't be read this time. "needs_reconnect": the session expired. */
export type GradescopeState = "connected" | "not_connected" | "needs_reconnect" | "error";

export interface StudentAssignments {
  /** Merged Canvas and Gradescope items due in the window, soonest first. */
  readonly items: ReminderItem[];
  readonly gradescope: GradescopeState;
}

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
  const db = serviceDb();
  let query = db
    .from("polya_sources")
    .select("id, user_id, course_id, title, due_at")
    .eq("user_id", userId)
    .eq("origin", "canvas_assignment")
    .gt("due_at", from.toISOString())
    .lte("due_at", until.toISOString())
    .order("due_at", { ascending: true })
    .limit(MAX_CANVAS_ROWS);
  if (options.courseId) query = query.eq("course_id", options.courseId);
  const [sources, gradescope] = await Promise.all([query, readGradescope(userId)]);
  if (sources.error) throw new Error(`Couldn't load assignments: ${sources.error.message}`);
  const rows = parseRows(sourceRow, sources.data).filter((row) => row.user_id === userId);

  const courseIds = [...new Set([...rows.map((row) => row.course_id), ...(options.courseId ? [options.courseId] : [])])];
  const courses = new Map<string, z.infer<typeof courseRow>>();
  if (courseIds.length > 0) {
    const result = await db.from("polya_courses").select("id, name, code").eq("user_id", userId).in("id", courseIds);
    if (result.error) throw new Error(`Couldn't load courses: ${result.error.message}`);
    for (const course of parseRows(courseRow, result.data)) courses.set(course.id, course);
  }

  const canvas: CanvasAssignmentInput[] = rows.map((row) => ({
    sourceId: row.id,
    userId,
    courseName: courses.get(row.course_id)?.name ?? null,
    courseCode: courses.get(row.course_id)?.code ?? null,
    title: row.title,
    dueAt: row.due_at,
  }));

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
 * The check-in loop's per-student read: assignments due in the next 48 hours, minus submitted,
 * done and snoozed ones, plus the earlier sends needed for dedupe and the daily cap. Uses
 * polya_imessage_reminders when it exists, else the legacy polya_imessage_check_ins path.
 */
export async function loadStudentReminderData(
  userId: string,
  now: Date,
): Promise<{ assignments: CheckInAssignment[]; sent: SentCheckIn[] }> {
  const { items } = await loadStudentAssignments(userId, now, new Date(now.getTime() + CHECK_IN_RULES.dueSoonMaxMs));
  if (items.length === 0) return { assignments: [], sent: [] };

  const keys = [...new Set(items.flatMap((item) => item.keys))];
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
  return prepareCheckIns({ userId, mode: "reminders", items, marks: marks ?? [], sent, now });
}

/** The student's marks for these item keys, or null when the marks table doesn't exist yet. */
export async function loadMarks(userId: string, itemKeys: readonly string[]): Promise<AssignmentMark[] | null> {
  if (itemKeys.length === 0) return [];
  const { data, error } = await serviceDb()
    .from(MARKS_TABLE)
    .select("item_key, status, until")
    .eq("user_id", userId)
    .in("item_key", [...itemKeys]);
  if (isMissingTableError(error)) return null;
  if (error) throw new Error(`Couldn't load assignment marks: ${error.message}`);
  return parseRows(markRow, data).map((row) => ({ itemKey: row.item_key, status: row.status, until: row.until }));
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

async function readGradescope(userId: string): Promise<{ assignments: GsAssignment[] | null; state: GradescopeState }> {
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
    const expired = error instanceof GradescopeError && error.code === "session_expired";
    console.error("[polya reminders] couldn't read Gradescope", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { assignments: null, state: expired ? "needs_reconnect" : "error" };
  } finally {
    clearTimeout(timer);
  }
}

function dueMs(item: ReminderItem): number {
  return item.dueAt ? Date.parse(item.dueAt) : Number.NaN;
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
