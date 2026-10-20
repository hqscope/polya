// One pass of Noel's personal digest, with its I/O injected so the ordering rules are testable:
// gate (owner, thread, quiet hours, table, cap) -> collect -> select -> claim -> send. Items are
// claimed in polya_imessage_hub_seen before the hand-off and released if it fails, like check-ins,
// so overlapping runs (cron plus a manual trigger) can't double-text.
//
// Each run sends at most one hand-off: the morning brief when it's due (first run from 8:00 local,
// outside quiet hours, before noon), otherwise a digest when there's something new. The brief also
// claims the mail, announcements, and soon-starting meetings it covers, so the digest doesn't repeat
// them. Daily cap: six digests per local day, counted from the `digest:sent:<time>` row each digest
// hand-off inserts (and releases with its items if the send fails). The brief has its own
// once-a-day key and doesn't count against the six.
import { randomBytes } from "node:crypto";

import { inQuietHours, resolveTimeZone, type CheckInLink } from "./check-ins.ts";
import {
  briefItems,
  briefKey,
  calendarSoonItems,
  digestBudget,
  digestSentKey,
  DIGEST_RULES,
  formatDigestMessage,
  formatMorningBrief,
  isValidHubKey,
  morningBriefWindow,
  nextLocalMidnight,
  selectDigestItems,
  todaysEvents,
  type BriefAssignment,
  type CollectRequest,
  type DigestItem,
  type HubSnapshot,
} from "./hub-digest.ts";
import type { HubConfig } from "./noel-hub.ts";

export interface HubDigestDeps {
  /** The hub when it's fully configured (hubOwner()), else null and the pass does nothing. */
  readonly hub: HubConfig | null;
  /** The owner's own link row, or null. Never anyone else's. */
  loadOwnerLink(ownerId: string): Promise<CheckInLink | null>;
  /** seen_at of the owner's digest:sent rows since `since`, or null while the table doesn't exist. */
  loadDigestSends(userId: string, since: Date): Promise<readonly string[] | null>;
  /** Which of these keys are already recorded. */
  loadSeen(userId: string, keys: readonly string[]): Promise<ReadonlySet<string>>;
  /** Inserts the keys that aren't recorded yet; returns the ones this run inserted (won). */
  claim(userId: string, keys: readonly string[], now: Date): Promise<ReadonlySet<string>>;
  /** Deletes claimed keys whose hand-off didn't go out. */
  release(userId: string, keys: readonly string[]): Promise<void>;
  collect(hub: HubConfig, request: CollectRequest): Promise<HubSnapshot>;
  /** Upcoming assignments for the brief, already described for the agent. */
  loadAssignments(userId: string, now: Date, timezone: string): Promise<readonly BriefAssignment[]>;
  send(threadId: string, userId: string, message: string): Promise<void>;
  /** Fence nonce for the hand-off; random by default. */
  nonce?(): string;
  logError?(message: string, details: Record<string, unknown>): void;
}

export type HubDigestStatus =
  | "not-configured"
  | "no-thread"
  | "quiet-hours"
  | "unavailable"
  | "capped"
  | "nothing-new"
  | "already-claimed"
  | "sent";

export interface HubDigestCounts {
  status: HubDigestStatus;
  kind: "digest" | "morning-brief" | null;
  /** Hub items (mail, announcements, meetings) claimed and handed off this run. */
  items: number;
  /** Hub reads that failed this run. */
  hubFailures: number;
}

