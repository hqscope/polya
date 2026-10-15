// eve memory provider for a student's long-range notes (agent/memory/notes.ts binds it).
//
// Why not eve's built-in fileMemory(): on Vercel it needs a provisioned Blob store and throws
// without one, which would fail every turn. These notes live next to the student's other Polya
// data in Supabase (polya_imessage_notes), keyed by user_id with an account-delete cascade.
//
// - recall: one message with all of the student's notes, under a stable id so each recall
//   replaces the last. A missing table or a read error recalls nothing; memory must never
//   fail a student's turn.
// - tools: notes__save and notes__remove, bound to the scope eve locked for this turn (the
//   linked student's id from session auth). The model never supplies a user id.
// - no automatic capture: the model decides what's worth keeping (instructions/core.md).
import { defineMemoryProvider } from "eve/memory";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { serviceDb } from "./db.ts";
import { deleteNote, insertNote, loadNotes } from "./notes-db.ts";
import { formatNotesRecall, NOTE_KINDS, NOTE_LIMITS, NOTES_RECALL_ID, planNoteSave, studentFromScope } from "./notes.ts";

const UNAVAILABLE = { saved: false, reason: "Notes aren't available right now. Carry on without saving." } as const;

async function recallNotes(scopeValue: string | readonly string[]) {
  const userId = studentFromScope(scopeValue);
  if (!userId) return null;
  try {
    const result = await loadNotes(serviceDb(), userId);
    if (!result.ok) return null;
    return { messages: [{ id: NOTES_RECALL_ID, content: formatNotesRecall(result.value) }] };
  } catch (error) {
    console.error("[polya-imessage] notes recall threw:", error instanceof Error ? error.message : error);
    return null;
  }
}

export function studentNotesMemory() {
  return defineMemoryProvider({
    recall: {
      async "turn.started"(ctx) {
        return recallNotes(ctx.memory.scope.value);
      },
      async "compaction.completed"(ctx) {
        return recallNotes(ctx.memory.scope.value);
      },
    },
    async tools(ctx) {
      const userId = studentFromScope(ctx.memory.scope.value);
      if (!userId) return null;
      return {
        save: defineTool({
          description: `Saves one short note about the student for future conversations: a goal, how they like help, a plan they said they'd follow, or something they found hard. One fact per note, at most ${NOTE_LIMITS.maxNoteChars} characters. Never save answers, coursework content, or sensitive personal details.`,
          inputSchema: z.object({
            kind: z.enum(NOTE_KINDS).describe("goal, preference (how they like help), plan (what they said they'd do), struggle, or other."),
            note: z.string().min(1).max(1000).describe("The note, in your own short words."),
          }),
          async execute({ kind, note }) {
            const db = serviceDb();
            const existing = await loadNotes(db, userId);
            if (!existing.ok) return UNAVAILABLE;
            const plan = planNoteSave(existing.value, note);
            switch (plan.kind) {
              case "empty":
                return { saved: false, reason: "The note was empty." };
              case "duplicate":
                return { saved: true, id: plan.id, already_saved: true };
              case "full":
                return {
                  saved: false,
                  reason: `This student already has ${NOTE_LIMITS.maxNotes} notes. Remove one that's done or outdated, then save again.`,
                };
              case "insert": {
                const inserted = await insertNote(db, userId, kind, plan.note);
                return inserted.ok ? { saved: true, id: inserted.value } : UNAVAILABLE;
              }
            }
          },
        }),
        remove: defineTool({
          description: "Removes one of the student's saved notes by its number, when it's done, no longer true, or the student asks you to forget it.",
          inputSchema: z.object({ id: z.number().int().positive().describe("The note's number, shown as #n.") }),
          async execute({ id }) {
            const removed = await deleteNote(serviceDb(), userId, id);
            if (!removed.ok) return { removed: false, reason: "Notes aren't available right now." };
            return removed.value ? { removed: true } : { removed: false, reason: `There's no note #${id} for this student.` };
          },
        }),
      };
    },
  });
}
