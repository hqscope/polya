// Deletes a Scope account (Polya, Lectra, the extension: one shared auth user)
// on request by email. The privacy page promises this within 30 days; the
// runbook is plans/course-rules-horizon/ACCOUNT-DELETION.md.
//
// Default is a DRY RUN: it finds the account and prints how many rows and
// files would go, and changes nothing. With `--confirm <same email>` it:
//   1. collects what can only be found while the account exists (owned shared
//      Lectra items, activity-ping browser ids),
//   2. deletes the auth user (hard delete). Every table with a user id
//      cascades from auth.users, directly or via public.users, so a failure
//      here leaves everything intact and the run can simply be repeated,
//   3. deletes the leftovers the cascade does not reach: storage objects under
//      the user's prefix in every user-keyed bucket, owned shared-item assets,
//      activity pings, and any waitlist signup under the same email.
// Same order as Lectra's delete-account edge function, for the same reason.
//
// Idempotent: a second run finds no account and says so. If step 3 left files
// behind, the summary prints the user id; re-run with `--user-id <id>` to
// sweep (refused while an account with that id still exists).
//
// Env (read only, never printed):
//   POLYA_SUPABASE_URL          project URL — required, no default, so this
//                               never targets a project by accident
//   SUPABASE_SERVICE_ROLE_KEY   service-role key for that project
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

import {
  chunk,
  confirmMatches,
  isUnderPrefix,
  isUuid,
  listUnder,
  type ListStorage,
  matchUserByEmail,
  normalizeEmail,
  parseArgs,
  REMOVE_BATCH,
  SHARED_ASSETS_BUCKET,
  type StorageEntry,
  USAGE,
  USER_PREFIXED_BUCKETS,
  USER_TABLES,
} from "./lib/account-deletion.ts";

const WAITLIST_TABLE = "agent_workspace_waitlist";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "Unknown error";
}

function adminClient(): SupabaseClient {
  const url = process.env.POLYA_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) fail("Set POLYA_SUPABASE_URL (the project URL).");
  if (!key) fail("Set SUPABASE_SERVICE_ROLE_KEY (read it into the env; don't paste it on the command line).");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function allAuthUsers(admin: SupabaseClient): Promise<User[]> {
  const users: User[] = [];
  const perPage = 1000;
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`Couldn't list accounts: ${error.message}`);
    users.push(...data.users);
    if (data.users.length < perPage) break;
  }
  return users;
}

async function authUserExists(admin: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (data?.user) return true;
  // GoTrue answers 404 / "User not found" for a missing id; anything else is a
  // real failure and must not be read as "gone".
  if (error && (error.status === 404 || /not found/i.test(error.message))) return false;
  if (error) throw new Error(`Couldn't look up ${userId}: ${error.message}`);
  return false;
}

function storageLister(admin: SupabaseClient): ListStorage {
  return async (bucket, prefix, options) => {
    const { data, error } = await admin.storage.from(bucket).list(prefix, options);
    if (error) throw new Error(`list ${bucket}/${prefix}: ${error.message}`);
    return (data ?? []) as StorageEntry[];
  };
}

async function countRows(admin: SupabaseClient, table: string, column: string, value: string) {
  const { count, error } = await admin
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq(column, value);
  if (error) return `? (${error.message || "not readable"})`;
  return count ?? 0;
}

interface Plan {
  userId: string;
  files: Map<string, string[]>; // bucket -> paths
  sharedItemIds: string[];
  anonIds: string[];
  waitlistIds: string[];
}

async function collect(admin: SupabaseClient, userId: string, email: string | null): Promise<Plan> {
  const list = storageLister(admin);
  const files = new Map<string, string[]>();
  for (const bucket of USER_PREFIXED_BUCKETS) {
    const paths = (await listUnder(list, bucket, userId)).filter((p) => isUnderPrefix(p, userId));
    files.set(bucket, paths);
  }

  const { data: shared, error: sharedError } = await admin
    .from("lectra_shared_items")
    .select("id")
    .eq("owner_user_id", userId);
  if (sharedError) throw new Error(`lectra_shared_items: ${sharedError.message}`);
  const sharedItemIds = (shared ?? []).map((row: { id: unknown }) => String(row.id).toLowerCase()).filter(isUuid);
  const sharedPaths: string[] = [];
  for (const itemId of sharedItemIds) {
    sharedPaths.push(...(await listUnder(list, SHARED_ASSETS_BUCKET, itemId)));
  }
  files.set(SHARED_ASSETS_BUCKET, sharedPaths);

  // Browser ids this account pinged from. Once the account is gone,
  // activity_installs.user_id is nulled and the link is lost, so take them now.
  const anon = new Set<string>();
  for (const table of ["activity_installs", "activity_hours"]) {
    const { data, error } = await admin.from(table).select("anon_id").eq("user_id", userId);
    if (error) throw new Error(`${table}: ${error.message}`);
    for (const row of (data ?? []) as Array<{ anon_id: unknown }>) {
      if (isUuid(row.anon_id)) anon.add(row.anon_id.toLowerCase());
    }
  }

  const waitlistIds: string[] = [];
  if (email) {
    // ilike would treat `_` (common in emails) as a wildcard; match exactly here.
    const { data, error } = await admin.from(WAITLIST_TABLE).select("id, email").ilike("email", email.trim());
    // Not account data; a read failure here shouldn't block the deletion.
    if (error) console.warn(`  couldn't check ${WAITLIST_TABLE}: ${error.message}; check it by hand`);
    for (const row of (data ?? []) as Array<{ id: string; email: string }>) {
      if (normalizeEmail(row.email) === normalizeEmail(email)) waitlistIds.push(row.id);
    }
  }

  return { userId, files, sharedItemIds, anonIds: [...anon], waitlistIds };
}

