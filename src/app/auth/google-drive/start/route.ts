import { NextRequest, NextResponse } from "next/server";

import {
  copyResponseCookies,
  createRouteHandlerSupabaseClient,
} from "@/lib/supabase/server";
import { loginPathFor, sanitizeNextPath } from "@/lib/auth/next-path";
import { callPolyaGoogle } from "@/lib/google-drive-server";
import {
  buildDriveAuthUrl,
  createPkcePair,
  DRIVE_CALLBACK_PATH,
  DRIVE_FLOW_COOKIE,
  DRIVE_FLOW_COOKIE_PATH,
  DRIVE_FLOW_MAX_AGE_SECONDS,
  type DriveConnectResult,
  encodeDriveFlow,
  randomUrlSafe,
  withDriveResult,
} from "@/lib/google-drive-connect";

// Starts "Connect Google Drive": asks polya-google whether this student may
// connect (and for the Drive client id), remembers state + PKCE verifier in a
// short-lived httpOnly cookie, and sends the browser to Google's consent page.
// See src/lib/google-drive-connect.ts for the whole flow.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const nextPath = sanitizeNextPath(request.nextUrl.searchParams.get("next"));
  const response = NextResponse.next();
  const supabase = createRouteHandlerSupabaseClient(request, response);

  const back = (result: DriveConnectResult) =>
    copyResponseCookies(
      response,
      NextResponse.redirect(new URL(withDriveResult(nextPath, result), request.url)),
    );

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!user || !session?.access_token) {
    return copyResponseCookies(
      response,
      NextResponse.redirect(new URL(loginPathFor(nextPath), request.url)),
    );
  }

  const { status, data } = await callPolyaGoogle(session.access_token, { action: "status" });
  if (status !== 200) return back("error");
  const clientId = typeof data.client_id === "string" ? data.client_id : null;
  const scopes = Array.isArray(data.scopes)
    ? data.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
  if (data.access !== "full" || !clientId || scopes.length === 0) return back("unavailable");

  const { verifier, challenge } = await createPkcePair();
  const state = randomUrlSafe(24);
  // Same origin as this request, so the callback sees the cookie set below.
  const redirectUri = new URL(DRIVE_CALLBACK_PATH, request.nextUrl.origin).toString();

  const redirect = NextResponse.redirect(
    buildDriveAuthUrl({ clientId, redirectUri, scopes, codeChallenge: challenge, state }),
  );
  redirect.cookies.set(
    DRIVE_FLOW_COOKIE,
    encodeDriveFlow({ state, verifier, next: nextPath, uid: user.id }),
    {
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      // Lax: sent on Google's top-level redirect back to the callback.
      sameSite: "lax",
      path: DRIVE_FLOW_COOKIE_PATH,
      maxAge: DRIVE_FLOW_MAX_AGE_SECONDS,
    },
  );
  return copyResponseCookies(response, redirect);
}
