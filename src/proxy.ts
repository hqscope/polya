import { NextResponse, type NextRequest } from "next/server";

import { NEXT_PATH_HEADER, sanitizeNextPath } from "@/lib/auth/next-path";

// P-37: the app layout guards every /app page but can't see the URL, so a
// signed-out visit to a course always came back to the course list after
// sign-in. Hand the layout the requested path in a request header. No auth
// work happens here; the layout still decides who is signed in.
export function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  const query = new URLSearchParams(searchParams);
  query.delete("_rsc"); // the router's own cache-busting param
  const queryString = query.toString();
  const search = queryString ? `?${queryString}` : "";

  // Always overwrite, so a header sent by the browser never gets through.
  const headers = new Headers(request.headers);
  headers.set(NEXT_PATH_HEADER, sanitizeNextPath(`${pathname}${search}`));

  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/app", "/app/:path*"],
};
