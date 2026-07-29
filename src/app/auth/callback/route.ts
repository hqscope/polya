import { NextRequest, NextResponse } from "next/server";

import {
  copyResponseCookies,
  createRouteHandlerSupabaseClient,
} from "@/lib/supabase/server";
import { sanitizeNextPath } from "@/lib/site";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const nextPath = sanitizeNextPath(request.nextUrl.searchParams.get("next"));
  const code = request.nextUrl.searchParams.get("code");
  const response = NextResponse.next();

  if (!code) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("error", "missing_code");
    loginUrl.searchParams.set("next", nextPath);
    return copyResponseCookies(response, NextResponse.redirect(loginUrl));
  }

  const supabase = createRouteHandlerSupabaseClient(request, response);
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("error", "auth_callback_failed");
    loginUrl.searchParams.set("next", nextPath);
    return copyResponseCookies(response, NextResponse.redirect(loginUrl));
  }

  return copyResponseCookies(
    response,
    NextResponse.redirect(new URL(nextPath, request.url)),
  );
}
