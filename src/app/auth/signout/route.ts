import { NextRequest, NextResponse } from "next/server";

import {
  copyResponseCookies,
  createRouteHandlerSupabaseClient,
} from "@/lib/supabase/server";

async function performSignOut(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.next();
  const supabase = createRouteHandlerSupabaseClient(request, response);

  await supabase.auth.signOut();

  return copyResponseCookies(
    response,
    NextResponse.redirect(new URL("/", request.url)),
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return performSignOut(request);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return performSignOut(request);
}
