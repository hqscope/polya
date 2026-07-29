import type { MetadataRoute } from "next";

import { absoluteUrl, PUBLIC_PATHS } from "@/lib/seo";

// No lastModified/changeFrequency/priority: an always-fresh lastmod is
// provably false on every crawl, and the other two are ignored signals.
export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_PATHS.map((path) => ({ url: absoluteUrl(path) }));
}
