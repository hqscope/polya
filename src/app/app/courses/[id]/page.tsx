import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getAuthenticatedAppUser } from "@/lib/auth/session";
import { redirectToLogin } from "@/lib/auth/login-redirect";
import ChatView from "@/components/chat/ChatView";
import type { ChatMessage } from "@/components/chat/MessageBubble";
import { buildPracticeSeed } from "../../../../../supabase/functions/_shared/study-seed.ts";
import type { PartResponse, PartResult } from "../../../../../supabase/functions/_shared/study-grade.ts";
import type { PublicPart } from "../../../../../supabase/functions/_shared/study-questions.ts";
import {
  RECENT_CONVERSATION_LIMIT,
  toRecentConversations,
  type ConversationRow,
} from "@/lib/conversations";

// The tab title names the course, not the bare word "Study" — with several
// course tabs open, they'd otherwise be indistinguishable.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const { supabase, outage } = await getAuthenticatedAppUser();
  if (outage) return { title: "Study" };
  const { data: course } = await supabase
    .from("polya_courses")
    .select("name")
    .eq("id", id)
    .maybeSingle();
  return { title: course?.name ?? "Study" };
}

export default async function CoursePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ c?: string; practice?: string }>;
}) {
  const { user, supabase, outage } = await getAuthenticatedAppUser();
  if (outage) {
    throw new Error("auth-outage");
  }
  if (!user) {
    return redirectToLogin();
  }
  const { id } = await params;
  const { c: conversationId, practice: practiceId } = await searchParams;

  const [{ data: course, error: courseError }, { data: policy }, { data: recentRows }] = await Promise.all([
    supabase
      .from("polya_courses")
      .select("name, code, term_name")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("polya_course_policies")
      .select("mode")
      .eq("course_id", id)
      .maybeSingle(),
    // A fresh visit lists the latest conversations to pick back up. Only ones
    // that got an answer have `last_message_at`.
    conversationId
      ? Promise.resolve({ data: null })
      : supabase
          .from("polya_conversations")
          .select("id, title, last_message_at")
          .eq("course_id", id)
          .not("last_message_at", "is", null)
          .order("last_message_at", { ascending: false })
          .limit(RECENT_CONVERSATION_LIMIT),
  ]);

  // Couldn't load it: the retry notice, not a bounce to the course list.
  if (courseError) {
    throw new Error("course-unavailable");
  }
  if (!course) {
    redirect("/app");
  }

  // Load history if resuming a conversation. Each assistant row carries its
  // own sources so [n] citations keep resolving against the right evidence.
  let initialMessages: ChatMessage[] = [];
  if (conversationId) {
    const { data: rows } = await supabase
      .from("polya_messages")
      .select("role, content, sources")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    initialMessages = ((rows ?? []) as Array<ChatMessage & { sources: unknown }>).map((row) => ({
      role: row.role,
      content: row.content,
      sources: Array.isArray(row.sources) && row.sources.length > 0 ? row.sources : undefined,
    })) as ChatMessage[];
  }

  // "Talk it through" from Study: the practice question (and the student's
  // latest answer to it) goes in the box, for the student to edit and send.
  let initialInput = "";
  if (practiceId && !conversationId) {
    const [{ data: question }, { data: attempt }] = await Promise.all([
      supabase
        .from("polya_practice_questions")
        .select("stem, parts")
        .eq("id", practiceId)
        .eq("course_id", id)
        .maybeSingle(),
      supabase
        .from("polya_practice_attempts")
        .select("responses, results")
        .eq("question_id", practiceId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (question) {
      const results = (attempt?.results ?? null) as PartResult[] | null;
      initialInput = buildPracticeSeed({
        stem: question.stem as string,
        parts: question.parts as PublicPart[],
        responses: (attempt?.responses ?? null) as PartResponse[] | null,
        correct: results ? results.map((r) => (r.ok ? r.correct : false)) : null,
      });
    }
  }

  const recentConversations = toRecentConversations(
    (recentRows ?? []) as ConversationRow[],
    new Date(),
  );

  return (
    // Keyed by conversation: the chat's state starts from these props, so
    // moving between conversations (or back to a new one) must remount it.
    <ChatView
      key={conversationId ?? (practiceId ? `practice-${practiceId}` : "new")}
      courseId={id}
      courseName={course.name}
      initialPolicyMode={(policy?.mode as string) ?? "guided"}
      initialConversationId={conversationId}
      initialMessages={initialMessages}
      recentConversations={recentConversations}
      initialInput={initialInput}
    />
  );
}
