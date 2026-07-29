import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

// Fire-and-forget product event. Never awaited in UI paths, never throws —
// analytics must not be able to break the product.
export function track(
  event: string,
  courseId?: string,
  properties?: Record<string, unknown>,
): void {
  try {
    const supabase = createBrowserSupabaseClient();
    void supabase.auth
      .getUser()
      .then(({ data: { user } }) => {
        if (!user) return;
        return supabase.from("polya_events").insert({
          user_id: user.id,
          event,
          course_id: courseId ?? null,
          properties: properties ?? {},
        });
      })
      .then(undefined, () => {});
  } catch {
    // ignore — see above
  }
}
