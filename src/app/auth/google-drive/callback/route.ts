import { NextRequest, NextResponse } from "next/server";

import {
  copyResponseCookies,
  createRouteHandlerSupabaseClient,
} from "@/lib/supabase/server";
import { sanitizeNextPath } from "@/lib/auth/next-path";
import { callPolyaGoogle } from "@/lib/google-drive-server";
import {
  connectResultFor,
  decodeDriveFlow,
  DRIVE_CALLBACK_PATH,
  DRIVE_FLOW_COOKIE,
  DRIVE_FLOW_COOKIE_PATH,
  type DriveConnectResult,
  readDriveCallback,
  withDriveResult,
} from "@/lib/google-drive-connect";

// Google's redirect back after "Connect Google Drive". Checks the state
// against the flow cookie and that the same student is still signed in, then
// hands the code and PKCE verifier to polya-google `connect`, which exchanges
// them server-side and stores the grant. The browser only ever sees the
// one-time code. Always returns to the page with ?drive=<result>.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const flow = decodeDriveFlow(request.cookies.get(DRIVE_FLOW_COOKIE)?.value);
  const nextPath = sanitizeNextPath(flow?.next);
  const response = NextResponse.next();

  const finish = (result: DriveConnectResult) => {
    const redirect = NextResponse.redirect(
      new URL(withDriveResult(nextPath, result), request.url),
    );
    // One use per flow.
    redirect.cookies.set(DRIVE_FLOW_COOKIE, "", { path: DRIVE_FLOW_COOKIE_PATH, maxAge: 0 });
    return copyResponseCookies(response, redirect);
  };

  if (!flow) return finish("error");
  const callback = readDriveCallback(request.nextUrl.searchParams, flow.state);
  if (!callback.ok) return finish(callback.result);

  const supabase = createRouteHandlerSupabaseClient(request, response);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!user || user.id !== flow.uid || !session?.access_token) return finish("error");

  const { status, data } = await callPolyaGoogle(session.access_token, {
    action: "connect",
    code: callback.code,
    code_verifier: flow.verifier,
    redirect_uri: new URL(DRIVE_CALLBACK_PATH, request.nextUrl.origin).toString(),
  });
  return finish(connectResultFor(status, data.code));
}
