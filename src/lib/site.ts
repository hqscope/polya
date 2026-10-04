import { normalizeSiteUrl } from "./seo";

export function resolveAuthCallbackBaseUrl(requestOrigin: string): string {
  // Normalize so a bare-host override (e.g. "askpolya.com") still yields a valid
  // absolute base for new URL("/auth/callback", base).
  const override = normalizeSiteUrl(process.env.NEXT_PUBLIC_SITE_URL);
  return override || requestOrigin;
}
