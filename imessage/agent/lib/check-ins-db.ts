// Database side of the check-in loop. serviceDb() bypasses RLS, so every read of student data
// filters by that student's user_id. The one cross-student read is loadCheckInLinks, which is how
// the loop finds who to look at; it selects only the fields the loop needs (never the handle).
import { z } from "zod";

import type { CheckInKind, CheckInLink, SentCheckIn } from "./check-ins.ts";
import { serviceDb } from "./db.ts";
import { isMissingTableError } from "./notes.ts";
import { isItemKey } from "./reminders.ts";

/**
 * A claimed row's id: polya_imessage_check_ins.id as is, or `reminder:<id>` for a
 * polya_imessage_reminders row, so release knows which table to delete from.
 */
export type CheckInClaimId = number | string;

const LEGACY_TABLE = "polya_imessage_check_ins";
const REMINDERS_TABLE = "polya_imessage_reminders";
const REMINDER_CLAIM_PREFIX = "reminder:";
const PAGE_SIZE = 1000;
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

const claimId = z.union([z.number(), z.string()]);

const sentRow = z.object({
  id: claimId,
  source_id: z.string(),
  kind: z.string(),
  sent_at: z.string(),
});

const reminderRow = z.object({
  id: claimId,
  item_key: z.string(),
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
 * Earlier sends from polya_imessage_check_ins (keyed by polya_sources id): every send for these
 * assignments (dedupe) plus every send in the last 26 hours (the daily cap).
 */
export async function loadLegacySends(userId: string, sourceIds: readonly string[], now: Date): Promise<SentCheckIn[]> {
  const db = serviceDb();
  const [forSources, recent] = await Promise.all([
    sourceIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : db.from(LEGACY_TABLE).select("id, source_id, kind, sent_at").eq("user_id", userId).in("source_id", [...sourceIds]),
    db
      .from(LEGACY_TABLE)
      .select("id, source_id, kind, sent_at")
      .eq("user_id", userId)
      .gte("sent_at", new Date(now.getTime() - SENT_TODAY_LOOKBACK_MS).toISOString()),
  ]);
  if (forSources.error) throw new Error(`Couldn't load sent check-ins: ${forSources.error.message}`);
  if (recent.error) throw new Error(`Couldn't load sent check-ins: ${recent.error.message}`);
  return dedupeSends(userId, [...parseRows(sentRow, forSources.data), ...parseRows(sentRow, recent.data)], (row) => row.source_id);
}

/**
 * Earlier sends from polya_imessage_reminders (keyed by item key), read the same way as
 * loadLegacySends. Returns null when the table doesn't exist yet (migration not applied).
 */
export async function loadReminderSends(userId: string, itemKeys: readonly string[], now: Date): Promise<SentCheckIn[] | null> {
  const db = serviceDb();
  const [forItems, recent] = await Promise.all([
    itemKeys.length === 0
      ? Promise.resolve({ data: [], error: null })
      : db.from(REMINDERS_TABLE).select("id, item_key, kind, sent_at").eq("user_id", userId).in("item_key", [...itemKeys]),
    db
      .from(REMINDERS_TABLE)
      .select("id, item_key, kind, sent_at")
      .eq("user_id", userId)
      .gte("sent_at", new Date(now.getTime() - SENT_TODAY_LOOKBACK_MS).toISOString()),
  ]);
  if (isMissingTableError(forItems.error) || isMissingTableError(recent.error)) return null;
  if (forItems.error) throw new Error(`Couldn't load sent reminders: ${forItems.error.message}`);
  if (recent.error) throw new Error(`Couldn't load sent reminders: ${recent.error.message}`);
  return dedupeSends(userId, [...parseRows(reminderRow, forItems.data), ...parseRows(reminderRow, recent.data)], (row) => row.item_key);
}

/**
 * Records a check-in before it's sent. Returns a claim id when this run won the unique
 * constraint, or null when another run already claimed it (or the assignment was deleted
 * meanwhile). Only a winner may send. An item key (`canvas:...`, `gs:...`) is claimed in
 * polya_imessage_reminders; a bare polya_sources id in polya_imessage_check_ins (legacy mode).
 */
export async function claimCheckIn(userId: string, sourceId: string, kind: CheckInKind): Promise<CheckInClaimId | null> {
  const reminder = isItemKey(sourceId);
  const { data, error } = await serviceDb()
    .from(reminder ? REMINDERS_TABLE : LEGACY_TABLE)
    .insert(reminder ? { user_id: userId, item_key: sourceId, kind } : { user_id: userId, source_id: sourceId, kind })
    .select("id")
    .single();
  if (error) {
    if (error.code === UNIQUE_VIOLATION || error.code === FOREIGN_KEY_VIOLATION) return null;
    throw new Error(`Couldn't record check-in: ${error.message}`);
  }
  const row = z.object({ id: claimId }).safeParse(data);
  if (!row.success) throw new Error("Couldn't record check-in: the insert returned no id");
  return reminder ? `${REMINDER_CLAIM_PREFIX}${row.data.id}` : row.data.id;
}

/** Deletes claims whose message failed to send, so a later run can try again. */
export async function releaseCheckIns(userId: string, ids: readonly CheckInClaimId[]): Promise<void> {
  const reminderIds = ids.filter(isReminderClaim).map((id) => String(id).slice(REMINDER_CLAIM_PREFIX.length));
  const legacyIds = ids.filter((id) => !isReminderClaim(id)).map(String);
  for (const [table, tableIds] of [
    [REMINDERS_TABLE, reminderIds],
    [LEGACY_TABLE, legacyIds],
  ] as const) {
    if (tableIds.length === 0) continue;
    const { error } = await serviceDb().from(table).delete().eq("user_id", userId).in("id", tableIds);
    if (error) throw new Error(`Couldn't release check-in claims: ${error.message}`);
  }
}

function isReminderClaim(id: CheckInClaimId): boolean {
  return typeof id === "string" && id.startsWith(REMINDER_CLAIM_PREFIX);
}

/** The two send reads overlap; key by row id so the daily count sees each send once. */
function dedupeSends<T extends { id: number | string; kind: string; sent_at: string }>(
  userId: string,
  rows: readonly T[],
  key: (row: T) => string,
): SentCheckIn[] {
  const byId = new Map<string, T>();
  for (const row of rows) byId.set(String(row.id), row);
  return [...byId.values()].map((row) => ({ userId, sourceId: key(row), kind: row.kind, sentAt: row.sent_at }));
}

export function parseRows<T>(schema: z.ZodType<T>, data: unknown): T[] {
  if (!Array.isArray(data)) return [];
  const rows: T[] = [];
  for (const raw of data) {
    const row = schema.safeParse(raw);
    if (row.success) rows.push(row.data);
  }
  return rows;
}
