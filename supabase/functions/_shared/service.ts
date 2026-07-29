import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
}

// Service-role client shared by polya edge functions. Bypasses RLS so functions
// can read the canvas-token table and write import rows on the user's behalf.
// Every query MUST filter by the authenticated user's id explicitly.
export const service = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

export const STORAGE_BUCKET = "polya_documents";
