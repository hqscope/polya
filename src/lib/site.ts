import { normalizeSiteUrl } from "./seo";

const DEFAULT_NEXT_PATH = "/app";

export function sanitizeNextPath(raw: string | null | undefined): string {
  if (!raw) {
    return DEFAULT_NEXT_PATH;
  }

  // Internal, absolute-path-only redirects; reject protocol-relative and external URLs.
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    return DEFAULT_NEXT_PATH;
  }

  return raw;
}

export function resolveAuthCallbackBaseUrl(requestOrigin: string): string {
  // Normalize so a bare-host override (e.g. "askpolya.com") still yields a valid
  // absolute base for new URL("/auth/callback", base).
  const override = normalizeSiteUrl(process.env.NEXT_PUBLIC_SITE_URL);
  return override || requestOrigin;
}
