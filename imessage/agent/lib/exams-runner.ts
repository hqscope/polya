// The exam pass of the check-in loop, with its I/O injected so the ordering rules are testable:
// load exams -> select (exams.ts) -> load facts -> claim -> send. Like the assignment check-ins,
// a text is claimed in polya_imessage_reminders before it's sent and only sent when the claim
// won, so overlapping runs can't double-text. run-check-ins.ts wires the real database and
// iMessage hand-off.
import { resolveTimeZone, type CheckInLink } from "./check-ins.ts";
import {
  ExamKindUnavailableError,
  examItemKey,
  formatExamHandOff,
  selectExamReminder,
  type ExamFacts,
  type ExamReminderKind,
  type SentReminder,
} from "./exams.ts";
import type { UpcomingExam } from "./exams-db.ts";

type ClaimId = number | string;

export interface ExamReminderDeps {
  loadLinks(): Promise<readonly CheckInLink[]>;
  loadExams(userId: string, now: Date, timezone: string): Promise<readonly UpcomingExam[]>;
  /** Null when the reminders table doesn't exist yet. */
  loadSends(userId: string, itemKeys: readonly string[], now: Date): Promise<readonly SentReminder[] | null>;
  loadFacts(userId: string, examId: string, now: Date, timezone: string): Promise<ExamFacts | null>;
  /** The claimed row's id when this run won, null when already claimed. Throws ExamKindUnavailableError. */
  claim(userId: string, itemKey: string, kind: ExamReminderKind): Promise<ClaimId | null>;
  release(userId: string, id: ClaimId): Promise<void>;
  send(threadId: string, userId: string, message: string): Promise<void>;
  logError?(message: string, details: Record<string, unknown>): void;
}

export interface ExamRunCounts {
  /** Linked students with check-ins on and a thread to text. */
  students: number;
  sent: number;
  alreadyClaimed: number;
  failed: number;
  /** True when the database doesn't accept exam reminders yet; nothing was sent. */
  unavailable: boolean;
}

const STUDENT_CONCURRENCY = 4;

export async function processExamReminders(deps: ExamReminderDeps, now: Date): Promise<ExamRunCounts> {
  const counts: ExamRunCounts = { students: 0, sent: 0, alreadyClaimed: 0, failed: 0, unavailable: false };
  const links = (await deps.loadLinks()).filter((link) => link.checkInsEnabled && link.threadId);
  counts.students = links.length;

  for (let i = 0; i < links.length && !counts.unavailable; i += STUDENT_CONCURRENCY) {
    await Promise.all(
      links.slice(i, i + STUDENT_CONCURRENCY).map(async (link) => {
        try {
          const outcome = await remindStudent(deps, link, now, () => counts.unavailable);
          if (outcome === "sent") counts.sent += 1;
          else if (outcome === "already-claimed") counts.alreadyClaimed += 1;
          else if (outcome === "unavailable") counts.unavailable = true;
        } catch (error) {
          counts.failed += 1;
          deps.logError?.("exam reminder failed for one student", { userId: link.userId, error: describe(error) });
        }
      }),
    );
  }
  return counts;
}

async function remindStudent(
  deps: ExamReminderDeps,
  link: CheckInLink,
  now: Date,
  isUnavailable: () => boolean,
): Promise<"sent" | "nothing" | "already-claimed" | "unavailable"> {
  const timezone = resolveTimeZone(link.timezone);
  const exams = await deps.loadExams(link.userId, now, timezone);
  if (exams.length === 0) return "nothing";

  const sent = await deps.loadSends(
    link.userId,
    exams.map((exam) => examItemKey(exam.examId, exam.examDate)),
    now,
  );
  if (sent === null) return "unavailable";

  const plan = selectExamReminder({ link, exams, sent, now });
  if (!plan || isUnavailable()) return "nothing";

  const facts = await deps.loadFacts(link.userId, plan.examId, now, timezone);
  if (!facts) return "nothing";

  let id: ClaimId | null;
  try {
    id = await deps.claim(link.userId, plan.itemKey, plan.kind);
  } catch (error) {
    if (error instanceof ExamKindUnavailableError) return "unavailable";
    throw error;
  }
  if (id === null) return "already-claimed";

  try {
    await deps.send(link.threadId!, link.userId, formatExamHandOff(plan.kind, facts, now, timezone));
    return "sent";
  } catch (error) {
    // Treat a failed send as not delivered and free the claim so the next run retries.
    await deps.release(link.userId, id).catch((releaseError: unknown) =>
      deps.logError?.("couldn't release an exam reminder claim", { userId: link.userId, error: describe(releaseError) }),
    );
    throw error;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
