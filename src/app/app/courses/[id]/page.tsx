import { redirect } from "next/navigation";

import { getAuthenticatedAppUser } from "@/lib/auth/session";
import ChatView from "@/components/chat/ChatView";
import type { ChatMessage } from "@/components/chat/MessageBubble";

export const metadata = { title: "Study" };

export default async function CoursePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ c?: string }>;
}) {
  const { user, supabase } = await getAuthenticatedAppUser();
  if (!user) {
    redirect("/login?next=/app");
  }
  const { id } = await params;
  const { c: conversationId } = await searchParams;

  const [{ data: course }, { data: policy }] = await Promise.all([
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
  ]);

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

  return (
    <ChatView
      courseId={id}
      courseName={course.name}
      initialPolicyMode={(policy?.mode as string) ?? "guided"}
      initialConversationId={conversationId}
      initialMessages={initialMessages}
    />
  );
}
