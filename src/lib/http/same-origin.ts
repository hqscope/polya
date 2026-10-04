import type { NextRequest } from "next/server";

/**
 * True when the request's Origin (falling back to Referer) header matches
 * this request's own origin. Used to keep state-changing GET-turned-POST
 * routes (like /auth/signout) from being triggered by a cross-site link or
 * form on another page.
 */
export function isSameOriginRequest(request: NextRequest): boolean {
  const candidate = request.headers.get("origin") ?? request.headers.get("referer");
  if (!candidate) return false;

  try {
    return new URL(candidate).origin === request.nextUrl.origin;
  } catch {
    return false;
  }
}
