// The student's recent Polya web conversations, reduced to a short summary the agent can bring
// up ("last week you were working on X"). Pure: tools/recent_study_history.ts does the reads.

import { calendarDaysBetween } from "./dates.ts";

export const HISTORY_LIMITS = {
  maxConversations: 5,
  questionsPerConversation: 3,
  maxQuestionChars: 160,
  maxTitleChars: 80,
  defaultDays: 14,
  maxDays: 30,
} as const;

export interface HistoryConversation {
  readonly id: string;
  readonly courseId: string;
  readonly title: string | null;
  /** ISO timestamp. */
  readonly lastMessageAt: string;
}

export interface HistoryMessage {
  readonly conversationId: string;
  readonly content: string;
  /** ISO timestamp. */
  readonly createdAt: string;
}

export interface HistoryCourse {
  readonly id: string;
  readonly name: string | null;
  readonly code: string | null;
}

export interface StudySession {
  readonly course: string;
  readonly title: string;
  readonly last_active: string;
  /** The student's own last few questions in that conversation, oldest first. */
  readonly recent_questions: readonly string[];
}

export interface SummarizeInput {
  readonly conversations: readonly HistoryConversation[];
  readonly messages: readonly HistoryMessage[];
  readonly courses: readonly HistoryCourse[];
  readonly now: Date;
  readonly timeZone: string;
}

/** Most recent conversations first, each with its course, title, when, and last few questions. */
export function summarizeStudyHistory({ conversations, messages, courses, now, timeZone }: SummarizeInput): StudySession[] {
  const courseNames = new Map(courses.map((course) => [course.id, course.name || course.code || "Unknown course"]));
  const sorted = [...conversations]
    .filter((row) => Number.isFinite(Date.parse(row.lastMessageAt)))
    .sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt))
    .slice(0, HISTORY_LIMITS.maxConversations);

  return sorted.map((conversation) => {
    const questions = messages
      .filter((message) => message.conversationId === conversation.id)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map((message) => clip(message.content, HISTORY_LIMITS.maxQuestionChars))
      .filter((text) => text.length > 0)
      .slice(0, HISTORY_LIMITS.questionsPerConversation)
      .reverse();
    return {
      course: courseNames.get(conversation.courseId) ?? "Unknown course",
      title: clip(conversation.title ?? "", HISTORY_LIMITS.maxTitleChars) || "Untitled conversation",
      last_active: describeWhen(new Date(conversation.lastMessageAt), now, timeZone),
      recent_questions: questions,
    };
  });
}

/** "today (Thu, Oct 15)", "yesterday (Wed, Oct 14)", "6 days ago (Fri, Oct 9)". */
export function describeWhen(then: Date, now: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(then);
  const days = calendarDaysBetween(then, now, timeZone);
  if (days <= 0) return `today (${date})`;
  if (days === 1) return `yesterday (${date})`;
  return `${days} days ago (${date})`;
}

/** One line, no control characters, capped with an ellipsis. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/[\p{Cc}]+/gu, " ").replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}
