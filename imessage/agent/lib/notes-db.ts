// Database side of a student's long-range notes (polya_imessage_notes). serviceDb() bypasses
// RLS, so every query filters by the student's user_id, which comes from the locked memory
// scope (the session's auth), never from the model.
//
// Until the table's migration is applied, every call reports `unavailable` instead of throwing,
// so the agent simply runs without memory.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { isMissingTableError, isNoteKind, NOTE_LIMITS, type NoteKind, type StudentNote } from "./notes.ts";

const TABLE = "polya_imessage_notes";

const noteRow = z.object({
  id: z.union([z.number(), z.string()]),
  kind: z.string(),
  note: z.string(),
  created_at: z.string(),
});

export type NotesResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly unavailable: boolean };

interface DbError {
  readonly code?: string | null;
  readonly message: string;
}

function failed(action: string, error: DbError): { ok: false; unavailable: boolean } {
  if (isMissingTableError(error)) return { ok: false, unavailable: true };
  console.error(`[polya-imessage] notes ${action} failed:`, error.message);
  return { ok: false, unavailable: false };
}

/** The student's notes, newest first, up to the per-student cap. */
export async function loadNotes(db: SupabaseClient, userId: string): Promise<NotesResult<StudentNote[]>> {
  const { data, error } = await db
    .from(TABLE)
    .select("id, kind, note, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(NOTE_LIMITS.maxNotes);
  if (error) return failed("load", error);

  const notes: StudentNote[] = [];
  for (const raw of data ?? []) {
    const row = noteRow.safeParse(raw);
    if (!row.success) continue;
    const id = Number(row.data.id);
    if (!Number.isSafeInteger(id)) continue;
    notes.push({
      id,
      kind: isNoteKind(row.data.kind) ? row.data.kind : "other",
      note: row.data.note,
      createdAt: row.data.created_at,
    });
  }
  return { ok: true, value: notes };
}

export async function insertNote(
  db: SupabaseClient,
  userId: string,
  kind: NoteKind,
  note: string,
): Promise<NotesResult<number>> {
  const { data, error } = await db.from(TABLE).insert({ user_id: userId, kind, note }).select("id").single();
  if (error) return failed("save", error);
  const id = Number((data as { id?: unknown } | null)?.id);
  return Number.isSafeInteger(id) ? { ok: true, value: id } : { ok: false, unavailable: false };
}

/** Deletes one of the student's notes. `value` is false when no such note was theirs. */
export async function deleteNote(db: SupabaseClient, userId: string, id: number): Promise<NotesResult<boolean>> {
  const { data, error } = await db.from(TABLE).delete().eq("user_id", userId).eq("id", id).select("id");
  if (error) return failed("remove", error);
  return { ok: true, value: (data ?? []).length > 0 };
}
