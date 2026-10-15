// Server-side calls from the Google Drive connect routes to the polya-google
// edge function, as the signed-in student (their Supabase access token).
// Route handlers only: the token never reaches the browser from here.
import { getSupabaseFunctionsUrl } from "@/lib/supabase/config";

export async function callPolyaGoogle(
  accessToken: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  try {
    const response = await fetch(`${getSupabaseFunctionsUrl()}/polya-google`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const data = (await response.json().catch(() => ({}))) as unknown;
    return {
      status: response.status,
      data: data && typeof data === "object" ? (data as Record<string, unknown>) : {},
    };
  } catch {
    return { status: 502, data: { code: "unavailable" } };
  }
}
