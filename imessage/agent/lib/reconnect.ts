// Reconnect notices: when a student's Gradescope sign-in or Canvas connection stops working, the
// check-in loop texts them a link to fix it, at most once a day while it stays broken. The student
// can also ask for the link any time (tools/reconnect_link.ts).
//
// The top half is pure (tests import it): links, health classification, the 24-hour rule, and the
// hand-off message. processReconnectNotices runs one pass with its I/O injected, the same way
// check-ins-runner.ts does; reconnect-db.ts and run-check-ins.ts wire the real database and
// iMessage hand-off. A notice is claimed in polya_imessage_reconnect_notices before it's sent, so
// overlapping runs (cron plus a manual trigger) can't double-text.
import { inQuietHours, type CheckInLink } from "./check-ins.ts";
import { GradescopeError, type GradescopeErrorCode } from "./gradescope/client.ts";
import type { GradescopeState } from "./reminders-db.ts";

export type ReconnectService = "canvas" | "gradescope";

export const RECONNECT_SERVICES: readonly ReconnectService[] = ["gradescope", "canvas"];

/** ok: works. broken: needs the student to reconnect. absent: not connected. unknown: couldn't tell. */
export type ServiceHealth = "ok" | "broken" | "absent" | "unknown";

export type ReconnectHealth = Readonly<Record<ReconnectService, ServiceHealth>>;

/** A row of polya_imessage_reconnect_notices: when the student was last texted about a service. */
export interface ReconnectNotice {
  readonly service: ReconnectService;
  readonly textedAt: string;
}

export const RECONNECT_PREFIX = "[polya reconnect]";

/** While a service stays broken, at most one text about it per this long. */
export const RECONNECT_NOTICE_GAP_MS = 24 * 60 * 60 * 1000;

/** Gradescope failures only the student can fix by signing in again. */
export const GRADESCOPE_RECONNECT_CODES: ReadonlySet<GradescopeErrorCode> = new Set([
  "session_expired",
  "invalid_credentials",
  "sso_required",
]);

const SERVICE_NAME: Readonly<Record<ReconnectService, string>> = { canvas: "Canvas", gradescope: "Gradescope" };

const PROBLEM: Readonly<Record<ReconnectService, string>> = {
  gradescope: "Polya's Gradescope sign-in stopped working, so it can't see submissions or grades there",
  canvas: "Polya's Canvas connection stopped working, so new assignments and course changes aren't coming through",
};

export function serviceName(service: ReconnectService): string {
  return SERVICE_NAME[service];
}

/** Where the student fixes it: `${POLYA_APP_URL}/connect/gradescope` or `${POLYA_APP_URL}/app/connect`. */
export function reconnectUrl(service: ReconnectService, appUrl: string): string {
  const base = appUrl.endsWith("/") ? appUrl : `${appUrl}/`;
  return new URL(service === "gradescope" ? "connect/gradescope" : "app/connect", base).toString();
}

export function isGradescopeReconnectCode(code: string | null | undefined): boolean {
  return typeof code === "string" && GRADESCOPE_RECONNECT_CODES.has(code as GradescopeErrorCode);
}

/** True for a GradescopeError the student has to fix by reconnecting. */
export function needsGradescopeReconnect(error: unknown): boolean {
  return error instanceof GradescopeError && isGradescopeReconnectCode(error.code);
}

/**
 * Canvas from the student's connection statuses: broken only when some connection is 'invalid'
 * and none is 'active'.
 */
export function canvasHealth(statuses: readonly string[] | null): ServiceHealth {
  if (statuses === null) return "unknown";
  if (statuses.includes("active")) return "ok";
  if (statuses.includes("invalid")) return "broken";
  return "absent";
}

/**
 * Gradescope from the loop's read (reminders-db.ts readGradescope): needs_reconnect is a
 * reconnect-class GradescopeError; error is anything else (network, timeout), so unknown.
 */
export function gradescopeHealth(state: GradescopeState): ServiceHealth {
  switch (state) {
    case "connected":
      return "ok";
    case "not_connected":
      return "absent";
    case "needs_reconnect":
      return "broken";
    case "error":
      return "unknown";
  }
}

export interface ReconnectPlan {
  /** Broken, and not texted about in the last 24 hours. */
  readonly send: ReconnectService[];
  /** Working again (or no longer connected) with a notice row left over. */
  readonly clear: ReconnectService[];
}

/** Pure: which services to text about now, and which notice rows to clear. */
export function planReconnectNotices(input: {
  readonly health: ReconnectHealth;
  readonly notices: readonly ReconnectNotice[];
  readonly now: Date;
}): ReconnectPlan {
  const send: ReconnectService[] = [];
  const clear: ReconnectService[] = [];
  const nowMs = input.now.getTime();
  for (const service of RECONNECT_SERVICES) {
    const notice = input.notices.find((row) => row.service === service);
    const health = input.health[service];
    if (health === "broken") {
      const textedMs = notice ? Date.parse(notice.textedAt) : Number.NaN;
      if (!notice || !Number.isFinite(textedMs) || nowMs - textedMs >= RECONNECT_NOTICE_GAP_MS) send.push(service);
    } else if (notice && (health === "ok" || health === "absent")) {
      clear.push(service);
    }
  }
  return { send, clear };
}

