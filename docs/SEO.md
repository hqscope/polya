# SEO & AI-engine optimization — operator runbook

What ships in the repo: full metadata (canonicals, Open Graph + generated OG
image, Twitter card), `robots.txt`, `sitemap.xml`, web manifest, JSON-LD
structured data (Organization / WebSite / SoftwareApplication / FAQPage),
`llms.txt` for AI answer engines, an IndexNow key + ping script, and the
public pages (`/`, `/how-it-works`, `/for-instructors`, `/login`, `/privacy`,
`/terms`, `/contact`). Everything derives its URLs from
`NEXT_PUBLIC_SITE_URL` (fallback `https://askpolya.com`) via `src/lib/seo.ts`
— new public pages must be added to `PUBLIC_PATHS` there.

The steps below need dashboard access and are one-time unless noted.

## 1. One-time setup

1. **Make the apex domain primary** — Vercel → project → Settings → Domains:
   set `askpolya.com` as the primary domain so `www.askpolya.com` redirects to
   it (today it's the other way around). All canonicals/sitemap URLs point at
   the apex, so this must match.
2. **Set `NEXT_PUBLIC_SITE_URL=https://askpolya.com`** in the Vercel
   production environment (it also feeds the auth callback base).
3. **Email forwarding for `hello@askpolya.com`** (~5 min) — Cloudflare Email
   Routing or ImprovMX, forwarding to a real inbox. The address appears on
   `/contact`, in the privacy/terms pages, and in the Organization structured
   data — mail to it must not bounce.
4. **Google Search Console** — <https://search.google.com/search-console>:
   add property `askpolya.com` (domain property needs a DNS TXT record;
   URL-prefix property can use the meta tag). For the meta-tag route: choose
   HTML-tag verification, copy the `content` token into
   `GOOGLE_SITE_VERIFICATION` in Vercel env, redeploy, click Verify. Then:
   - Sitemaps → submit `https://askpolya.com/sitemap.xml`
   - URL inspection → inspect `https://askpolya.com/` → Request indexing
5. **Bing Webmaster Tools** — <https://www.bing.com/webmasters>: easiest is
   "Import from Google Search Console". Otherwise verify via meta tag: put the
   `msvalidate.01` token into `BING_SITE_VERIFICATION`, redeploy, verify, and
   submit the sitemap. (Bing's index feeds ChatGPT search and other AI
   engines — don't skip it.)
6. **Google OAuth consent screen** — Google Cloud console → OAuth consent
   screen: set the privacy policy URL to `https://askpolya.com/privacy` and
   terms to `https://askpolya.com/terms`. Required for a verified consent
   screen; the links also show on the sign-in dialog.
   ⚠️ The privacy/terms pages are working drafts written from what the
   product actually does — have them reviewed before relying on them.

## 2. After deploys that change public pages

- `npm run seo:indexnow` — pings IndexNow (Bing/Yandex/etc.) with every URL
  in `PUBLIC_PATHS`. Safe to run repeatedly.
- If Open Graph copy or the OG image changed, re-scrape the preview caches:
  [Facebook Sharing Debugger](https://developers.facebook.com/tools/debug/)
  and [LinkedIn Post Inspector](https://www.linkedin.com/post-inspector/).

## 3. What NOT to do

Mass directory submissions, "free backlink sites" lists, link farms, paid
backlink packages, and reciprocal-link schemes are **link spam** under
Google's spam policies. At best they're ignored; at worst they earn a manual
action against a brand-new domain that has no authority to spare. Links must
be earned by things people want to link to — never planted.

## 4. Legitimate distribution (earned links & mentions)

- Product Hunt launch; Show HN on Hacker News.
- Student and instructor communities **where self-promotion rules allow it**
  (read each community's rules first).
- The Canvas Community forum — instructors actively discuss AI policy there.
- University student newspapers (they cover study tools every semester).
- The George Pólya / *How to Solve It* angle is a genuinely good pitch for
  education newsletters and teaching-and-learning centers.
- Ask early users to share honestly on their own channels; never buy reviews.

## 5. Monitoring & maintenance

- Search Console: check Coverage and Queries monthly; watch for pages Google
  chose not to index and for the queries that actually convert.
- After a Next.js upgrade, re-check `curl` of `/robots.txt`, `/sitemap.xml`,
  `/manifest.webmanifest`, `/llms.txt`, and view-source of `/` for the
  JSON-LD block.
- `PUBLIC_PATHS` in `src/lib/seo.ts` must always equal the shipped public
  routes; `llms.txt` lists the same pages — update both when pages change.
- FAQ content lives in `src/lib/content/faq.ts` and feeds both the visible
  section and the FAQPage schema — edit there only. (Note: Google rarely
  shows FAQ rich results for non-gov/health sites since 2023; the schema's
  value is for AI answer engines and entity understanding.)
- Future, when they exist: add social profiles to `sameAs` in
  `src/lib/structured-data.ts` and a handle to `twitter.site` metadata; spin
  `/for-instructors` content out further (syllabus policy templates, an
  instructor onboarding guide) when there's genuinely distinct material.
