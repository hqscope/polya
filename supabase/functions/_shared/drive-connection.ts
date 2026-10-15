// The student's Google Drive connection, for polya-google (status / connect /
// disconnect). Reading files with the grant is drive-grant.ts.
//
// The grant is the platform's: one `google_tokens` row per user with
// grant_kind 'drive', shared with the Scope extension's google-drive-connect,
// so connecting Drive in either product connects both (and disconnecting
// disconnects both). Full read (drive.readonly) is gated by the
// `google_drive_full_read` flag: 'allowlist' until Google's restricted-scope
// verification, then 'on'. Polya touches these platform objects' ROWS only;
// it never alters them (CLAUDE.md rule 5). Schemas: lectra-ios/backend/
// migrations/20260924035718_google_tokens.sql (+ _ciphertext_columns,
// _drop_plaintext).
//
// Deno-only (env + service role).
//
// Secrets, read by name only (values are never logged):
//   GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET  the Drive "Web application"
//     OAuth client in Google Cloud project 961806200943 (the extension's Drive client).
//     NOT GOOGLE_OAUTH_CLIENT_ID/SECRET: those name the Supabase sign-in client.
//   POLYA_TOKEN_KEY  encrypts both tokens at rest (token-crypto.ts).
import { service } from "./service.ts";
import { CURRENT_KEY_VERSION, decryptToken, encryptToken } from "./token-crypto.ts";
import { type ClientCredentials, DRIVE_READONLY_SCOPE, revokeToken, type TokenGrant } from "./drive.ts";
import { DRIVE_FLAG_KEY, DRIVE_GRANT_KIND } from "./drive-grant.ts";

const TOKENS_TABLE = "google_tokens";

const CLIENT_ID = (Deno.env.get("GOOGLE_DRIVE_CLIENT_ID") ?? "").trim();
const CLIENT_SECRET = (Deno.env.get("GOOGLE_DRIVE_CLIENT_SECRET") ?? "").trim();
const TOKEN_KEY = Deno.env.get("POLYA_TOKEN_KEY") ?? "";

/** The Drive OAuth client, or null until both secrets are set. */
export function driveCredentials(): ClientCredentials | null {
  return CLIENT_ID && CLIENT_SECRET ? { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } : null;
}

/** True when a grant can be stored and used: the client and the token key are set. */
export function driveConfigured(): boolean {
  return driveCredentials() !== null && TOKEN_KEY.length > 0;
}

export type DriveAccess = "full" | "coming_soon";

/** Whether this student may connect Drive full read. Missing flag row = off. */
export async function driveAccessFor(userId: string): Promise<DriveAccess> {
  const { data: flag, error } = await service
    .from("feature_flags")
    .select("mode")
    .eq("key", DRIVE_FLAG_KEY)
    .maybeSingle();
  if (error) throw new Error(`load flag: ${error.message}`);
  const mode = (flag as { mode?: string } | null)?.mode;
  if (mode === "on") return "full";
  if (mode !== "allowlist") return "coming_soon";
  const { data: listed, error: listError } = await service
    .from("feature_flag_allowlist")
    .select("user_id")
    .eq("flag_key", DRIVE_FLAG_KEY)
    .eq("user_id", userId)
    .maybeSingle();
  if (listError) throw new Error(`load allowlist: ${listError.message}`);
  return listed ? "full" : "coming_soon";
}

interface GrantRow {
  refresh_token_ciphertext: string;
  key_version: number;
  scopes: string[] | null;
  google_email: string | null;
}

async function loadRow(userId: string): Promise<GrantRow | null> {
  const { data, error } = await service
    .from(TOKENS_TABLE)
    .select("refresh_token_ciphertext, key_version, scopes, google_email")
    .eq("user_id", userId)
    .eq("grant_kind", DRIVE_GRANT_KIND)
    .maybeSingle();
  if (error) throw new Error(`load grant: ${error.message}`);
  const row = data as GrantRow | null;
  return row?.refresh_token_ciphertext ? row : null;
}

export interface GrantSummary {
  email: string | null;
  /** The grant can read the student's Drive (a drive.file-only or older-key grant can't). */
  usable: boolean;
}

/** What the status screen shows. Decrypts nothing. */
export async function loadGrantSummary(userId: string): Promise<GrantSummary | null> {
  const row = await loadRow(userId);
  if (!row) return null;
  return {
    email: row.google_email,
    usable: row.key_version === CURRENT_KEY_VERSION &&
      (row.scopes === null || row.scopes.includes(DRIVE_READONLY_SCOPE)),
  };
}

function requireKey(): string {
  if (!TOKEN_KEY) {
    // Fail closed: without the key we neither store nor read Google tokens.
    console.error("[polya] POLYA_TOKEN_KEY is not set; refusing to handle Google tokens");
    throw new Error("Token key unavailable");
  }
  return TOKEN_KEY;
}

/** Stores a fresh grant from a code exchange, replacing any earlier Drive grant. */
export async function saveGrant(userId: string, grant: TokenGrant & { refreshToken: string }): Promise<void> {
  const key = requireKey();
  const stamp = new Date();
  const { error } = await service.from(TOKENS_TABLE).upsert(
    {
      user_id: userId,
      grant_kind: DRIVE_GRANT_KIND,
      refresh_token_ciphertext: await encryptToken(grant.refreshToken, key),
      access_token_ciphertext: await encryptToken(grant.accessToken, key),
      access_token_expires_at: new Date(stamp.getTime() + grant.expiresIn * 1000).toISOString(),
      key_version: CURRENT_KEY_VERSION,
      scopes: grant.scopes,
      google_email: grant.email,
      updated_at: stamp.toISOString(),
    },
    { onConflict: "user_id,grant_kind" },
  );
  if (error) throw new Error(`save grant: ${error.message}`);
}

/**
 * Disconnect: revokes the grant at Google (best effort) and deletes the row,
 * which also disconnects Drive in the Scope extension (same grant).
 */
export async function removeGrant(userId: string): Promise<{ removed: boolean; revoked: boolean }> {
  const row = await loadRow(userId).catch(() => null);
  let revoked = false;
  if (row && TOKEN_KEY && row.key_version === CURRENT_KEY_VERSION) {
    try {
      revoked = await revokeToken(fetch, await decryptToken(row.refresh_token_ciphertext, TOKEN_KEY));
    } catch {
      console.error("[polya] drive disconnect: couldn't open the grant to revoke it");
    }
  }
  const { data, error } = await service
    .from(TOKENS_TABLE)
    .delete()
    .eq("user_id", userId)
    .eq("grant_kind", DRIVE_GRANT_KIND)
    .select("user_id");
  if (error) throw new Error(`remove grant: ${error.message}`);
  if (row && !revoked) console.error("[polya] drive disconnect: not confirmed revoked at Google; row removed anyway");
  return { removed: (data ?? []).length > 0, revoked };
}
