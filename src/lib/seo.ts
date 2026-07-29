// Single source of truth for the public site's SEO surface: canonical origin,
// shared copy, and the list of indexable routes. Consumed by page metadata,
// robots.ts, sitemap.ts, structured-data.ts, and scripts/indexnow-ping.ts —
// keep this module free of `next` imports so plain Node (tests, scripts) can
// load it.

// Normalize a configured site origin: ensure it carries a scheme and drop any
// trailing slash. NEXT_PUBLIC_SITE_URL is often set to a bare host (e.g.
// "askpolya.com"), which `new URL()` rejects — prepend https:// so metadataBase
// and absoluteUrl() never throw at build time. Empty input → "".
export function normalizeSiteUrl(value: string | null | undefined): string {
  const trimmed = value?.trim().replace(/\/+$/, "") ?? "";
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export const siteUrl =
  normalizeSiteUrl(process.env.NEXT_PUBLIC_SITE_URL) || "https://askpolya.com";

export const siteName = "Polya";
export const orgName = "Canvascope Inc.";
export const contactEmail = "hello@askpolya.com";

export const siteDescription =
  "Polya is an AI tutor that knows your courses and walks you through the work — hints, steps, and explanations that build understanding instead of handing you answers.";

export const landingTitle = "Polya — the AI tutor that knows your course";

export const landingDescription =
  "A course-aware AI tutor for your Canvas classes — hints, steps, and worked examples from your actual course materials, with a citation on every answer.";

// Every indexable public route, in sitemap order. sitemap.ts and the IndexNow
// ping derive from this list — keep it equal to the routes that actually ship.
export const PUBLIC_PATHS = [
  "/",
  "/how-it-works",
  "/for-instructors",
  "/login",
  "/privacy",
  "/terms",
  "/contact",
] as const;

export function absoluteUrl(path: string): string {
  return new URL(path, siteUrl).href;
}

// Spread into each page's `openGraph` — Next replaces nested metadata objects
// wholesale (no deep merge), so every page must carry the full object.
export const defaultOpenGraph = {
  siteName,
  locale: "en_US",
  type: "website",
} as const;
