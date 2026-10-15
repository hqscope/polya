// What the iMessage channel does with one inbound message, as pure decisions plus the few
// fixed replies it sends without the model. channels/photon.ts does the I/O around these.
import { MAX_OPEN_CODES_PER_HANDLE, type LinkRow } from "./link.ts";
import { normalizeHandle } from "./handles.ts";

export const DEFAULT_DAILY_REPLY_CAP = 60;
/** Bucket in the shared usage_daily meter (increment_usage_daily RPC), counted per UTC day. */
export const DAILY_REPLY_BUCKET = "polya-imessage:reply";

export interface InboundAuthor {
  readonly userId: string;
  readonly isMe?: boolean;
  readonly isBot?: boolean | "unknown";
}

export type SenderCheck =
  | { readonly kind: "ignore"; readonly reason: "own-message" | "bot" | "group-chat" | "unknown-handle" }
  | { readonly kind: "sender"; readonly handle: string };

/** iMessage chat GUIDs mark one-to-one chats with ";-;" and group chats with ";+;". */
export function isDirectThreadId(threadId: string): boolean {
  return threadId.includes(";-;");
}

/**
 * Who sent this, or why to ignore it. Group chats are ignored: a link code posted there could be
 * claimed by anyone in the group, and one shared session would mix several students' courses.
 */
export function checkSender(author: InboundAuthor, isDirect: boolean): SenderCheck {
  if (author.isMe === true) return { kind: "ignore", reason: "own-message" };
  if (author.isBot === true) return { kind: "ignore", reason: "bot" };
  if (!isDirect) return { kind: "ignore", reason: "group-chat" };
  const handle = normalizeHandle(author.userId);
  if (!handle) return { kind: "ignore", reason: "unknown-handle" };
  return { kind: "sender", handle };
}

export type LinkDecision =
  | { readonly kind: "needs-link" }
  | {
      readonly kind: "dispatch";
      readonly userId: string;
      readonly timezone: string;
      /** The link has no thread yet, or a different one: save this thread for check-ins. */
      readonly saveThreadId: boolean;
    };

export function decideLink(link: Pick<LinkRow, "user_id" | "thread_id" | "timezone"> | null, threadId: string): LinkDecision {
  if (!link) return { kind: "needs-link" };
  return {
    kind: "dispatch",
    userId: link.user_id,
    timezone: link.timezone,
    saveThreadId: link.thread_id !== threadId,
  };
}

/** A new code unless the handle already holds enough live ones (stops a texting loop from minting codes). */
export function shouldIssueCode(openCodes: number): boolean {
  return openCodes < MAX_OPEN_CODES_PER_HANDLE;
}

/** POLYA_IMESSAGE_DAILY_REPLY_CAP as a positive integer, else the default. */
export function dailyReplyCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.POLYA_IMESSAGE_DAILY_REPLY_CAP?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_DAILY_REPLY_CAP;
  const value = Number(raw);
  return value >= 1 ? value : DEFAULT_DAILY_REPLY_CAP;
}

export type CapDecision = "allow" | "notify" | "silent" | "unavailable";

/**
 * `total` is today's count after this message (null when the meter failed). Over the cap, the
 * first message gets one notice and later ones get nothing, so a student isn't sent the same
 * notice on every text. A failed meter refuses, matching Polya's other limiters (fail closed).
 */
export function capDecision(total: number | null, cap: number): CapDecision {
  if (total === null) return "unavailable";
  if (total <= cap) return "allow";
  return total === cap + 1 ? "notify" : "silent";
}

// ---------------------------------------------------------------------------
// Fixed replies. Students read these: plain text, no mechanics.
// ---------------------------------------------------------------------------

export function linkMessage(url: string): string {
  return `Hi, I'm Polya, an AI tutor for your courses. To get started, connect this number to your Polya account: ${url}\n\nThe link works for 15 minutes.`;
}

export function linkPendingMessage(): string {
  return "I just sent you a link to connect this number to Polya. Open it to finish, or text me again in 15 minutes for a new one.";
}

export function capReachedMessage(hoursUntilReset: number, appHost: string): string {
  const when = hoursUntilReset <= 1 ? "in about an hour" : `in about ${hoursUntilReset} hours`;
  return `You've reached today's limit for texting Polya. It resets ${when}. You can keep studying at ${appHost} in the meantime.`;
}

export function unavailableMessage(): string {
  return "Polya can't reply right now. Try again in a few minutes.";
}

/** "askpolya.com" from "https://askpolya.com/". */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
