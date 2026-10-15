// Service-role access to the shared Scope Supabase project. It bypasses RLS, so every query
// in this agent must filter by the linked student's user_id (see student.ts). The model never
// supplies a user_id: it always comes from the session's auth, set by the channel.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | undefined;

export function serviceDb(): SupabaseClient {
  if (client) return client;
  const url = process.env.POLYA_SUPABASE_URL;
  const key = process.env.POLYA_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("POLYA_SUPABASE_URL and POLYA_SUPABASE_SERVICE_ROLE_KEY are required");
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}
