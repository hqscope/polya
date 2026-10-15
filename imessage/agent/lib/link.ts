// Linking an iMessage handle to a Polya account.
//
// An unknown sender gets a one-time code inside a link to the Polya web app. Only the code's
// SHA-256 is stored (polya_imessage_link_codes.code_hash). The student opens the link, signs in,
// and the page calls polya_imessage_claim_code(code), which hashes the code the same way:
// sha256 over the code's UTF-8 bytes, lowercase hex. Codes are base64url, so the URL needs no
// escaping and the hashed bytes are exactly what the link carries.
//
// The top half is pure (tests import it). The bottom half reads and writes the link tables with
// the service-role client: every query filters by the handle or by the linked student's user_id.
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export const LINK_CODE_TTL_MS = 15 * 60 * 1000;
/** Fresh codes one handle may hold at once. Past this, the sender is pointed at the last link. */
export const MAX_OPEN_CODES_PER_HANDLE = 3;
export const DEFAULT_TIMEZONE = "America/Los_Angeles";

const CODE_BYTES = 24; // 192 bits -> 32 base64url characters

export function generateLinkCode(): string {
  return randomBytes(CODE_BYTES).toString("base64url");
}

export function hashLinkCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export function linkCodeExpiry(now: Date): Date {
  return new Date(now.getTime() + LINK_CODE_TTL_MS);
}

export function isLinkCodeLive(row: { expires_at: string; used_at: string | null }, now: Date): boolean {
  return row.used_at === null && new Date(row.expires_at).getTime() > now.getTime();
}

/** `${POLYA_APP_URL}/connect/imessage?code=...`, tolerant of a trailing slash on the base URL. */
export function linkUrl(appUrl: string, code: string): string {
  const url = new URL("/connect/imessage", appUrl.endsWith("/") ? appUrl : `${appUrl}/`);
  url.searchParams.set("code", code);
  return url.toString();
}

export function appUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.POLYA_APP_URL?.trim() || "https://askpolya.com";
}

// ---------------------------------------------------------------------------
// Database reads and writes (service role; every query is scoped).
// ---------------------------------------------------------------------------

export interface LinkRow {
  user_id: string;
  handle: string;
  thread_id: string | null;
  timezone: string;
  check_ins_enabled: boolean;
  quiet_start: number;
  quiet_end: number;
}

const LINK_COLUMNS = "user_id, handle, thread_id, timezone, check_ins_enabled, quiet_start, quiet_end";

export async function findLinkByHandle(db: SupabaseClient, handle: string): Promise<LinkRow | null> {
  const { data, error } = await db
    .from("polya_imessage_links")
    .select(LINK_COLUMNS)
    .eq("handle", handle)
    .maybeSingle();
  if (error) throw new Error(`link lookup failed: ${error.message}`);
  return (data as LinkRow | null) ?? null;
}

export async function findLinkByUser(db: SupabaseClient, userId: string): Promise<LinkRow | null> {
  const { data, error } = await db
    .from("polya_imessage_links")
    .select(LINK_COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`link lookup failed: ${error.message}`);
  return (data as LinkRow | null) ?? null;
}

export async function saveThreadId(db: SupabaseClient, userId: string, threadId: string): Promise<void> {
  const { error } = await db
    .from("polya_imessage_links")
    .update({ thread_id: threadId })
    .eq("user_id", userId);
  if (error) throw new Error(`saving thread id failed: ${error.message}`);
}

export type LinkSettingsPatch = Partial<
  Pick<LinkRow, "timezone" | "check_ins_enabled" | "quiet_start" | "quiet_end">
>;

export async function updateLinkSettings(
  db: SupabaseClient,
  userId: string,
  patch: LinkSettingsPatch,
): Promise<LinkRow | null> {
  const { data, error } = await db
    .from("polya_imessage_links")
    .update(patch)
    .eq("user_id", userId)
    .select(LINK_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`updating settings failed: ${error.message}`);
  return (data as LinkRow | null) ?? null;
}

/** Removes the student's link. Returns false when there was nothing to remove. */
export async function deleteLink(db: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await db
    .from("polya_imessage_links")
    .delete()
    .eq("user_id", userId)
    .select("user_id");
  if (error) throw new Error(`unlinking failed: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

/** Codes for this handle that are still unused and unexpired. */
export async function countOpenCodes(db: SupabaseClient, handle: string, now: Date): Promise<number> {
  const { count, error } = await db
    .from("polya_imessage_link_codes")
    .select("code_hash", { count: "exact", head: true })
    .eq("handle", handle)
    .is("used_at", null)
    .gt("expires_at", now.toISOString());
  if (error) throw new Error(`code count failed: ${error.message}`);
  return count ?? 0;
}

/**
 * Expired codes are kept a day past expiry so a student who reloads the link page late still
 * sees "already linked" (the claim RPC reads the used row) rather than "not valid".
 */
export const EXPIRED_CODE_RETENTION_MS = 24 * 60 * 60 * 1000;

export function codeCleanupCutoff(now: Date): Date {
  return new Date(now.getTime() - EXPIRED_CODE_RETENTION_MS);
}

/**
 * Stores a fresh code's hash for this handle and returns the plaintext code (never stored).
 * Earlier live codes for the handle stay valid (the sender may open any link they were sent);
 * the claim RPC drops the others once one is used. Long-expired codes are swept here so the
 * table doesn't grow.
 */
export async function createLinkCode(db: SupabaseClient, handle: string, now: Date): Promise<string> {
  const sweep = await db
    .from("polya_imessage_link_codes")
    .delete()
    .lt("expires_at", codeCleanupCutoff(now).toISOString());
  if (sweep.error) console.error("[polya-imessage] expired code sweep failed:", sweep.error.message);

  const code = generateLinkCode();
  const { error } = await db.from("polya_imessage_link_codes").insert({
    code_hash: hashLinkCode(code),
    handle,
    created_at: now.toISOString(),
    expires_at: linkCodeExpiry(now).toISOString(),
  });
  if (error) throw new Error(`creating link code failed: ${error.message}`);
  return code;
}
