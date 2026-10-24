import { NextRequest, NextResponse } from "next/server";

import {
  copyResponseCookies,
  createRouteHandlerSupabaseClient,
} from "@/lib/supabase/server";
import { readHandoffTokenHash } from "@/lib/auth/handoff";
import { sanitizeNextPath } from "@/lib/auth/next-path";

// "Open in Polya" from the Scope extension (see polya-handoff). Redeems the
// one-time token for a session, then opens the page. A missing, used or
// expired token still opens the page: the app layout sends a signed-out
// visitor to sign in and back, and lets an already signed-in one straight in.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const nextPath = sanitizeNextPath(request.nextUrl.searchParams.get("next"));
  const tokenHash = readHandoffTokenHash(request.nextUrl.searchParams.get("token_hash"));
  const response = NextResponse.next();

  if (tokenHash) {
    const supabase = createRouteHandlerSupabaseClient(request, response);
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "email" });
    if (error) {
      console.warn("[auth/handoff] sign-in token not accepted:", error.code ?? error.message);
    }
  }

  const redirect = copyResponseCookies(
    response,
    NextResponse.redirect(new URL(nextPath, request.url)),
  );
  // The token is in this URL: keep it out of caches and Referer headers.
  redirect.headers.set("Cache-Control", "no-store");
  redirect.headers.set("Referrer-Policy", "no-referrer");
  return redirect;
}
