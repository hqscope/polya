// Bearer-token check for /mcp. Tokens come from Supabase Auth's OAuth server
// (ChatGPT / Claude sign the student in through Polya), so they are ordinary
// Supabase user tokens: validating with Supabase Auth is enough, and the same
// token then reads data under the student's row-level security.
import { createClient } from "@supabase/supabase-js";

import { getSupabaseConfig } from "@/lib/supabase/config";

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

export type TokenCheck = { ok: true; userId: string } | { ok: false; outage: boolean };

export async function verifyAccessToken(token: string): Promise<TokenCheck> {
  const { url, anonKey } = getSupabaseConfig();
  const auth = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).auth;
  const { data, error } = await auth.getUser(token);
  if (data.user) return { ok: true, userId: data.user.id };
  // A 5xx or network failure means auth couldn't answer, not that the token is bad.
  const status = (error as { status?: number } | null)?.status;
  return { ok: false, outage: status === undefined || status >= 500 };
}
