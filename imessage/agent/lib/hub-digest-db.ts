// Database side of Noel's personal digest (hub-digest.ts). serviceDb() bypasses RLS, so every query
// filters by user_id, which is always the hub owner's id from the environment (NOEL_HUB_POLYA_USER_ID),
// never the model's. Only item keys and times are stored, never mail or event content.
//
// Until polya_imessage_hub_seen exists (supabase/migrations/20261020195214_polya_imessage_hub_seen.sql
// isn't applied), loadDigestSends returns null, the pass stops before reading the hub, and this
// process logs that once.
import { z } from "zod";

import type { CheckInLink } from "./check-ins.ts";
import { chunks, LINK_COLUMNS, parseLinkRow, parseRows } from "./check-ins-db.ts";
import { serviceDb } from "./db.ts";
import { DIGEST_SENT_PREFIX, type BriefAssignment } from "./hub-digest.ts";
import { isMissingTableError } from "./notes.ts";
import { assignmentView } from "./reminders.ts";
import { loadMarks, loadStudentAssignments } from "./reminders-db.ts";

const TABLE = "polya_imessage_hub_seen";
const BRIEF_ASSIGNMENT_DAYS = 3;
/** Submission states that mean there's nothing left to do; the brief leaves them out. */
const FINISHED = new Set(["student said it's done", "submitted on Gradescope", "graded on Gradescope"]);

const keyRow = z.object({ item_key: z.string() });
const sentRow = z.object({ seen_at: z.string() });

let reportedMissingTable = false;

function reportMissingTable(): void {
  if (reportedMissingTable) return;
  reportedMissingTable = true;
  console.warn(`[polya digest] ${TABLE} doesn't exist yet, so the digest is off until its migration is applied`);
}

/** The hub owner's link row, or null when they haven't linked a number. */
export async function loadHubOwnerLink(ownerId: string): Promise<CheckInLink | null> {
  const { data, error } = await serviceDb().from("polya_imessage_links").select(LINK_COLUMNS).eq("user_id", ownerId).maybeSingle();
  if (error) throw new Error(`Couldn't load the hub owner's link: ${error.message}`);
  const link = data ? parseLinkRow(data) : null;
  return link && link.userId === ownerId ? link : null;
}

/** seen_at of the owner's digest:sent rows since `since`, or null while the table doesn't exist. */
export async function loadDigestSends(userId: string, since: Date): Promise<string[] | null> {
  const { data, error } = await serviceDb()
    .from(TABLE)
    .select("seen_at")
    .eq("user_id", userId)
    .like("item_key", `${DIGEST_SENT_PREFIX}%`)
    .gte("seen_at", since.toISOString());
  if (isMissingTableError(error)) {
    reportMissingTable();
    return null;
  }
  if (error) throw new Error(`Couldn't load sent digests: ${error.message}`);
  return parseRows(sentRow, data).map((row) => row.seen_at);
}

/** Which of these keys are already recorded for the owner. */
export async function loadHubSeen(userId: string, keys: readonly string[]): Promise<Set<string>> {
  const db = serviceDb();
  const results = await Promise.all(chunks([...new Set(keys)]).map((part) => db.from(TABLE).select("item_key").eq("user_id", userId).in("item_key", part)));
  const failed = results.find((result) => result.error);
  if (failed?.error) throw new Error(`Couldn't load seen digest items: ${failed.error.message}`);
  return new Set(results.flatMap((result) => parseRows(keyRow, result.data)).map((row) => row.item_key));
}

/**
 * Records keys before the hand-off. Existing rows are left alone (on conflict do nothing), and the
 * insert returns only the rows it added, so overlapping runs each get a disjoint set: only keys
 * this run won may be texted.
 */
export async function claimHubItems(userId: string, keys: readonly string[], now: Date): Promise<Set<string>> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return new Set();
  const { data, error } = await serviceDb()
    .from(TABLE)
    .upsert(
      unique.map((itemKey) => ({ user_id: userId, item_key: itemKey, seen_at: now.toISOString() })),
      { onConflict: "user_id,item_key", ignoreDuplicates: true },
    )
    .select("item_key");
  if (error) throw new Error(`Couldn't record digest items: ${error.message}`);
  return new Set(parseRows(keyRow, data).map((row) => row.item_key));
}

/** Deletes claims whose hand-off failed, so the next run can try again. */
export async function releaseHubItems(userId: string, keys: readonly string[]): Promise<void> {
  const db = serviceDb();
  for (const part of chunks([...new Set(keys)])) {
    const { error } = await db.from(TABLE).delete().eq("user_id", userId).in("item_key", part);
    if (error) throw new Error(`Couldn't release digest items: ${error.message}`);
  }
}

/**
 * The owner's assignments due in the next three days that aren't finished, described the way
 * upcoming_assignments describes them (same loader, marks, and wording).
 */
export async function loadBriefAssignments(userId: string, now: Date, timezone: string): Promise<BriefAssignment[]> {
  const { items } = await loadStudentAssignments(userId, now, new Date(now.getTime() + BRIEF_ASSIGNMENT_DAYS * 86_400_000));
  // Marks only add "student said it's done"; without them the list still works.
  const marks = (await loadMarks(userId, items.flatMap((item) => item.keys)).catch(() => null)) ?? [];
  return items.map((item) => assignmentView(item, marks, now, timezone)).filter((view) => !FINISHED.has(view.submission));
}
