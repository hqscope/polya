import type { MetadataRoute } from "next";

import { absoluteUrl, siteUrl } from "@/lib/seo";

// One wildcard group on purpose: the policy is identical for every crawler,
// including AI crawlers (GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot,
// Google-Extended, …). Default-allow is the stance — per-bot groups would add
// churn as the crawler list changes without changing behavior.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/app/", "/auth/"] }],
    sitemap: absoluteUrl("/sitemap.xml"),
    host: siteUrl,
  };
}
