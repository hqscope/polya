// One pass of the check-in loop, with its I/O injected so the ordering rules are testable:
// load -> select -> claim -> send. A check-in is claimed in the database before it's sent and only
// sent when the claim won, so overlapping runs (cron plus a manual trigger) can't double-text.
// run-check-ins.ts wires the real database and iMessage hand-off.
import {
  formatCheckInMessage,
  selectCheckIns,
  type CheckInAssignment,
  type CheckInItem,
  type CheckInKind,
  type CheckInLink,
  type SentCheckIn,
} from "./check-ins.ts";
import type { CheckInClaimId as ClaimId } from "./check-ins-db.ts";

export interface CheckInDeps {
  loadLinks(): Promise<readonly CheckInLink[]>;
  loadStudent(
    userId: string,
    now: Date,
  ): Promise<{ readonly assignments: readonly CheckInAssignment[]; readonly sent: readonly SentCheckIn[] }>;
  /** Inserts the dedupe row. Returns its id when this run won, or null when it was already claimed. */
  claim(userId: string, sourceId: string, kind: CheckInKind): Promise<ClaimId | null>;
  /** Removes claims whose message failed to send. */
  release(userId: string, ids: readonly ClaimId[]): Promise<void>;
  send(threadId: string, userId: string, message: string): Promise<void>;
  logError?(message: string, details: Record<string, unknown>): void;
}

export interface CheckInRunCounts {
  /** Linked students with check-ins on and a thread to text. */
  students: number;
  /** Messages sent, one per student at most. */
  messagesSent: number;
  /** Assignments covered by those messages. */
  assignmentsSent: number;
  /** Students whose check-ins were all claimed by an overlapping run. */
  alreadyClaimed: number;
  /** Students skipped because something failed; other students still ran. */
  failed: number;
}

const STUDENT_CONCURRENCY = 4;

export async function processCheckIns(deps: CheckInDeps, now: Date): Promise<CheckInRunCounts> {
  const counts: CheckInRunCounts = { students: 0, messagesSent: 0, assignmentsSent: 0, alreadyClaimed: 0, failed: 0 };
  const links = (await deps.loadLinks()).filter((link) => link.checkInsEnabled && link.threadId);
  counts.students = links.length;

  for (let i = 0; i < links.length; i += STUDENT_CONCURRENCY) {
    await Promise.all(
      links.slice(i, i + STUDENT_CONCURRENCY).map(async (link) => {
        try {
          const outcome = await checkInStudent(deps, link, now);
          if (outcome === "already-claimed") counts.alreadyClaimed += 1;
          else if (typeof outcome === "number") {
            counts.messagesSent += 1;
            counts.assignmentsSent += outcome;
          }
        } catch (error) {
          counts.failed += 1;
          deps.logError?.("check-in failed for one student", { userId: link.userId, error: describe(error) });
        }
      }),
    );
  }
  return counts;
}

/** Returns the number of assignments texted, "nothing" when none are due, or "already-claimed". */
async function checkInStudent(
  deps: CheckInDeps,
  link: CheckInLink,
  now: Date,
): Promise<number | "nothing" | "already-claimed"> {
  const { assignments, sent } = await deps.loadStudent(link.userId, now);
  const [plan] = selectCheckIns({ links: [link], assignments, sent, now });
  if (!plan) return "nothing";

  const won: { item: CheckInItem; id: ClaimId }[] = [];
  try {
    for (const item of plan.items) {
      const id = await deps.claim(plan.userId, item.sourceId, item.kind);
      if (id !== null) won.push({ item, id });
    }
    if (won.length === 0) return "already-claimed";

    const message =
      won.length === plan.items.length
        ? plan.message
        : formatCheckInMessage(
            won.map((claim) => claim.item),
            plan.timezone,
            now,
          );
    await deps.send(plan.threadId, plan.userId, message);
    return won.length;
  } catch (error) {
    // Treat a failed send as not delivered and free the claims so the next run retries. If the
    // hand-off was accepted before the error, that retry can repeat the text; a rare duplicate
    // beats silently dropping the check-in.
    if (won.length > 0) {
      await deps
        .release(
          plan.userId,
          won.map((claim) => claim.id),
        )
        .catch((releaseError: unknown) =>
          deps.logError?.("couldn't release check-in claims", {
            userId: plan.userId,
            error: describe(releaseError),
          }),
        );
    }
    throw error;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
