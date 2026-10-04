import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { NEXT_PATH_HEADER, loginPathFor } from "@/lib/auth/next-path";

/**
 * Sends a signed-out visitor to sign in, then back to the /app page they asked
 * for (P-37). The path comes from `src/proxy.ts`; anything missing or unsafe
 * falls back to `/app`.
 */
export async function redirectToLogin(): Promise<never> {
  const requestHeaders = await headers();
  redirect(loginPathFor(requestHeaders.get(NEXT_PATH_HEADER)));
}
