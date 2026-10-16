// Database side of reconnect notices (reconnect.ts). serviceDb() bypasses RLS, so every query
// filters by the student's user_id, which comes from the link row (the loop), the session's auth
// (tools), or the authenticated web route, never from the model.
//
// Until polya_imessage_reconnect_notices exists (its migration isn't applied), the loop texts
// nothing: loadReconnectNotices returns null and the pass stops.
import { z } from "zod";

import { parseRows } from "./check-ins-db.ts";
import { serviceDb } from "./db.ts";
import { clearGradescopeCache, loadGradescopeConnectionStatus } from "./gradescope/store.ts";
import { isMissingTableError } from "./notes.ts";
import {
  canvasHealth,
  gradescopeHealth,
  RECONNECT_NOTICE_GAP_MS,
  type ReconnectClaim,
  type ReconnectHealth,
  type ReconnectNotice,
  type ReconnectService,
} from "./reconnect.ts";
import { readGradescope } from "./reminders-db.ts";

const NOTICES_TABLE = "polya_imessage_reconnect_notices";
/**
 * Canvas connections under their platform name, the one Polya's edge functions read and write
 * (supabase/functions/_shared/connections.ts). Today it's a view over polya_canvas_connections; the
 * planned rename (platform-hardening 8.1b) makes it the table, so this name works before and after.
 */
const CANVAS_CONNECTIONS = "canvas_connections";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

const noticeRow = z.object({ service: z.enum(["canvas", "gradescope"]), texted_at: z.string() });
const statusRow = z.object({ status: z.string() });

/** The student's notice rows, or null when the table doesn't exist yet. */
export async function loadReconnectNotices(userId: string): Promise<ReconnectNotice[] | null> {
  const { data, error } = await serviceDb().from(NOTICES_TABLE).select("service, texted_at").eq("user_id", userId);
  if (isMissingTableError(error)) return null;
  if (error) throw new Error(`Couldn't load reconnect notices: ${error.message}`);
  return parseRows(noticeRow, data).map((row) => ({ service: row.service, textedAt: row.texted_at }));
}

/**
 * Claims a notice before it's sent. With no earlier row, inserts one (a unique violation means an
 * overlapping run won). With an earlier row, moves texted_at to now only while it's still at least
 * 24 hours old, so of two overlapping runs only one updates it.
 */
export async function claimReconnectNotice(
  userId: string,
  service: ReconnectService,
  hadNotice: boolean,
  now: Date,
): Promise<ReconnectClaim> {
  const db = serviceDb();
  if (!hadNotice) {
    const { error } = await db.from(NOTICES_TABLE).insert({ user_id: userId, service, texted_at: now.toISOString() });
    if (!error) return "won";
    if (error.code === UNIQUE_VIOLATION || error.code === FOREIGN_KEY_VIOLATION) return "lost";
    if (isMissingTableError(error)) return "unavailable";
    throw new Error(`Couldn't record reconnect notice: ${error.message}`);
  }
  const { data, error } = await db
    .from(NOTICES_TABLE)
    .update({ texted_at: now.toISOString() })
    .eq("user_id", userId)
    .eq("service", service)
    .lte("texted_at", new Date(now.getTime() - RECONNECT_NOTICE_GAP_MS).toISOString())
    .select("service");
  if (isMissingTableError(error)) return "unavailable";
  if (error) throw new Error(`Couldn't record reconnect notice: ${error.message}`);
  return Array.isArray(data) && data.length > 0 ? "won" : "lost";
}

/** Deletes the student's notice rows for these services. A missing table counts as done. */
export async function clearReconnectNotices(userId: string, services: readonly ReconnectService[]): Promise<void> {
  if (services.length === 0) return;
  const { error } = await serviceDb()
    .from(NOTICES_TABLE)
    .delete()
    .eq("user_id", userId)
    .in("service", [...services]);
  if (error && !isMissingTableError(error)) throw new Error(`Couldn't clear reconnect notices: ${error.message}`);
}

/** Statuses of the student's Canvas connections ('active' or 'invalid'), or null when unreadable. */
export async function loadCanvasStatuses(userId: string): Promise<string[] | null> {
  const { data, error } = await serviceDb().from(CANVAS_CONNECTIONS).select("status").eq("user_id", userId);
  if (error) {
    console.error("[polya reconnect] couldn't read Canvas connections", { userId, error: error.message });
    return null;
  }
  return parseRows(statusRow, data).map((row) => row.status);
}

/** Canvas from the status column; Gradescope from the loop's cached read (10 minutes). */
export async function loadReconnectHealth(userId: string): Promise<ReconnectHealth> {
  const [canvas, gradescope] = await Promise.all([loadCanvasStatuses(userId), readGradescope(userId)]);
  return { canvas: canvasHealth(canvas), gradescope: gradescopeHealth(gradescope.state) };
}

/**
 * Right before texting about Gradescope, re-reads last_error from the database: another process
 * (the reconnect route, or the tool's live check) may have fixed it while this one still had the
 * older failure cached. Canvas health already came straight from the database.
 */
export async function confirmReconnectNeeded(userId: string, service: ReconnectService): Promise<boolean> {
  if (service === "canvas") return true;
  const status = await loadGradescopeConnectionStatus(userId);
  if (!status.needs_reconnect) clearGradescopeCache(userId);
  return status.needs_reconnect;
}
