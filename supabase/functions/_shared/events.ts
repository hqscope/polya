// Server-side product events, written with the service role. Best-effort:
// analytics never fails a request.
import { service } from "./service.ts";

export async function trackServer(
  userId: string,
  event: string,
  courseId?: string | null,
  properties?: Record<string, unknown>,
): Promise<void> {
  try {
    await service.from("polya_events").insert({
      user_id: userId,
      event,
      course_id: courseId ?? null,
      properties: properties ?? {},
    });
  } catch (error) {
    console.warn(`[polya] event insert failed (${event}):`, error);
  }
}
