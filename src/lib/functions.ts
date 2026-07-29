import { getSupabaseFunctionsUrl } from "@/lib/supabase/config";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

export class FunctionError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "FunctionError";
    this.code = code;
    this.status = status;
  }
}

async function authHeader(): Promise<string> {
  const supabase = createBrowserSupabaseClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new FunctionError("You're signed out. Please sign in again.", "signed_out", 401);
  }
  return `Bearer ${session.access_token}`;
}

// POST JSON to a polya edge function and parse the JSON reply, surfacing the
// function's user-safe { error, code } envelope as a FunctionError.
export async function invokeFunction<T>(
  name: string,
  body: Record<string, unknown>,
): Promise<T> {
  const authorization = await authHeader();
  const response = await fetch(`${getSupabaseFunctionsUrl()}/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
    },
    body: JSON.stringify(body),
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new FunctionError(
      typeof data.error === "string" ? data.error : "Something went wrong.",
      typeof data.code === "string" ? data.code : "internal",
      response.status,
    );
  }
  return data as T;
}
