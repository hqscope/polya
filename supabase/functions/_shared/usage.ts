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

export const DAILY_TUTOR_LIMIT = 100;

export type UsageResult = {
  allowed: boolean;
  used: number;
  limit: number;
  // True when the meter itself couldn't be read, as opposed to the student
  // being over the limit. Callers show "try again" rather than "limit reached".
  unavailable: boolean;
};

// UTC day key (YYYY-MM-DD) — meter windows roll over at UTC midnight.
export function utcDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

// Atomically increment today's tutor counter and report whether this request
// is within the limit. Fail-closed: if the meter can't be read the request is
// refused, so an outage in metering can never turn into unmetered model spend.
export async function checkAndCountTutorUsage(
  userId: string,
  limit: number = DAILY_TUTOR_LIMIT,
): Promise<UsageResult> {
  let data: unknown;
  try {
    const result = await admin.rpc("polya_increment_usage", {
      p_user_id: userId,
      p_day: utcDay(),
    });
    if (result.error) {
      console.error("[polya-usage] polya_increment_usage failed:", result.error.message);
      return { allowed: false, used: 0, limit, unavailable: true };
    }
    data = result.data;
  } catch (error) {
    console.error("[polya-usage] polya_increment_usage threw:", error);
    return { allowed: false, used: 0, limit, unavailable: true };
  }

  const used = Number(data);
  if (data === null || data === undefined || !Number.isFinite(used)) {
    console.error("[polya-usage] polya_increment_usage returned no count");
    return { allowed: false, used: 0, limit, unavailable: true };
  }
  return { allowed: used <= limit, used, limit, unavailable: false };
}
