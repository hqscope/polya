import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
}

// Service-role client: bypasses RLS for the tables authenticated users can't
// touch directly (canvas connections, usage metering, import writes).
export const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
  },
});

export const DAILY_TUTOR_LIMIT = 300;

export type UsageResult = {
  allowed: boolean;
  used: number;
  limit: number;
};

// UTC day key (YYYY-MM-DD) — meter windows roll over at UTC midnight.
export function utcDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

// Atomically increment today's tutor counter and report whether this request
// is within the limit. Fail-open: a metering error never blocks the student.
export async function checkAndCountTutorUsage(
  userId: string,
  limit: number = DAILY_TUTOR_LIMIT,
): Promise<UsageResult> {
  const { data, error } = await admin.rpc("polya_increment_usage", {
    p_user_id: userId,
    p_day: utcDay(),
  });

  if (error) {
    console.error("[polya-usage] polya_increment_usage failed:", error.message);
    return { allowed: true, used: 0, limit };
  }

  const used = Number(data ?? 0);
  return { allowed: used <= limit, used, limit };
}
