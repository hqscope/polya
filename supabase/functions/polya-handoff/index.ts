// polya-handoff — a one-time sign-in token for the student the Scope extension
// is signed in as, so "Open in Polya" lands them in Polya already signed in.
// Scope and Polya share this project's accounts; what the browser lacks is a
// Polya session. The extension opens askpolya.com/auth/handoff with the token,
// and that route redeems it with verifyOtp.
//
// The token is GoTrue's magic-link hash from auth.admin.generateLink, which
// sends no email. It works once and expires with the project's email OTP
// expiry. Never log it.
import { corsHeaders, json } from "../_shared/cors.ts";
import { HttpError, requireAuthUser } from "../_shared/auth-user.ts";
import { service } from "../_shared/service.ts";
import { claimRateLimit, rateLimitedResponse } from "../_shared/rate-limit.ts";
import {
  HANDOFF_HOURLY_BUCKET,
  HANDOFF_HOURLY_LIMIT,
  HOUR_SECONDS,
} from "../_shared/polya-rate-limits.ts";

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed.", code: "method_not_allowed" }, 405);
  }
  try {
    const user = await requireAuthUser(request);
    if (!user.email) {
      return json({ error: "This account has no email to sign in with.", code: "no_email" }, 409);
    }

    const withinLimit = await claimRateLimit(
      service,
      `user:${user.id}`,
      HANDOFF_HOURLY_BUCKET,
      HANDOFF_HOURLY_LIMIT,
      HOUR_SECONDS,
    );
    if (!withinLimit) {
      return rateLimitedResponse({ headers: corsHeaders });
    }

    const { data, error } = await service.auth.admin.generateLink({
      type: "magiclink",
      email: user.email,
    });
    const tokenHash = data?.properties?.hashed_token;
    // Emails are unique per project, but the token must belong to the caller.
    if (error || !tokenHash || data.user?.id !== user.id) {
      console.error(
        "[polya-handoff] no token:",
        error?.message ?? (tokenHash ? "user mismatch" : "empty response"),
      );
      return json({ error: "Couldn't sign in to Polya.", code: "handoff_failed" }, 502);
    }

    return json({ token_hash: tokenHash });
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message, code: "unauthorized" }, error.status);
    }
    console.error("[polya-handoff] error:", error instanceof Error ? error.message : error);
    return json({ error: "Couldn't sign in to Polya.", code: "internal" }, 500);
  }
});
