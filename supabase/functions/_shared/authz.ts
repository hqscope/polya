// Ownership assertions for client-supplied ids that reach service-role writes.
// The service client bypasses RLS, so any id taken from a request body must be
// checked against the authenticated user before it is written under. Handlers
// that only *read* with an explicit `.eq("user_id", userId)` filter don't need
// these — they're for writes keyed on a client-supplied id.
import { HttpError } from "./auth-user.ts";
import { service } from "./service.ts";

export async function assertCourseOwned(userId: string, courseId: string): Promise<void> {
  const { data } = await service
    .from("polya_courses")
    .select("id")
    .eq("id", courseId)
    .eq("user_id", userId)
    .maybeSingle();
  // 404 for missing AND not-owned: don't reveal whether the id exists.
  if (!data) throw new HttpError("That course isn't in your library.", 404);
}

export async function assertConversationOwned(
  userId: string,
  conversationId: string,
  courseId: string,
): Promise<void> {
  const { data } = await service
    .from("polya_conversations")
    .select("user_id, course_id")
    .eq("id", conversationId)
    .maybeSingle();
  if (!data || data.user_id !== userId) {
    throw new HttpError("That conversation isn't available.", 404);
  }
  if (data.course_id !== courseId) {
    throw new HttpError("That conversation belongs to a different course.", 403);
  }
}

export function assertUserStoragePath(userId: string, storagePath: string): void {
  if (!storagePath.startsWith(`${userId}/`)) {
    throw new HttpError("That file isn't available.", 400);
  }
}
