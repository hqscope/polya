// A student's Gradescope connection (polya_gradescope_connections) and the one read the rest of
// the agent uses: listGradescopeAssignments(userId). serviceDb() bypasses RLS, so every query
// filters by user_id, which always comes from the session's auth, never from the model.
//
// Session cookies and the optional password are sealed with secret-box (AES-256-GCM,
// GRADESCOPE_SECRET_KEY) before they reach the database and are never logged.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { serviceDb } from "../db.ts";
import { isMissingTableError } from "../notes.ts";
import { isGradescopeReconnectCode } from "../reconnect.ts";
import { open, seal, SECRET_KEY_VERSION } from "../secret-box.ts";
import { GradescopeClient, GradescopeError, type GradescopeClientOptions } from "./client.ts";
import type { GsAssignment, GsSession } from "./types.ts";

const TABLE = "polya_gradescope_connections";
const CACHE_TTL_MS = 10 * 60_000;

/** Window listGradescopeAssignments keeps: due (or late-due) from 14 days ago to 60 days ahead. */
export const ASSIGNMENT_WINDOW = { pastDays: 14, futureDays: 60 } as const;

const connectionRow = z.object({
  user_id: z.string(),
  email: z.string().nullable(),
  session_ciphertext: z.string(),
  password_ciphertext: z.string().nullable(),
  key_version: z.number(),
  verified_at: z.string().nullable(),
  last_error: z.string().nullable(),
});

type ConnectionRow = z.infer<typeof connectionRow>;

export interface SaveConnectionInput {
  email: string | null;
  session: GsSession;
  /** Stored only for password accounts, so an expired session can log in again unattended. */
  password?: string | null;
}

export async function saveGradescopeConnection(
  userId: string,
  input: SaveConnectionInput,
  db: SupabaseClient = serviceDb(),
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await db.from(TABLE).upsert(
    {
      user_id: userId,
      email: input.email,
      session_ciphertext: seal(JSON.stringify(input.session)),
      password_ciphertext: input.password ? seal(input.password) : null,
      key_version: SECRET_KEY_VERSION,
      verified_at: now,
      last_error: null,
      updated_at: now,
    },
    { onConflict: "user_id" },
  );
  if (error) throw new Error(`Saving the Gradescope connection failed: ${error.message}`);
  cache.delete(userId);
}

export async function deleteGradescopeConnection(userId: string, db: SupabaseClient = serviceDb()): Promise<void> {
  const { error } = await db.from(TABLE).delete().eq("user_id", userId);
  if (error && !isMissingTableError(error)) throw new Error(`Removing the Gradescope connection failed: ${error.message}`);
  cache.delete(userId);
}

async function loadConnection(db: SupabaseClient, userId: string): Promise<ConnectionRow | null> {
  const { data, error } = await db
    .from(TABLE)
    .select("user_id, email, session_ciphertext, password_ciphertext, key_version, verified_at, last_error")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error)) return null; // migration not applied yet: nobody is connected
    throw new Error(`Loading the Gradescope connection failed: ${error.message}`);
  }
  if (data === null) return null;
  const row = connectionRow.safeParse(data);
  if (!row.success) throw new Error("Gradescope connection row has an unexpected shape");
  return row.data;
}

async function updateConnection(db: SupabaseClient, userId: string, patch: Partial<ConnectionRow>): Promise<void> {
  const { error } = await db
    .from(TABLE)
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("user_id", userId);
  if (error) console.error("[polya-imessage] gradescope connection update failed:", error.message);
}

/** Pure: the assignments worth talking about now, soonest due first. */
export function selectRelevantAssignments(all: readonly GsAssignment[], now: Date = new Date()): GsAssignment[] {
  const from = now.getTime() - ASSIGNMENT_WINDOW.pastDays * 86_400_000;
  const to = now.getTime() + ASSIGNMENT_WINDOW.futureDays * 86_400_000;
  return all
    .filter((a) => {
      const due = a.due_at ? Date.parse(a.due_at) : Number.NaN;
      const late = a.late_due_at ? Date.parse(a.late_due_at) : Number.NaN;
      const latest = Number.isNaN(late) ? due : Math.max(due, late);
      return !Number.isNaN(due) && latest >= from && due <= to;
    })
    .sort((a, b) => Date.parse(a.due_at ?? "") - Date.parse(b.due_at ?? ""));
}

/**
 * last_error as stored: `<code>: <message>`, so readers (lastErrorCode) can tell a sign-in only the
 * student can fix from a passing network failure.
 */
export function describeGradescopeError(error: GradescopeError): string {
  return `${error.code}: ${error.message}`;
}

/** The GradescopeError code at the start of a stored last_error, or null. */
export function lastErrorCode(lastError: string | null): string | null {
  return /^([a-z_]+):/.exec(lastError ?? "")?.[1] ?? null;
}

/** Restores the saved session; when it expired, signs in again with the saved password if any. */
async function restoreClient(row: ConnectionRow, options: GradescopeClientOptions): Promise<GradescopeClient> {
  const session = JSON.parse(open(row.session_ciphertext)) as GsSession;
  const client = GradescopeClient.fromSession(session, options);
  if (await client.verify()) return client;

  if (row.password_ciphertext && row.email) {
    await client.loginWithPassword(row.email, open(row.password_ciphertext));
    return client;
  }
  throw new GradescopeError("session_expired", "Gradescope session expired; reconnect with a fresh session cookie");
}

