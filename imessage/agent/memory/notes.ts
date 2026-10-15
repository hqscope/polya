// Long-range memory: short notes about the linked student that carry across conversations and
// check-ins. Scoped to the Polya user id the channel or check-in sender put on the session auth
// (lib/student.ts); a session without one (unlinked, local dev) gets no memory at all.
import { defineMemory } from "eve/memory";

import { studentNotesMemory } from "../lib/notes-memory.ts";
import { noteScope } from "../lib/notes.ts";

export default defineMemory({
  description: "Long-term notes about this student: goals, how they like help, plans they made, and what they found hard.",
  provider: studentNotesMemory(),
  scope: (ctx) => noteScope(ctx.session.auth),
});
