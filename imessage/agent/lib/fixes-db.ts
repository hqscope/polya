// Database side of the fixes Noel reports by text (polya_imessage_fixes). serviceDb() bypasses RLS,
// so every query filters by the owner's user_id, which comes from the session's auth (or, for the
// notify route, from NOEL_HUB_POLYA_USER_ID), never from the model.
//
// Until the table's migration is applied, every call reports `unavailable` instead of throwing.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { ACTIVE_FIX_STATUSES, type Fix, FIX_LIMITS, type FixUpdate, isFixStatus } from "./fixes.ts";
import { isMissingTableError } from "./notes.ts";

const TABLE = "polya_imessage_fixes";
const COLUMNS = "id, lesson, status, issue_ref, issue_url, pr_url, pr_number, head_sha, created_at";

const fixRow = z.object({
  id: z.union([z.number(), z.string()]),
  lesson: z.string(),
  status: z.string(),
  issue_ref: z.string().nullable(),
  issue_url: z.string().nullable(),
  pr_url: z.string().nullable(),
  pr_number: z.number().nullable(),
  head_sha: z.string().nullable(),
  created_at: z.string(),
});

export type FixesResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly unavailable: boolean };

interface DbError {
  readonly code?: string | null;
  readonly message: string;
}

function failed(action: string, error: DbError): { ok: false; unavailable: boolean } {
  if (isMissingTableError(error)) return { ok: false, unavailable: true };
  console.error(`[polya fixes] ${action} failed:`, error.message);
  return { ok: false, unavailable: false };
}

function toFix(raw: unknown): Fix | null {
  const row = fixRow.safeParse(raw);
  if (!row.success || !isFixStatus(row.data.status)) return null;
  const id = Number(row.data.id);
  if (!Number.isSafeInteger(id)) return null;
  return {
    id,
    lesson: row.data.lesson,
    status: row.data.status,
    issueRef: row.data.issue_ref,
    issueUrl: row.data.issue_url,
    prUrl: row.data.pr_url,
    prNumber: row.data.pr_number,
    headSha: row.data.head_sha,
    createdAt: row.data.created_at,
  };
}

/** The owner's fixes whose lesson may still apply, oldest first. activeLessons() applies the age limit. */
export async function loadActiveFixes(db: SupabaseClient, ownerId: string): Promise<FixesResult<Fix[]>> {
  const { data, error } = await db
    .from(TABLE)
    .select(COLUMNS)
    .eq("user_id", ownerId)
    .in("status", [...ACTIVE_FIX_STATUSES])
    .order("created_at", { ascending: true })
    .limit(FIX_LIMITS.maxActive * 3);
  if (error) return failed("load", error);
  return { ok: true, value: (data ?? []).flatMap((raw) => toFix(raw) ?? []) };
}

export async function loadFix(db: SupabaseClient, ownerId: string, id: number): Promise<FixesResult<Fix | null>> {
  const { data, error } = await db.from(TABLE).select(COLUMNS).eq("user_id", ownerId).eq("id", id).maybeSingle();
  if (error) return failed("load one", error);
  return { ok: true, value: data ? toFix(data) : null };
}

export async function loadFixByIssue(db: SupabaseClient, ownerId: string, issueRef: string): Promise<FixesResult<Fix | null>> {
  const { data, error } = await db.from(TABLE).select(COLUMNS).eq("user_id", ownerId).eq("issue_ref", issueRef).maybeSingle();
  if (error) return failed("load by issue", error);
  return { ok: true, value: data ? toFix(data) : null };
}

export async function insertFix(db: SupabaseClient, ownerId: string, lesson: string): Promise<FixesResult<number>> {
  const { data, error } = await db.from(TABLE).insert({ user_id: ownerId, lesson }).select("id").single();
  if (error) return failed("insert", error);
  const id = Number((data as { id?: unknown } | null)?.id);
  return Number.isSafeInteger(id) ? { ok: true, value: id } : { ok: false, unavailable: false };
}

export async function attachIssue(db: SupabaseClient, ownerId: string, id: number, issueRef: string, issueUrl: string): Promise<FixesResult<true>> {
  const { error } = await db
    .from(TABLE)
    .update({ issue_ref: issueRef, issue_url: issueUrl, updated_at: new Date().toISOString() })
    .eq("user_id", ownerId)
    .eq("id", id);
  return error ? failed("attach issue", error) : { ok: true, value: true };
}

export async function updateFix(db: SupabaseClient, ownerId: string, id: number, update: FixUpdate): Promise<FixesResult<true>> {
  const { error } = await db
    .from(TABLE)
    .update({
      status: update.status,
      ...(update.prUrl !== undefined ? { pr_url: update.prUrl } : {}),
      ...(update.prNumber !== undefined ? { pr_number: update.prNumber } : {}),
      ...(update.headSha !== undefined ? { head_sha: update.headSha } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", ownerId)
    .eq("id", id);
  return error ? failed("update", error) : { ok: true, value: true };
}