/** Stores the refreshed session after a successful read or check. */
async function saveRefreshedSession(db: SupabaseClient, userId: string, client: GradescopeClient): Promise<void> {
  await updateConnection(db, userId, {
    session_ciphertext: seal(JSON.stringify(client.exportSession())),
    key_version: SECRET_KEY_VERSION,
    verified_at: new Date().toISOString(),
    last_error: null,
  });
}

async function fetchAssignments(userId: string, db: SupabaseClient, options: GradescopeClientOptions): Promise<GsAssignment[] | null> {
  const row = await loadConnection(db, userId);
  if (!row) return null;

  let client: GradescopeClient;
  const all: GsAssignment[] = [];
  try {
    client = await restoreClient(row, options);
    const courses = (await client.listCourses()).filter((c) => c.role === "student");
    for (const course of courses) {
      try {
        all.push(...(await client.listAssignments(course.course_id, course)));
      } catch (error) {
        if (error instanceof GradescopeError && error.code === "session_expired") throw error;
        // One unreadable course shouldn't hide the others.
        console.error(`[polya-imessage] gradescope course ${course.course_id} skipped:`, error instanceof Error ? error.message : error);
      }
    }
  } catch (error) {
    // Every failure is recorded, so the reconnect notice (reconnect.ts) and the web page's status
    // can tell an expired sign-in from a passing network error.
    if (error instanceof GradescopeError) await updateConnection(db, userId, { last_error: describeGradescopeError(error) });
    throw error;
  }

  await saveRefreshedSession(db, userId, client);
  return selectRelevantAssignments(all);
}

export type GradescopeCheck = "working" | "needs_reconnect" | "not_connected" | "unknown";

/**
 * A live check of the saved sign-in (one account-page request, or a fresh sign-in for a password
 * account whose session expired), for the reconnect_link tool. Records the outcome like a read does.
 */
export async function checkGradescopeConnection(
  userId: string,
  db: SupabaseClient = serviceDb(),
  options: GradescopeClientOptions = { timeoutMs: 10_000 },
): Promise<GradescopeCheck> {
  const row = await loadConnection(db, userId);
  if (!row) return "not_connected";
  try {
    const client = await restoreClient(row, options);
    await saveRefreshedSession(db, userId, client);
    // A failure cached from before the student reconnected is stale now.
    const hit = cache.get(userId);
    if (hit && "error" in hit) cache.delete(userId);
    return "working";
  } catch (error) {
    if (!(error instanceof GradescopeError)) {
      console.error("[polya-imessage] gradescope check failed:", error instanceof Error ? error.message : error);
      return "unknown";
    }
    await updateConnection(db, userId, { last_error: describeGradescopeError(error) });
    return isGradescopeReconnectCode(error.code) ? "needs_reconnect" : "unknown";
  }
}

export interface GradescopeConnectionStatus {
  /** A saved connection whose last read or check didn't end in a sign-in problem. */
  connected: boolean;
  /** Whether the saved sign-in needs the student to reconnect. */
  needs_reconnect: boolean;
  /**
   * The recorded sign-in problem the student has to fix, or null. A passing failure (network,
   * Gradescope down) stays null: the connection still counts as connected.
   */
  last_error: string | null;
}

/** The stored connection state, without contacting Gradescope. */
export async function loadGradescopeConnectionStatus(
  userId: string,
  db: SupabaseClient = serviceDb(),
): Promise<GradescopeConnectionStatus> {
  const row = await loadConnection(db, userId);
  if (!row) return { connected: false, needs_reconnect: false, last_error: null };
  const needsReconnect = isGradescopeReconnectCode(lastErrorCode(row.last_error));
  return { connected: !needsReconnect, needs_reconnect: needsReconnect, last_error: needsReconnect ? row.last_error : null };
}

const cache = new Map<string, { expiresAt: number; value: GsAssignment[] } | { expiresAt: number; error: unknown }>();
const inFlight = new Map<string, Promise<GsAssignment[] | null>>();

/**
 * The student's Gradescope assignments due from 14 days ago to 60 days ahead, across their
 * student courses, soonest first. Returns null when the student hasn't connected Gradescope (or
 * the table doesn't exist yet). Throws GradescopeError when a connection exists but can't be
 * used (code "session_expired" means they need to reconnect). Results and failures are cached per
 * process for 10 minutes.
 */
export async function listGradescopeAssignments(userId: string): Promise<GsAssignment[] | null> {
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > Date.now()) {
    if ("error" in hit) throw hit.error;
    return hit.value;
  }

  const pending = inFlight.get(userId);
  if (pending) return pending;

  const task = fetchAssignments(userId, serviceDb(), {})
    .then((value) => {
      if (value !== null) cache.set(userId, { expiresAt: Date.now() + CACHE_TTL_MS, value });
      return value;
    })
    .catch((error: unknown) => {
      // Failures are cached too, so a broken connection isn't retried (or re-logged-in) on every
      // check-in pass.
      cache.set(userId, { expiresAt: Date.now() + CACHE_TTL_MS, error });
      throw error;
    })
    .finally(() => inFlight.delete(userId));
  inFlight.set(userId, task);
  return task;
}

/** Test and reconnect hook: forget cached assignments for one student, or everyone. */
export function clearGradescopeCache(userId?: string): void {
  if (userId) cache.delete(userId);
  else cache.clear();
}
