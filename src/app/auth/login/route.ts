import { NextRequest, NextResponse } from "next/server";

import {
  copyResponseCookies,
  createRouteHandlerSupabaseClient,
} from "@/lib/supabase/server";
import { resolveAuthCallbackBaseUrl } from "@/lib/site";
import { sanitizeNextPath } from "@/lib/auth/next-path";

function getCallbackUrl(request: NextRequest, nextPath: string): string {
  const baseUrl = resolveAuthCallbackBaseUrl(request.nextUrl.origin);
  const callbackUrl = new URL("/auth/callback", baseUrl);
  callbackUrl.searchParams.set("next", nextPath);
  return callbackUrl.toString();
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const nextPath = sanitizeNextPath(request.nextUrl.searchParams.get("next"));
  const response = NextResponse.next();
  const supabase = createRouteHandlerSupabaseClient(request, response);

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: getCallbackUrl(request, nextPath),
    },
  });

  if (error || !data.url) {
    const fallbackUrl = new URL("/login", request.url);
    fallbackUrl.searchParams.set("error", "oauth_start_failed");
    fallbackUrl.searchParams.set("next", nextPath);
    return copyResponseCookies(response, NextResponse.redirect(fallbackUrl));
  }

  return copyResponseCookies(response, NextResponse.redirect(data.url));
}
