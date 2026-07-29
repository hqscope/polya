import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

if (!SUPABASE_URL || !ANON_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY env vars");
}

// Narrowed non-optional copies so downstream calls type-check under Deno.
const supabaseUrl: string = SUPABASE_URL;
const anonKey: string = ANON_KEY;

export class HttpError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

export type AuthenticatedUser = {
  id: string;
  email?: string | null;
};

export async function requireAuthUser(request: Request): Promise<AuthenticatedUser> {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.trim()) {
    throw new HttpError("Missing Authorization header", 401);
  }
  const accessToken = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!accessToken) {
    throw new HttpError("Missing bearer token", 401);
  }

  const client = createClient(supabaseUrl, anonKey, {
    global: {
      headers: {
        Authorization: authorization,
      },
    },
    auth: {
      persistSession: false,
    },
  });

  const { data, error } = await client.auth.getUser(accessToken);
  if (error || !data.user) {
    const reason = error?.message?.trim() || "Unable to resolve user from bearer token";
    throw new HttpError(`Unauthorized: ${reason}`, 401);
  }

  return { id: data.user.id, email: data.user.email };
}

// User-JWT-scoped client: queries run under RLS as the calling user.
export function createUserClient(request: Request) {
  const authorization = request.headers.get("Authorization") ?? "";
  return createClient(supabaseUrl, anonKey, {
    global: {
      headers: {
        Authorization: authorization,
      },
    },
    auth: {
      persistSession: false,
    },
  });
}
