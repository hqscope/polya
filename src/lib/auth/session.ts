import { cache } from "react";

import { createServerSupabaseClient } from "@/lib/supabase/server-component";
import { isAuthOutage } from "@/lib/auth/outage";

export interface AuthenticatedAppUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

export const getAuthenticatedAppUser = cache(async () => {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  // A 5xx, a 402 (over quota) or a network failure means we couldn't confirm
  // the session either way — that's an outage, not a sign-out. Callers must
  // show a retry notice instead of redirecting to /login.
  if (isAuthOutage(error)) {
    return {
      supabase,
      user: null as AuthenticatedAppUser | null,
      error,
      outage: true as const,
    };
  }

  if (error || !user) {
    return {
      supabase,
      user: null as AuthenticatedAppUser | null,
      error,
      outage: false as const,
    };
  }

  const metadata = user.user_metadata ?? {};
  const displayName =
    (typeof metadata.full_name === "string" && metadata.full_name) ||
    (typeof metadata.name === "string" && metadata.name) ||
    user.email ||
    "Polya student";

  const avatarUrl =
    typeof metadata.avatar_url === "string" ? metadata.avatar_url : null;

  return {
    supabase,
    user: {
      id: user.id,
      email: user.email ?? "",
      displayName,
      avatarUrl,
    },
    error: null,
    outage: false as const,
  };
});
