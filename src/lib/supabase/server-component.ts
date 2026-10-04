import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

import { getSupabaseConfig } from "@/lib/supabase/config";
import { createFailFastAuthFetch } from "@/lib/supabase/fail-fast-auth-fetch";

// A session refresh that can't reach auth fails in ~2.5 s instead of being
// retried for ~26 s (P-36). Safe here because this client can't write cookies.
const failFastAuthFetch = createFailFastAuthFetch();

export async function createServerSupabaseClient() {
  const cookieStore = await cookies();
  const { url, anonKey } = getSupabaseConfig();

  return createServerClient(url, anonKey, {
    global: { fetch: failFastAuthFetch },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server components cannot always mutate cookies; route handlers own refresh.
        }
      },
    },
  });
}
