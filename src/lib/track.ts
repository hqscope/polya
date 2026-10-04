import { getSupabaseConfig } from "@/lib/supabase/config";
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

// --- Active-user pings -----------------------------------------------------
//
// Separate from track() above on purpose. track() records *what* somebody did
// and gives up when there is no user; this records *that* somebody is here, and
// deliberately still fires when signed out, so the cross-product activity
// numbers cover anonymous sessions too.
//
// Sends a random per-browser id, the product, and the platform. Nothing else.

const ACTIVITY_PRODUCT = "polya";
const ACTIVITY_ANON_ID_KEY = "polya_anon_id";
const ACTIVITY_MIN_PING_INTERVAL_MS = 60 * 1000;

let lastActivityPingAt = 0;

function resolveAnonId(): string | null {
  try {
    const existing = window.localStorage.getItem(ACTIVITY_ANON_ID_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    window.localStorage.setItem(ACTIVITY_ANON_ID_KEY, created);
    return created;
  } catch {
    // Storage blocked (private mode, embedded context). Without a stable id
    // every ping would look like a new person, which is worse than not
    // counting at all — so skip rather than invent one per page load.
    return null;
  }
}

/**
 * Record that somebody is using Polya right now. Fire and forget; never throws.
 */
export function trackActivity(): void {
  try {
    const now = Date.now();
    if (lastActivityPingAt && now - lastActivityPingAt < ACTIVITY_MIN_PING_INTERVAL_MS) {
      return;
    }

    const anonId = resolveAnonId();
    if (!anonId) return;
    lastActivityPingAt = now;

    const { url, anonKey } = getSupabaseConfig();
    const supabase = createBrowserSupabaseClient();

    void supabase.auth
      .getSession()
      .then(({ data }) => data.session?.access_token ?? null)
      .catch(() => null)
      .then((accessToken) =>
        fetch(`${url.replace(/\/+$/, "")}/functions/v1/track-activity`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: anonKey,
            Authorization: `Bearer ${accessToken ?? anonKey}`,
          },
          body: JSON.stringify({
            product: ACTIVITY_PRODUCT,
            anonId,
            platform: "web",
          }),
          keepalive: true,
        }),
      )
      .then(undefined, () => {});
  } catch {
    // ignore — analytics must not break the product
  }
}
