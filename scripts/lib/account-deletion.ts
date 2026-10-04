// Pure rules for scripts/delete-account.ts: argument parsing, picking the one
// account an email names, which tables and buckets hold a user's data, and
// walking storage. No env, no network, no Supabase client, so tests/ can run
// it under node --test.
//
// MIRRORS Lectra's delete-account edge function
// (lectra-ios/backend/functions/delete-account/ + _shared/account-deletion.ts).
// That function is the in-app path (the user's own JWT); this script is the
// by-email path Noel runs from a terminal. Keep the bucket list in sync with
// Lectra's USER_PREFIXED_BUCKETS when either side adds a bucket.

/// Buckets whose objects all sit under `<user_id>/…`. Deleting the auth user
/// does NOT remove storage objects; these have to be cleared explicitly.
///   polya_documents   `<uid>/<course>/<source>/original.<ext>`, `<uid>/uploads/…`
///   lectra_documents  `<uid>/lectra_documents/…`
///   lectra_blobs      `<uid>/<sha>`
///   drops             `<uid>/<receiver>/<upload>-<name>`
///   transfers         `<uid>/blobs/<sha>`
///   remote_frames     `<uid>/<host>/<command>.jpg`
export const USER_PREFIXED_BUCKETS = [
  "polya_documents",
  "lectra_documents",
  "lectra_blobs",
  "drops",
  "transfers",
  "remote_frames",
] as const;

/// Laid out by shared item id, not user id. Cleared by walking the
/// lectra_shared_items rows the user owns (collected before the auth delete).
export const SHARED_ASSETS_BUCKET = "lectra_shared_assets";

export interface UserTable {
  table: string;
  column: string;
  /// What happens to the row when the auth user is deleted.
  onDelete: "cascade" | "set null" | "none";
}

/// Every public table holding a user id, from pg_constraint on 2026-10-03.
/// "cascade" rows go when the auth user goes (directly, or via public.users).
/// Counted in the dry run; only the "none"/"set null" ones need extra work.
export const USER_TABLES: readonly UserTable[] = [
  // Polya
  ...[
    "polya_canvas_connections",
    "polya_courses",
    "polya_sources",
    "polya_content_units",
    "polya_procedures",
    "polya_procedure_steps",
    "polya_course_policies",
    "polya_conversations",
    "polya_messages",
    "polya_mastery_checks",
    "polya_import_jobs",
    "polya_usage",
    "polya_events",
    "canvas_connection_audit",
  ].map((table) => ({ table, column: "user_id", onDelete: "cascade" as const })),
  // Shared account + Lectra + extension, cascading from auth.users
  { table: "users", column: "id", onDelete: "cascade" },
  ...[
    "devices",
    "uploads",
    "transfers",
    "transfer_receipts",
    "dropbridge_receipts",
    "library_index",
    "lectra_objects",
    "lectra_blobs",
    "lectra_sync_cursors",
    "lectra_sync_user_revision",
    "lectra_user_settings",
    "lectra_turn_credential_issuance",
    "remote_connector_hosts",
    "remote_connector_tokens",
    "remote_commands",
    "usage_daily",
    "storage_quota_overrides",
    "user_storage_usage",
    "feature_flag_allowlist",
    "ai_budget_allowlist",
    "agent_state",
    "agent_audit",
    "character_profile",
    "user_skin_prefs",
    "user_gpa_scenarios",
    "user_dashboard_notes",
    "user_custom_todos",
    "user_reminder_prefs",
    "user_syllabi",
    "google_tokens",
    "google_calendar_tokens",
    "google_drive_audit",
    "google_calendar_audit",
  ].map((table) => ({ table, column: "user_id", onDelete: "cascade" as const })),
  // Cascading from public.users
  { table: "synced_items", column: "user_id", onDelete: "cascade" },
  { table: "search_events", column: "user_id", onDelete: "cascade" },
  { table: "search_patterns", column: "user_id", onDelete: "cascade" },
  { table: "student_profile", column: "user_id", onDelete: "cascade" },
  { table: "lectra_subscriptions", column: "user_id", onDelete: "cascade" },
  { table: "lectra_shared_items", column: "owner_user_id", onDelete: "cascade" },
  { table: "lectra_shared_comments", column: "author_user_id", onDelete: "cascade" },
  { table: "lectra_shared_layers", column: "member_user_id", onDelete: "cascade" },
  { table: "lectra_shared_notebook_ops", column: "author_user_id", onDelete: "cascade" },
  { table: "lectra_shared_pdf_ops", column: "author_user_id", onDelete: "cascade" },
  { table: "lectra_workspaces", column: "owner_user_id", onDelete: "cascade" },
  { table: "lectra_workspace_members", column: "user_id", onDelete: "cascade" },
  { table: "lectra_workspace_invites", column: "created_by", onDelete: "cascade" },
  { table: "lectra_notifications", column: "recipient_user_id", onDelete: "cascade" },
  // Kept with the author nulled: content inside someone else's shared item.
  { table: "lectra_notifications", column: "actor_user_id", onDelete: "set null" },
  { table: "lectra_shared_versions", column: "created_by", onDelete: "set null" },
  // Activity pings: deleted explicitly by the script (see ACTIVITY_* below).
  { table: "activity_installs", column: "user_id", onDelete: "set null" },
  { table: "activity_hours", column: "user_id", onDelete: "none" },
];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export type ParsedArgs =
  | { mode: "email"; email: string; confirm: string | null }
  | { mode: "user-id"; userId: string; confirm: string | null }
  | { mode: "error"; message: string };