async function printPlan(admin: SupabaseClient, plan: Plan, accountExists: boolean) {
  if (accountExists) {
    console.log("\nRows (cascade = removed with the account):");
    for (const { table, column, onDelete } of USER_TABLES) {
      const n = await countRows(admin, table, column, plan.userId);
      if (n === 0) continue;
      const note =
        onDelete === "cascade" ? "cascade" : onDelete === "set null" ? "kept, author cleared" : "deleted by script";
      console.log(`  ${table}.${column}: ${n}  [${note}]`);
    }
    console.log("  auth.identities/sessions/refresh tokens, auth.oauth_consents/authorizations: cascade (not counted)");
  }
  console.log("\nFiles (deleted by script):");
  for (const [bucket, paths] of plan.files) {
    if (paths.length > 0) console.log(`  ${bucket}: ${paths.length}`);
  }
  if ([...plan.files.values()].every((p) => p.length === 0)) console.log("  none");
  console.log("\nOther (deleted by script):");
  console.log(`  activity pings from ${plan.anonIds.length} browser id(s)`);
  console.log(`  ${WAITLIST_TABLE} signups with this email: ${plan.waitlistIds.length}`);
}

async function removeFiles(admin: SupabaseClient, plan: Plan): Promise<number> {
  let remaining = 0;
  for (const [bucket, paths] of plan.files) {
    for (const batch of chunk(paths, REMOVE_BATCH)) {
      const { error } = await admin.storage.from(bucket).remove(batch);
      if (error) {
        remaining += batch.length;
        console.error(`  could not remove ${batch.length} file(s) from ${bucket}: ${error.message}`);
      }
    }
  }
  return remaining;
}

async function removeLeftoverRows(admin: SupabaseClient, plan: Plan): Promise<number> {
  let failures = 0;
  const run = async (label: string, op: PromiseLike<{ error: { message: string } | null }>) => {
    const { error } = await op;
    if (error) {
      failures++;
      console.error(`  could not clear ${label}: ${error.message}`);
    }
  };
  await run("activity_hours (account)", admin.from("activity_hours").delete().eq("user_id", plan.userId));
  for (const ids of chunk(plan.anonIds, 200)) {
    // Only rows no other account claims: a shared browser may carry another user's id.
    await run("activity_hours (browser)", admin.from("activity_hours").delete().in("anon_id", ids).is("user_id", null));
    await run("activity_installs", admin.from("activity_installs").delete().in("anon_id", ids).is("user_id", null));
  }
  if (plan.waitlistIds.length > 0) {
    await run(WAITLIST_TABLE, admin.from(WAITLIST_TABLE).delete().in("id", plan.waitlistIds));
  }
  return failures;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "error") fail(`${args.message}\n\n${USAGE}`);

  const admin = adminClient();
  const target = args.mode === "email" ? args.email : args.userId;
  const confirmed = args.confirm !== null;
  if (confirmed && !confirmMatches(args.confirm, target)) {
    fail(`--confirm must repeat ${args.mode === "email" ? "the email" : "the user id"} exactly. Nothing was changed.`);
  }

  let userId: string;
  let email: string | null = null;
  let accountExists: boolean;

  if (args.mode === "email") {
    const match = matchUserByEmail(await allAuthUsers(admin), args.email);
    if (match.kind === "many") fail(`${match.count} accounts match that email. Refusing; resolve by hand.`);
    if (match.kind === "none") {
      console.log("No account with that email. Already deleted, or never signed up.");
      console.log("If a previous run left files behind, it printed a user id: re-run with --user-id <id>.");
      return;
    }
    userId = match.user.id.toLowerCase();
    email = match.user.email ?? args.email;
    accountExists = true;
    const providers = (match.user.identities ?? []).map((i) => i.provider).join(", ") || "none";
    console.log(`Account ${userId}`);
    console.log(`  created ${match.user.created_at}, last sign-in ${match.user.last_sign_in_at ?? "never"}, sign-in: ${providers}`);
  } else {
    userId = args.userId;
    accountExists = await authUserExists(admin, userId);
    if (accountExists) fail("An account with that id still exists. Delete by email instead.");
    console.log(`Sweeping leftovers for deleted account ${userId}`);
  }

  const plan = await collect(admin, userId, email);
  await printPlan(admin, plan, accountExists);

  if (!confirmed) {
    console.log("\nDRY RUN: nothing was changed.");
    console.log(`To delete: re-run with --confirm ${args.mode === "email" ? "<the same email>" : userId}`);
    return;
  }

  console.log("\nDeleting…");
  if (accountExists) {
    const { error } = await admin.auth.admin.deleteUser(userId, false);
    if (error) fail(`Account deletion failed: ${error.message}\nNothing else was touched; safe to re-run.`);
    console.log("  account deleted (tables cascaded)");
  }
  const filesRemaining = await removeFiles(admin, plan);
  const rowFailures = await removeLeftoverRows(admin, plan);

  const total = [...plan.files.values()].reduce((n, p) => n + p.length, 0);
  console.log(`  files removed: ${total - filesRemaining} of ${total}`);
  if (filesRemaining > 0 || rowFailures > 0) {
    console.log(`\nINCOMPLETE. Re-run: node scripts/delete-account.ts --user-id ${userId} --confirm ${userId}`);
    process.exit(2);
  }
  console.log(`\nDone. Log: ${new Date().toISOString().slice(0, 10)}  user ${userId}`);
}

main().catch((error: unknown) => fail(`Failed: ${errorMessage(error)}`));
