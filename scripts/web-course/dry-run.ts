// Dry run of a course-website import against the real site, from your machine.
// Writes nothing to Supabase and downloads no files: it fetches the site's HTML
// pages (one request at a time, a pause between, robots.txt respected), runs
// the same crawler and source planner the import uses (course-site.ts), adds
// the due-date pass (site-assignments.ts), and writes a JSON manifest to
// data/web-course/<site>/manifest.json (data/ is gitignored).
//
//   node scripts/web-course/dry-run.ts https://ds100.org/fa26/ [--delay-ms 1500] [--save-html]
//
// --save-html also keeps each fetched page under data/web-course/<site>/pages/
// (for trimming test fixtures). Never commit anything from data/.
import { lookup } from "node:dns/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  crawlCourseSite,
  extractMainHtml,
  MAX_HTML_BYTES,
  normalizeSiteUrl,
  planSiteSources,
  titleParts,
} from "../../supabase/functions/_shared/course-site.ts";
import { fetchPublic } from "../../supabase/functions/_shared/safe-fetch.ts";
import {
  ALLOW_ALL_ROBOTS,
  assertPublicHost,
  notebookLinkToRaw,
  parseRobotsTxt,
  robotsAllows,
  type RobotsRules,
} from "../../supabase/functions/_shared/site-policy.ts";
import { extractAssignments, type SiteAssignment } from "../../supabase/functions/_shared/site-assignments.ts";