export const USAGE = [
  "Usage:",
  "  node scripts/delete-account.ts <email>                      dry run",
  "  node scripts/delete-account.ts <email> --confirm <email>    delete",
  "  node scripts/delete-account.ts --user-id <uuid> [--confirm <uuid>]",
  "      sweep files left under an id whose account is already gone",
].join("\n");

/** Parse argv (without node + script). The confirm value is checked later. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let email: string | null = null;
  let userId: string | null = null;
  let confirm: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--confirm" || arg === "--user-id") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { mode: "error", message: `${arg} needs a value.` };
      }
      if (arg === "--confirm") confirm = value;
      else userId = value;
      i++;
    } else if (arg.startsWith("--")) {
      return { mode: "error", message: `Unknown option ${arg}.` };
    } else if (email === null) {
      email = arg;
    } else {
      return { mode: "error", message: `Unexpected argument ${arg}.` };
    }
  }
  if (email !== null && userId !== null) {
    return { mode: "error", message: "Give an email or --user-id, not both." };
  }
  if (userId !== null) {
    if (!isUuid(userId)) return { mode: "error", message: "--user-id must be a uuid." };
    return { mode: "user-id", userId: userId.toLowerCase(), confirm };
  }
  if (email === null) return { mode: "error", message: "Missing email." };
  if (!normalizeEmail(email).includes("@")) {
    return { mode: "error", message: "That doesn't look like an email address." };
  }
  return { mode: "email", email, confirm };
}

/**
 * The confirm value must repeat the target exactly (emails compared
 * case-insensitively after trimming, since auth stores them lowercased).
 */
export function confirmMatches(confirm: string | null, target: string): boolean {
  if (confirm === null) return false;
  if (isUuid(target)) return confirm.trim().toLowerCase() === target.toLowerCase();
  return normalizeEmail(confirm) === normalizeEmail(target);
}

export interface AuthUserLike {
  id: string;
  email?: string | null;
}

export type UserMatch<T extends AuthUserLike> =
  | { kind: "none" }
  | { kind: "one"; user: T }
  | { kind: "many"; count: number };

/** Exactly-one match on email; anything else is refused by the caller. */
export function matchUserByEmail<T extends AuthUserLike>(
  users: readonly T[],
  email: string,
): UserMatch<T> {
  const wanted = normalizeEmail(email);
  const hits = users.filter((user) => normalizeEmail(user.email ?? "") === wanted);
  if (hits.length === 0) return { kind: "none" };
  if (hits.length > 1) return { kind: "many", count: hits.length };
  if (!isUuid(hits[0].id)) return { kind: "none" };
  return { kind: "one", user: hits[0] };
}

export interface StorageEntry {
  name: string;
  id: string | null;
}

export type ListStorage = (
  bucket: string,
  prefix: string,
  options: { limit: number; offset: number },
) => Promise<readonly StorageEntry[]>;

export const LIST_PAGE = 1000;
/// The Storage API removes at most this many paths per request.
export const REMOVE_BATCH = 1000;

/** Every object under `prefix` in `bucket`, following folders and pages. */
export async function listUnder(
  listStorage: ListStorage,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const found: string[] = [];
  for (let offset = 0; ; offset += LIST_PAGE) {
    const entries = await listStorage(bucket, prefix, { limit: LIST_PAGE, offset });
    for (const entry of entries) {
      const path = `${prefix}/${entry.name}`;
      // Storage lists folders as entries with a null id.
      if (entry.id === null) found.push(...(await listUnder(listStorage, bucket, path)));
      else found.push(path);
    }
    if (entries.length < LIST_PAGE) break;
  }
  return found;
}

/// True when `path` is an object strictly under `ownerPrefix/`: guards the
/// service-role remove against anything a listing could return outside it.
export function isUnderPrefix(path: string, ownerPrefix: string): boolean {
  const segments = path.split("/");
  if (segments.length < 2) return false;
  if (segments[0].toLowerCase() !== ownerPrefix.toLowerCase()) return false;
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size));
  }
  return out;
}
