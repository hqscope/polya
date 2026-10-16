// One pass of the check-in loop, with its I/O injected so the ordering rules are testable:
// load -> select -> claim -> send. A check-in is claimed in the database before it's sent and only
// sent when the claim won, so overlapping runs (cron plus a manual trigger) can't double-text.
// run-check-ins.ts wires the real database and iMessage hand-off.
//
// A kind the database doesn't accept yet (its migration isn't applied) fails its claim with
// CheckInKindUnavailableError. The run remembers that kind and selects again without it, so the
// student still gets what the older kinds would have sent (a last_call becomes a due_today).
import {
  CHECK_IN_RULES,
  CheckInKindUnavailableError,
  compareCheckInItems,
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
  /**
   * Inserts the dedupe row. Returns its id when this run won, or null when it was already claimed.
   * Throws CheckInKindUnavailableError when the database doesn't accept the kind yet.
   */
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
/** Selection rounds per student: each extra round follows a newly unavailable kind (five kinds). */
const MAX_SELECTION_ROUNDS = 5;

export async function processCheckIns(deps: CheckInDeps, now: Date): Promise<CheckInRunCounts> {
  const counts: CheckInRunCounts = { students: 0, messagesSent: 0, assignmentsSent: 0, alreadyClaimed: 0, failed: 0 };
  const links = (await deps.loadLinks()).filter((link) => link.checkInsEnabled && link.threadId);
  counts.students = links.length;
  // Kinds the database rejected during this run; later students skip them without trying.
  const unavailable = new Set<CheckInKind>();

  for (let i = 0; i < links.length; i += STUDENT_CONCURRENCY) {
    await Promise.all(
      links.slice(i, i + STUDENT_CONCURRENCY).map(async (link) => {
        try {
          const outcome = await checkInStudent(deps, link, now, unavailable);
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
  unavailable: Set<CheckInKind>,
): Promise<number | "nothing" | "already-claimed"> {
  const { assignments, sent } = await deps.loadStudent(link.userId, now);

  const won: { item: CheckInItem; id: ClaimId }[] = [];
  // Claims this run already made or lost, as sends, so a later round neither repeats them nor
  // forgets them in the daily cap.
  const tried: SentCheckIn[] = [];
  let lost = 0;
  let target: { threadId: string; timezone: string } | null = null;
  try {
    for (let round = 0; round < MAX_SELECTION_ROUNDS; round += 1) {
      const room = CHECK_IN_RULES.maxPerRun - won.length;
      const [plan] = selectCheckIns({ links: [link], assignments, sent: [...sent, ...tried], now, unavailableKinds: unavailable });
      if (!plan || room <= 0) break;
      target = { threadId: plan.threadId, timezone: plan.timezone };

      let rejected = false;
      for (const item of plan.items.slice(0, room)) {
        let id: ClaimId | null;
        try {
          id = await deps.claim(plan.userId, item.sourceId, item.kind);
        } catch (error) {
          if (!(error instanceof CheckInKindUnavailableError)) throw error;
          unavailable.add(error.kind);
          rejected = true;
          continue;
        }
        tried.push({ userId: plan.userId, sourceId: item.sourceId, kind: item.kind, sentAt: now.toISOString() });
        if (id === null) lost += 1;
        else won.push({ item, id });
      }
      if (!rejected) break;
    }
    if (won.length === 0 || !target) return lost > 0 ? "already-claimed" : "nothing";

    const message = formatCheckInMessage(
      won.map((claim) => claim.item).sort(compareCheckInItems),
      target.timezone,
      now,
    );
    await deps.send(target.threadId, link.userId, message);
    return won.length;
  } catch (error) {
    // Treat a failed send as not delivered and free the claims so the next run retries. If the
    // hand-off was accepted before the error, that retry can repeat the text; a rare duplicate
    // beats silently dropping the check-in.
    if (won.length > 0) {
      await deps
        .release(
          link.userId,
          won.map((claim) => claim.id),
        )
        .catch((releaseError: unknown) =>
          deps.logError?.("couldn't release check-in claims", {
            userId: link.userId,
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