interface Args {
  url: string;
  delayMs: number;
  saveHtml: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { url: "", delayMs: 1500, saveHtml: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--delay-ms") args.delayMs = Math.max(500, Number(argv[++i]) || 1500);
    else if (arg === "--save-html") args.saveHtml = true;
    else if (!arg.startsWith("--")) args.url = arg;
  }
  if (!args.url) {
    console.error("usage: node scripts/web-course/dry-run.ts <course website URL> [--delay-ms 1500] [--save-html]");
    process.exit(2);
  }
  return args;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function resolveAll(hostname: string): Promise<string[]> {
  const answers = await lookup(hostname, { all: true });
  return answers.map((answer) => answer.address);
}

function siteSlug(startUrl: string): string {
  return startUrl.replace(/^https:\/\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startUrl = normalizeSiteUrl(args.url);
  const start = new URL(startUrl);
  const outDir = join(process.cwd(), "data", "web-course", siteSlug(startUrl));
  const pagesDir = join(outDir, "pages");
  mkdirSync(args.saveHtml ? pagesDir : outDir, { recursive: true });

  await assertPublicHost(start.hostname, resolveAll);

  // robots.txt: 4xx means no rules; a 5xx means "don't crawl right now".
  let robots: RobotsRules = ALLOW_ALL_ROBOTS;
  const robotsResponse = await fetchPublic(fetch, `${start.origin}/robots.txt`, {
    maxBytes: 512 * 1024,
    accept: "text/plain",
    allowRedirectHost: (host) => host === start.hostname,
  });
  if (robotsResponse.status >= 500) throw new Error(`robots.txt answered ${robotsResponse.status}; try later`);
  if (robotsResponse.status === 200) robots = parseRobotsTxt(new TextDecoder().decode(robotsResponse.bytes));
  if (!robotsAllows(robots, start.pathname)) throw new Error("robots.txt disallows this site for crawlers");
  console.log(`robots.txt: ${robotsResponse.status === 200 ? "rules found" : `none (${robotsResponse.status})`}`);

  const fetched: Array<{ url: string; status: number; bytes: number }> = [];
  const robotsBlocked: string[] = [];
  const notHtml: Array<{ url: string; status: number; contentType: string }> = [];
  const assignments = new Map<string, SiteAssignment>();
  const notebooks = new Map<string, { raw: string; text: string; page: string }>();
  const externalHosts = new Map<string, number>();

  // The crawler asks for pages several at a time; this gate serializes them
  // with a pause between requests so the site sees one polite visitor.
  let gate: Promise<void> = Promise.resolve();
  const fetchHtml = (url: string) => {
    const run = gate.then(async () => {
      const target = new URL(url);
      if (!robotsAllows(robots, `${target.pathname}${target.search}`)) {
        robotsBlocked.push(url);
        return null;
      }
      await sleep(args.delayMs);
      const response = await fetchPublic(fetch, url, {
        maxBytes: MAX_HTML_BYTES,
        accept: "text/html,application/xhtml+xml",
        // Stay on the course site; a redirect elsewhere isn't course content.
        allowRedirectHost: (host) => host === start.hostname,
      });
      fetched.push({ url, status: response.status, bytes: response.bytes.byteLength });
      process.stdout.write(`  ${response.status} ${url}\n`);
      if (response.status !== 200 || !/html/.test(response.contentType)) {
        notHtml.push({ url, status: response.status, contentType: response.contentType });
        return null;
      }
      const html = new TextDecoder().decode(response.bytes);
      if (args.saveHtml) {
        writeFileSync(join(pagesDir, `${siteSlug(url) || "index"}.html`), html);
      }
      inspectPage(html, new URL(response.url));
      return { url: response.url, html };
    });
    gate = run.then(() => undefined, () => undefined);
    return run;
  };

  function inspectPage(html: string, pageUrl: URL): void {
    const pageTitle = titleParts(html).page ?? "";
    for (const assignment of extractAssignments(extractMainHtml(html), { pageUrl, pageTitle })) {
      if (!assignments.has(assignment.key)) assignments.set(assignment.key, assignment);
    }
    for (const match of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      let link: URL;
      try {
        link = new URL(match[1]!.replace(/&amp;/g, "&"), pageUrl);
      } catch {
        continue;
      }
      const raw = notebookLinkToRaw(link.href);
      if (raw) {
        if (!notebooks.has(raw)) {
          const text = match[2]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
          notebooks.set(raw, { raw, text, page: pageUrl.href });
        }
        continue;
      }
      if (/^https?:$/.test(link.protocol) && link.hostname !== start.hostname) {
        externalHosts.set(link.hostname, (externalHosts.get(link.hostname) ?? 0) + 1);
      }
    }
  }

  console.log(`Crawling ${startUrl} (one request every ${args.delayMs} ms)…`);
  const crawl = await crawlCourseSite(startUrl, fetchHtml);
  const planned = planSiteSources(crawl, "<student>", "<course>").map((row) => ({
    origin: row.origin,
    source_kind: row.source_kind,
    canvas_id: row.canvas_id,
    title: row.title,
    module_name: row.module_name,
    canvas_url: row.canvas_url,
    content_role: row.content_role,
  }));

  const byOrigin: Record<string, number> = {};
  const byRole: Record<string, number> = {};
  for (const row of planned) {
    byOrigin[row.origin] = (byOrigin[row.origin] ?? 0) + 1;
    byRole[row.content_role] = (byRole[row.content_role] ?? 0) + 1;
  }
  const sortedAssignments = Array.from(assignments.values()).sort((a, b) => a.dueAt.localeCompare(b.dueAt));

  const manifest = {
    generated_at: new Date().toISOString(),
    start_url: startUrl,
    course_name: crawl.courseName,
    robots: { status: robotsResponse.status, sitemaps: robots.sitemaps },
    counts: {
      requests: fetched.length,
      pages_crawled: crawl.pages.filter((page) => page.crawled).length,
      leaf_pages: crawl.pages.filter((page) => !page.crawled).length,
      hosted_pdfs: crawl.files.length,
      google_files: crawl.googleFiles.length,
      planned_sources: planned.length,
      planned_by_origin: byOrigin,
      planned_by_role: byRole,
      assignments_with_due_dates: sortedAssignments.length,
      notebooks_linked: notebooks.size,
      robots_blocked: robotsBlocked.length,
      not_html_or_failed: notHtml.length,
    },
    assignments: sortedAssignments.map((a) => ({
      key: a.key,
      title: a.title,
      due_at: a.dueAt,
      time_given_on_site: a.timeGiven,
      links: a.links,
      page: a.pageUrl,
    })),
    // Not planned by the importer today: notebooks behind "open in DataHub" links.
    notebooks: Array.from(notebooks.values()),
    google_files_pending_drive: crawl.googleFiles.map((f) => ({ kind: f.ref.kind, id: f.ref.id, title: f.title })),
    planned_sources: planned,
    robots_blocked: robotsBlocked,
    not_html_or_failed: notHtml,
    external_hosts: Object.fromEntries(Array.from(externalHosts.entries()).sort((a, b) => b[1] - a[1])),
  };

  const out = join(outDir, "manifest.json");
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nWrote ${out}`);
  console.log(JSON.stringify(manifest.counts, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
