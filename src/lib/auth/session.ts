import { cache } from "react";

import { createServerSupabaseClient } from "@/lib/supabase/server-component";

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

  if (error || !user) {
    return { supabase, user: null as AuthenticatedAppUser | null, error };
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
  };
});