/** The hand-off when something stopped working: the prefix line, then one block per service. */
export function formatReconnectMessage(services: readonly ReconnectService[], appUrl: string): string {
  const blocks = services.map((service) =>
    [`service: ${serviceName(service)}`, "status: stopped working", `problem: ${PROBLEM[service]}`, `link: ${reconnectUrl(service, appUrl)}`].join("\n"),
  );
  return [RECONNECT_PREFIX, ...blocks].join("\n\n");
}

/** The hand-off after the student reconnected from the web page. */
export function formatReconnectedMessage(service: ReconnectService): string {
  return [RECONNECT_PREFIX, [`service: ${serviceName(service)}`, "status: reconnected"].join("\n")].join("\n\n");
}

// ---------------------------------------------------------------------------------------------
// One pass of the loop, I/O injected.

export type ReconnectClaim = "won" | "lost" | "unavailable";

export interface ReconnectDeps {
  /** Same students as check-ins: check-ins on and a thread to text. */
  loadLinks(): Promise<readonly CheckInLink[]>;
  /** The student's notice rows, or null when the table doesn't exist yet (skip texting). */
  loadNotices(userId: string): Promise<readonly ReconnectNotice[] | null>;
  checkHealth(userId: string): Promise<ReconnectHealth>;
  /**
   * Re-reads the stored state right before texting. False when it's fixed or gone, e.g. the student
   * reconnected while this process still had an older failure cached.
   */
  confirmBroken(userId: string, service: ReconnectService): Promise<boolean>;
  /**
   * Records the notice before it's sent: inserts the row when `hadNotice` is false, else moves
   * texted_at forward only if it's still older than 24 hours. "lost" when another run got there first.
   */
  claim(userId: string, service: ReconnectService, hadNotice: boolean, now: Date): Promise<ReconnectClaim>;
  /** Deletes notice rows (a fixed service, or claims whose message failed to send). */
  clear(userId: string, services: readonly ReconnectService[]): Promise<void>;
  send(threadId: string, userId: string, message: string): Promise<void>;
  logError?(message: string, details: Record<string, unknown>): void;
}

export interface ReconnectRunCounts {
  /** Linked students with check-ins on and a thread to text. */
  students: number;
  /** Students who got a reconnect text this run. */
  messagesSent: number;
  /** Notice rows cleared because the service works again. */
  cleared: number;
  /** Students skipped because something failed; other students still ran. */
  failed: number;
  /** True when the notices table doesn't exist yet, so nothing was texted. */
  unavailable: boolean;
}

const STUDENT_CONCURRENCY = 4;

export async function processReconnectNotices(deps: ReconnectDeps, now: Date, appUrl: string): Promise<ReconnectRunCounts> {
  const counts: ReconnectRunCounts = { students: 0, messagesSent: 0, cleared: 0, failed: 0, unavailable: false };
  const links = (await deps.loadLinks()).filter((link) => link.checkInsEnabled && link.threadId);
  counts.students = links.length;

  for (let i = 0; i < links.length && !counts.unavailable; i += STUDENT_CONCURRENCY) {
    await Promise.all(
      links.slice(i, i + STUDENT_CONCURRENCY).map(async (link) => {
        try {
          const outcome = await reconnectStudent(deps, link, now, appUrl);
          if (outcome === "unavailable") counts.unavailable = true;
          else {
            counts.cleared += outcome.cleared;
            if (outcome.sent) counts.messagesSent += 1;
          }
        } catch (error) {
          counts.failed += 1;
          deps.logError?.("reconnect check failed for one student", { userId: link.userId, error: describe(error) });
        }
      }),
    );
  }
  return counts;
}

async function reconnectStudent(
  deps: ReconnectDeps,
  link: CheckInLink,
  now: Date,
  appUrl: string,
): Promise<{ sent: boolean; cleared: number } | "unavailable"> {
  // Same quiet hours as check-ins. Clearing a fixed service can wait for the morning too.
  if (!link.threadId || inQuietHours(link, now)) return { sent: false, cleared: 0 };

  const notices = await deps.loadNotices(link.userId);
  if (notices === null) return "unavailable";
  const plan = planReconnectNotices({ health: await deps.checkHealth(link.userId), notices, now });
  if (plan.clear.length > 0) await deps.clear(link.userId, plan.clear);

  const won: ReconnectService[] = [];
  for (const service of plan.send) {
    if (!(await deps.confirmBroken(link.userId, service))) continue;
    const hadNotice = notices.some((row) => row.service === service);
    const claim = await deps.claim(link.userId, service, hadNotice, now);
    if (claim === "unavailable") return "unavailable";
    if (claim === "won") won.push(service);
  }
  if (won.length === 0) return { sent: false, cleared: plan.clear.length };

  try {
    await deps.send(link.threadId, link.userId, formatReconnectMessage(won, appUrl));
  } catch (error) {
    // Not delivered: free the claims so the next run tries again.
    await deps.clear(link.userId, won).catch((clearError: unknown) =>
      deps.logError?.("couldn't release reconnect claims", { userId: link.userId, error: describe(clearError) }),
    );
    throw error;
  }
  return { sent: true, cleared: plan.clear.length };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