export async function processHubDigest(deps: HubDigestDeps, now: Date): Promise<HubDigestCounts> {
  const counts: HubDigestCounts = { status: "not-configured", kind: null, items: 0, hubFailures: 0 };
  const hub = deps.hub;
  if (!hub) return counts;

  // Only the hub owner's own link, with check-ins on and a thread to text.
  const link = await deps.loadOwnerLink(hub.ownerId);
  if (!link || link.userId !== hub.ownerId || !link.checkInsEnabled || !link.threadId) {
    return { ...counts, status: "no-thread" };
  }
  // Quiet hours first: nothing is read from the hub overnight, and nothing is marked seen, so the
  // morning's first digest picks up whatever came in.
  if (inQuietHours(link, now)) return { ...counts, status: "quiet-hours" };

  const userId = link.userId;
  const threadId = link.threadId;
  const timezone = resolveTimeZone(link.timezone);

  const sends = await deps.loadDigestSends(userId, new Date(now.getTime() - DIGEST_RULES.sentLookbackMs));
  if (sends === null) return { ...counts, status: "unavailable" };
  const budget = digestBudget(sends, now, timezone);

  const todayKey = briefKey(now, timezone);
  const wantBrief = morningBriefWindow(link, now) && !(await deps.loadSeen(userId, [todayKey])).has(todayKey);
  if (!wantBrief && budget <= 0) return { ...counts, status: "capped" };

  const soonUntil = now.getTime() + DIGEST_RULES.calendarWindowMs;
  const calendarUntil = new Date(wantBrief ? Math.max(soonUntil, nextLocalMidnight(now, timezone).getTime()) : soonUntil);
  const snapshot = await deps.collect(hub, { now, calendarUntil });
  counts.hubFailures = snapshot.failed;

  const candidates = [...calendarSoonItems(snapshot.events, now), ...snapshot.gmail, ...snapshot.canvas].filter((item) =>
    isValidHubKey(item.key),
  );
  const seen = candidates.length > 0 ? await deps.loadSeen(userId, candidates.map((item) => item.key)) : new Set<string>();
  const nonce = deps.nonce?.() ?? randomBytes(6).toString("hex");

  if (wantBrief) {
    const { shown, claimOnly } = briefItems(selectDigestItems(candidates, seen, Number.POSITIVE_INFINITY));
    const assignments = await deps.loadAssignments(userId, now, timezone).catch((error: unknown) => {
      deps.logError?.("couldn't load assignments for the morning brief", { error: describe(error) });
      return [] as BriefAssignment[];
    });
    const won = await deps.claim(userId, [todayKey, ...shown.map((item) => item.key), ...claimOnly.map((item) => item.key)], now);
    const claimed = [...won];
    if (!won.has(todayKey)) {
      // An overlapping run is sending today's brief; give back anything this run picked up.
      await releaseQuietly(deps, userId, claimed);
      return { ...counts, status: "already-claimed", kind: "morning-brief" };
    }
    const items = shown.filter((item) => won.has(item.key));
    const message = formatMorningBrief({
      now,
      timezone,
      nonce,
      events: todaysEvents(snapshot.events, now, timezone),
      assignments: assignments.slice(0, DIGEST_RULES.briefMaxAssignments),
      items,
      incomplete: snapshot.failed > 0,
    });
    await sendOrRelease(deps, threadId, userId, message, claimed);
    return { ...counts, status: "sent", kind: "morning-brief", items: claimed.length - 1 };
  }

  const fresh = selectDigestItems(candidates, seen, DIGEST_RULES.maxItemsPerDigest);
  if (fresh.length === 0) return { ...counts, status: "nothing-new" };

  const won = await deps.claim(userId, [digestSentKey(now), ...fresh.map((item) => item.key)], now);
  const claimed = [...won];
  const items: DigestItem[] = fresh.filter((item) => won.has(item.key));
  if (items.length === 0) {
    await releaseQuietly(deps, userId, claimed);
    return { ...counts, status: "already-claimed", kind: "digest" };
  }
  await sendOrRelease(deps, threadId, userId, formatDigestMessage(items, { now, timezone, nonce }), claimed);
  return { ...counts, status: "sent", kind: "digest", items: items.length };
}

/**
 * Sends the hand-off. If it fails, frees every claim so the next run retries; if the hand-off was
 * accepted before the error, that retry can repeat it, which beats silently dropping it.
 */
async function sendOrRelease(
  deps: HubDigestDeps,
  threadId: string,
  userId: string,
  message: string,
  claimed: readonly string[],
): Promise<void> {
  try {
    await deps.send(threadId, userId, message);
  } catch (error) {
    await releaseQuietly(deps, userId, claimed);
    throw error;
  }
}

async function releaseQuietly(deps: HubDigestDeps, userId: string, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  await deps.release(userId, keys).catch((error: unknown) => deps.logError?.("couldn't release digest claims", { error: describe(error) }));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
