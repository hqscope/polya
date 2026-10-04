// Recent conversations on a course page (POLISH P-30). The course page lists
// the last few so a returning student can pick one back up (`?c=<id>`).
//
// Pure so `tests/` can import it under Node's test runner.

export const RECENT_CONVERSATION_LIMIT = 3;

/** A `polya_conversations` row as the course page selects it. */
export interface ConversationRow {
  id: string;
  title: string | null;
  last_message_at: string | null;
}

export interface RecentConversation {
  id: string;
  title: string;
  /** "5 min ago", "2 days ago", "Sep 3". */
  when: string;
}

// The tutor stores the first question, cut to 60 characters, as the title.
const TITLE_MAX = 60;

export function conversationTitle(title: string | null): string {
  const clean = (title ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "Conversation";
  return clean.length >= TITLE_MAX ? `${clean.slice(0, TITLE_MAX - 1).trimEnd()}…` : clean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Elapsed-time label. Buckets by elapsed time, not calendar days, so it reads
 * the same whatever time zone the page is rendered in. */
export function relativeTime(iso: string, now: Date): string {
  const then = new Date(iso);
  const elapsed = now.getTime() - then.getTime();
  if (Number.isNaN(elapsed)) return "";
  if (elapsed < MINUTE) return "Just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} hr ago`;
  if (elapsed < 7 * DAY) {
    const days = Math.floor(elapsed / DAY);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }
  const sameYear = then.getUTCFullYear() === now.getUTCFullYear();
  return then.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

/**
 * Newest first, only conversations that got at least one answer (the tutor
 * stamps `last_message_at` when it saves a reply), at most `limit`.
 */
export function toRecentConversations(
  rows: ConversationRow[],
  now: Date,
  limit = RECENT_CONVERSATION_LIMIT,
): RecentConversation[] {
  return rows
    .filter((row): row is ConversationRow & { last_message_at: string } =>
      Boolean(row.last_message_at),
    )
    .sort((a, b) => Date.parse(b.last_message_at) - Date.parse(a.last_message_at))
    .slice(0, limit)
    .map((row) => ({
      id: row.id,
      title: conversationTitle(row.title),
      when: relativeTime(row.last_message_at, now),
    }));
}
