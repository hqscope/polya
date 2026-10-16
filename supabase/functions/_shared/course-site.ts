// Course website import: crawl a public course site (e.g. a Berkeley class
// site such as ds100.org/fa26) into sources — its pages, the PDFs it hosts,
// and the Google Drive / Slides / Docs files it links. Pure module (no Deno
// globals; the page fetcher is injected) so Node's test runner covers it.
//
// Crawl scope: pages on the start URL's host whose path is under the start
// path ("the prefix") are fetched and followed. Same-host pages outside the
// prefix that an in-prefix page links (shared course notes, a debugging guide)
// are queued as sources but not followed further. Pages on other hosts are
// ignored; files they link are not — PDFs on any host, Google Drive / Slides /
// Docs (linked or embedded), and Jupyter notebooks (GitHub or "open in
// DataHub" links) all become sources.
import { decodeEntities, stripHtmlToText } from "./canvas.ts";
import { classifyContentRole, type ContentRole } from "./content-roles.ts";
import { diffSources, type EnumeratedSource, type ExistingSourceRow, type SourceDiff } from "./enumerate.ts";
import { assertPublicUrl, UnsafeUrlError } from "./safe-fetch.ts";
import { type GoogleFileRef, googleSourceKey, googleViewUrl, parseGoogleFileLink } from "./google-drive.ts";
import { notebookLinkToRaw } from "./site-policy.ts";

/** In-prefix pages fetched while enumerating (a term's site is ~50). */
export const MAX_CRAWL_PAGES = 120;
/** Same-host pages outside the prefix, queued but never followed. */
export const MAX_LEAF_PAGES = 60;
/** PDFs taken from any one page — a past-exams index can list 150+, newest first. */
export const MAX_FILES_PER_PAGE = 40;
/** Everything one site import may queue. */
export const MAX_SITE_SOURCES = 400;
/** A page body larger than this isn't read (rendered notes pages run ~3 MB). */
export const MAX_HTML_BYTES = 8 * 1024 * 1024;
/** Hosted PDFs larger than this aren't downloaded. */
export const MAX_SITE_FILE_BYTES = 50 * 1024 * 1024;
/** Notebooks are JSON and may carry saved outputs (which are dropped). */
export const MAX_NOTEBOOK_BYTES = 20 * 1024 * 1024;
// A few pages at a time: class sites are small static hosts, and a burst gets
// throttled.
const CRAWL_CONCURRENCY = 4;

export class SiteUrlError extends Error {
  constructor(message = "That doesn't look like a course website address.") {
    super(message);
    this.name = "SiteUrlError";
  }
}

/**
 * Normalizes a pasted course-site address: https, public host, no hash or
 * query, and a directory-looking path ends in "/" ("ds100.org/fa26" →
 * "https://ds100.org/fa26/").
 */
export function normalizeSiteUrl(raw: string): string {
  let value = String(raw ?? "").trim();
  if (!value) throw new SiteUrlError("Paste your course website's address.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = assertPublicUrl(value.replace(/^http:\/\//i, "https://"));
  } catch (error) {
    if (error instanceof UnsafeUrlError) throw new SiteUrlError();
    throw error;
  }
  return canonicalPageUrl(url);
}

/** Page identity: no hash or query, "index.html" dropped, directory paths end in "/". */
export function canonicalPageUrl(url: URL): string {
  let path = url.pathname.replace(/\/index\.html?$/i, "/");
  const last = path.split("/").pop() ?? "";
  if (last && !last.includes(".")) path += "/";
  return `${url.protocol}//${url.host.toLowerCase()}${path}`;
}

/** The directory everything in-scope lives under. */
export function sitePrefix(startUrl: string): string {
  return startUrl.endsWith("/") ? startUrl : startUrl.slice(0, startUrl.lastIndexOf("/") + 1);
}

export interface SiteLink {
  url: string;
  text: string;
}

/** The page's main content, so nav menus and footers don't become links or text. */
export function extractMainHtml(html: string): string {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main) return main[1]!;
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return body ? body[1]! : html;
}

function tagText(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Every <iframe>/<embed> src in the HTML (Google Sites and many class sites embed slides this way). */
export function extractEmbeds(html: string, pageUrl: string): SiteLink[] {
  const out: SiteLink[] = [];
  const re = /<(?:iframe|embed)\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const src = decodeEntities((match[1] ?? match[2] ?? "").trim());
    if (!src) continue;
    try {
      out.push({ url: new URL(src, pageUrl).toString(), text: "" });
    } catch {
      // not a usable address
    }
  }
  return out;
}

/** Every <a href> in the HTML, resolved against the page URL. */
export function extractLinks(html: string, pageUrl: string): SiteLink[] {
  const out: SiteLink[] = [];
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const href = decodeEntities((match[1] ?? match[2] ?? "").trim());
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(href)) continue;
    let resolved: string;
    try {
      resolved = new URL(href, pageUrl).toString();
    } catch {
      continue;
    }
    out.push({ url: resolved, text: tagText(match[3] ?? "").slice(0, 200) });
  }
  return out;
}

export function firstHeading(html: string): string | null {
  const match = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const text = match ? tagText(match[1]!) : "";
  return text || null;
}

/** <title> split on " | " / " – " / " — ": [page part, site part]. */
export function titleParts(html: string): { page: string | null; site: string | null } {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = match ? tagText(match[1]!) : "";
  if (!title) return { page: null, site: null };
  const parts = title.split(/\s+[|–—]\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return { page: title, site: null };
  return { page: parts[0]!, site: parts[parts.length - 1]! };
}

/** The readable text of a page's main content. */
export function pageMainText(html: string): string {
  return stripHtmlToText(katexToTex(extractMainHtml(html)));
}

// KaTeX writes each formula three times — MathML, its TeX source, and a
// visual copy — which would read as "θ \theta θ" and triple a math-heavy
// chunk. Keep the TeX once, as "$\theta$".
export function katexToTex(html: string): string {
  if (!html.includes("katex")) return html;
  const tex = html.replace(/<math\b[\s\S]*?<\/math>/gi, (math) => {
    const source = math.match(/<annotation\b[^>]*encoding="application\/x-tex"[^>]*>([\s\S]*?)<\/annotation>/i);
    return source ? ` $${source[1]!.trim()}$ ` : " ";
  });
  return removeSpansWithClass(tex, "katex-html");
}

// Drops every <span class="…cls…">…</span>, nested spans included.
function removeSpansWithClass(html: string, cls: string): string {
  const open = new RegExp(`<span\\b[^>]*\\bclass="[^"]*\\b${cls}\\b[^"]*"[^>]*>`, "gi");
  let out = "";
  let index = 0;
  let match: RegExpExecArray | null;
  while ((match = open.exec(html)) !== null) {
    out += html.slice(index, match.index);
    const tag = /<\/?span\b[^>]*>/gi;
    tag.lastIndex = open.lastIndex;
    let depth = 1;
    let end = html.length;
    let t: RegExpExecArray | null;
    while ((t = tag.exec(html)) !== null) {
      depth += t[0][1] === "/" ? -1 : 1;
      if (depth === 0) {
        end = tag.lastIndex;
        break;
      }
    }
    index = end;
    open.lastIndex = end;
  }
  return out + html.slice(index);
}

// Link text that only makes sense next to its page ("Slides" on the OLS
// lecture page), so the source title is prefixed with the page title.
const GENERIC_LINK_TEXT =
  /^(slides?|annotated slides|worksheet|solutions?|notebook|jupyter notebook|notes|handout|pdf|link|here|download|code|demo|video|recording|reading|view|open)$/i;

export function titleForLink(linkText: string, pageTitle: string | null, fallback: string): string {
  const text = linkText.trim();
  if (!text) return pageTitle ? pageTitle : fallback;
  if (pageTitle && GENERIC_LINK_TEXT.test(text)) return `${pageTitle} — ${text}`;
  return text;
}

// Hosted PDFs in a table ("Exam", "(Solutions)", "Midterm 2") say more in
// their file name ("su26 final sols"), so short link text yields to it.
function pdfTitle(linkText: string, url: string): string {
  const text = linkText.replace(/^\((.*)\)$/, "$1").trim();
  return text.split(/\s+/).filter(Boolean).length >= 3 ? text : fileNameTitle(url);
}

function fileNameTitle(url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  return name.replace(/\.(pdf|ipynb)$/i, "").replace(/[_-]+/g, " ").trim() || "Course file";
}

/**
 * The raw file behind a notebook link: an "open in DataHub" (nbgitpuller)
 * link, a GitHub file page, or a raw GitHub file. Null for anything else.
 */
export function notebookRawUrl(link: string): string | null {
  const viaHub = notebookLinkToRaw(link);
  if (viaHub) return /\.ipynb$/i.test(new URL(viaHub).pathname) ? viaHub : null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (!/\.ipynb$/i.test(url.pathname)) return null;
  const host = url.hostname.toLowerCase();
  if (host === "raw.githubusercontent.com") return `https://${host}${url.pathname}`;
  if (host === "github.com") {
    const [owner, repo, kind, ...rest] = url.pathname.split("/").filter(Boolean);
    if (owner && repo && (kind === "blob" || kind === "raw") && rest.length >= 2) {
      return `https://raw.githubusercontent.com/${[owner, repo, ...rest].join("/")}`;
    }
  }
  return null;
}

/** The GitHub page for a raw notebook, for "Open original". */
export function notebookViewUrl(rawUrl: string): string {
  const [owner, repo, ...rest] = new URL(rawUrl).pathname.split("/").filter(Boolean);
  return owner && repo && rest.length >= 2 ? `https://github.com/${owner}/${repo}/blob/${rest.join("/")}` : rawUrl;
}

// Same-host links to things that aren't pages or PDFs (images, datasets,
// styles) — skipped.
const NON_PAGE_EXT = /\.(?!html?$)[a-z0-9]{1,6}$/i;

export type LinkTarget =
  | { type: "page"; url: string; inPrefix: boolean }
  | { type: "pdf"; url: string }
  | { type: "google"; ref: GoogleFileRef }
  | { type: "notebook"; rawUrl: string }
  | { type: "skip" };

export function classifyLink(rawUrl: string, startUrl: string): LinkTarget {
  const google = parseGoogleFileLink(rawUrl);
  if (google) return { type: "google", ref: google };
  const notebook = notebookRawUrl(rawUrl);
  if (notebook) return { type: "notebook", rawUrl: notebook };

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { type: "skip" };
  }
  const start = new URL(startUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") return { type: "skip" };
  // http is upgraded; the fetch itself is https-only.
  url.protocol = "https:";

  // A PDF the course links is course material wherever it's hosted.
  if (/\.pdf$/i.test(url.pathname)) {
    return { type: "pdf", url: `${url.protocol}//${url.host.toLowerCase()}${url.pathname}` };
  }
  if (url.host.toLowerCase() !== start.host.toLowerCase()) return { type: "skip" };
  if (NON_PAGE_EXT.test(url.pathname)) return { type: "skip" };

  const canonical = canonicalPageUrl(url);
  const prefix = sitePrefix(startUrl);
  if (canonical.startsWith(prefix)) return { type: "page", url: canonical, inPrefix: true };
  // An ancestor of the prefix (the site root, "all offerings") is out of scope.
  if (prefix.startsWith(canonical)) return { type: "skip" };
  return { type: "page", url: canonical, inPrefix: false };
}

export interface CrawledPage {
  url: string;
  title: string;
  /** False for same-host pages outside the prefix, queued but never fetched here. */
  crawled: boolean;
}

export interface CrawledFile {
  url: string;
  title: string;
  /** Title of the page it was linked from (for grouping). */
  pageTitle: string | null;
}

export interface CrawledGoogleFile {
  ref: GoogleFileRef;
  title: string;
  pageTitle: string | null;
}

export interface CrawledNotebook {
  rawUrl: string;
  title: string;
  pageTitle: string | null;
}

export interface SiteCrawl {
  startUrl: string;
  /** Best name for the course: the start page's heading, else the site part of its <title>. */
  courseName: string | null;
  pages: CrawledPage[];
  files: CrawledFile[];
  googleFiles: CrawledGoogleFile[];
  notebooks: CrawledNotebook[];
  /** True when the time budget or page cap stopped the crawl before the queue emptied. */
  truncated: boolean;
}

/** Returns the page's HTML and final URL, or null when it couldn't be read as HTML. */
export type FetchHtml = (url: string) => Promise<{ url: string; html: string } | null>;

export interface CrawlOptions {
  /** Stop starting new pages after this time (ms epoch); what's found so far is kept. */
  deadline?: number;
  now?: () => number;
  /** Whether a same-host address may be read (robots.txt). Defaults to everything. */
  allows?: (url: string) => boolean;
}

/** The start page couldn't be read. */
export class SiteUnreachableError extends Error {
  constructor() {
    super("We couldn't open that website.");
    this.name = "SiteUnreachableError";
  }
}

/**
 * Breadth-first crawl from the start URL, a few pages at a time. Order is
 * deterministic (batch results are handled in queue order), so the first page
 * to link a file names it.
 */
export async function crawlCourseSite(
  startUrl: string,
  fetchHtml: FetchHtml,
  opts: CrawlOptions = {},
): Promise<SiteCrawl> {
  const now = opts.now ?? Date.now;
  const allows = opts.allows ?? (() => true);
  const startHost = new URL(startUrl).host.toLowerCase();
  // robots.txt speaks for its own host only.
  const allowed = (url: string) => new URL(url).host.toLowerCase() !== startHost || allows(url);
  const queue: string[] = [startUrl];
  const queued = new Set(queue);
  const pages: CrawledPage[] = [];
  const leaves = new Map<string, CrawledPage>();
  const files = new Map<string, CrawledFile>();
  const googleFiles = new Map<string, CrawledGoogleFile>();
  const notebooks = new Map<string, CrawledNotebook>();
  let courseName: string | null = null;

  while (queue.length > 0 && pages.length < MAX_CRAWL_PAGES) {
    if (pages.length > 0 && opts.deadline !== undefined && now() >= opts.deadline) break;
    const batch = queue.splice(0, Math.min(CRAWL_CONCURRENCY, MAX_CRAWL_PAGES - pages.length));
    const results = await Promise.all(batch.map((url) => fetchHtml(url).catch(() => null)));

    for (let i = 0; i < batch.length; i++) {
      const requested = batch[i]!;
      const result = results[i];
      const isStart = requested === startUrl;
      if (!result) {
        if (isStart) throw new SiteUnreachableError();
        continue;
      }
      const { html } = result;
      const parts = titleParts(html);
      const heading = firstHeading(html);
      if (isStart) courseName = heading ?? parts.site ?? parts.page;
      // The start page's heading is usually the course name; its <title> says what the page is.
      const pageTitle = (isStart ? parts.page ?? heading : heading ?? parts.page) ?? fileNameTitle(requested);
      pages.push({ url: requested, title: pageTitle, crawled: true });

      let pdfsFromPage = 0;
      // Links come from the whole page: class sites keep Syllabus / Resources /
      // Past Exams in a nav outside <main>. Off-site footer links are skipped
      // by classifyLink.
      for (const link of [...extractLinks(html, result.url), ...extractEmbeds(html, result.url)]) {
        const target = classifyLink(link.url, startUrl);
        if ((target.type === "page" || target.type === "pdf") && !allowed(target.url)) continue;
        if (target.type === "page") {
          if (target.inPrefix) {
            if (!queued.has(target.url)) {
              queued.add(target.url);
              queue.push(target.url);
            }
          } else if (!leaves.has(target.url) && leaves.size < MAX_LEAF_PAGES) {
            leaves.set(target.url, { url: target.url, title: link.text || fileNameTitle(target.url), crawled: false });
          }
        } else if (target.type === "pdf") {
          if (files.has(target.url) || pdfsFromPage >= MAX_FILES_PER_PAGE) continue;
          pdfsFromPage++;
          files.set(target.url, { url: target.url, title: pdfTitle(link.text, target.url), pageTitle });
        } else if (target.type === "google") {
          const key = googleSourceKey(target.ref);
          if (googleFiles.has(key)) continue;
          googleFiles.set(key, {
            ref: target.ref,
            title: titleForLink(link.text, pageTitle, "Course file"),
            pageTitle,
          });
        } else if (target.type === "notebook") {
          if (notebooks.has(target.rawUrl)) continue;
          notebooks.set(target.rawUrl, {
            rawUrl: target.rawUrl,
            title: titleForLink(link.text, pageTitle, fileNameTitle(target.rawUrl)),
            pageTitle,
          });
        }
      }
    }
  }

  // A leaf that turned out to be in the crawl (linked both ways) is a crawled page.
  const crawledUrls = new Set(pages.map((page) => page.url));
  const leafPages = Array.from(leaves.values()).filter((leaf) => !crawledUrls.has(leaf.url));

  return {
    startUrl,
    courseName,
    pages: [...pages, ...leafPages],
    files: Array.from(files.values()),
    googleFiles: Array.from(googleFiles.values()),
    notebooks: Array.from(notebooks.values()),
    truncated: queue.length > 0,
  };
}

const TITLE_MAX = 300;

function siteRole(title: string, pageTitle: string | null): ContentRole {
  if (/\bsyllabus\b/i.test(title)) return "syllabus";
  return classifyContentRole({ title, moduleName: pageTitle });
}

// Homework, lab and project notebooks are work to do, not reading.
function notebookRole(nb: CrawledNotebook): ContentRole {
  const role = siteRole(nb.title, nb.pageTitle);
  if (role !== "material") return role;
  return /\/(hw|homework|labs?|proj|projects?)[^/]*\//i.test(new URL(nb.rawUrl).pathname) ? "assignment" : "material";
}

/**
 * The crawl as queued polya_sources rows, highest value first and capped at
 * MAX_SITE_SOURCES: crawled pages, linked Google files, notebooks, same-host
 * pages outside the prefix (shared course notes), then PDFs. canvas_id holds
 * each source's stable identity — the address it's fetched from (page, file,
 * or raw notebook URL), or "slides:<id>" for Google files — so a re-import
 * diffs against it like a Canvas id; canvas_url is where "Open original" goes.
 * Notebooks are site_page rows: the pump turns them into text like a page.
 */
export function planSiteSources(crawl: SiteCrawl, userId: string, courseId: string): EnumeratedSource[] {
  const base = {
    user_id: userId,
    course_id: courseId,
    folder_path: null,
    size_bytes: null,
    canvas_updated_at: null,
    due_at: null,
    status: "queued" as const,
  };
  const page = (p: CrawledPage): EnumeratedSource => ({
    ...base,
    origin: "site_page",
    source_kind: "html",
    canvas_id: p.url,
    title: p.title.slice(0, TITLE_MAX),
    module_name: "Course website",
    canvas_url: p.url,
    content_role: siteRole(p.title, null),
  });
  const crawled = crawl.pages.filter((p) => p.crawled).map(page);
  const leaves = crawl.pages.filter((p) => !p.crawled).map(page);
  const google = crawl.googleFiles.map((f): EnumeratedSource => ({
    ...base,
    origin: "drive_file",
    source_kind: "pdf",
    canvas_id: googleSourceKey(f.ref),
    title: f.title.slice(0, TITLE_MAX),
    module_name: f.pageTitle,
    canvas_url: googleViewUrl(f.ref),
    content_role: siteRole(f.title, f.pageTitle),
  }));
  const notebooks = crawl.notebooks.map((nb): EnumeratedSource => ({
    ...base,
    origin: "site_page",
    source_kind: "html",
    canvas_id: nb.rawUrl,
    title: nb.title.slice(0, TITLE_MAX),
    module_name: nb.pageTitle,
    canvas_url: notebookViewUrl(nb.rawUrl),
    content_role: notebookRole(nb),
  }));
  const hosted = crawl.files.map((f): EnumeratedSource => ({
    ...base,
    origin: "site_file",
    source_kind: "pdf",
    canvas_id: f.url,
    title: f.title.slice(0, TITLE_MAX),
    module_name: f.pageTitle,
    canvas_url: f.url,
    content_role: siteRole(f.title, f.pageTitle),
  }));
  return [...crawled, ...google, ...notebooks, ...leaves, ...hosted].slice(0, MAX_SITE_SOURCES);
}

/**
 * "new": queue only what isn't there yet (a student adding the site).
 * "force": re-check everything ("Check for updates"; hash-compared, so
 * unchanged items keep their passages). "auto": the scheduled check queues
 * anything new and re-checks the site's own pages — small, and where weekly
 * links and notices change — but leaves notes, notebooks and files to a
 * manual check.
 */
export type SiteImportMode = "new" | "force" | "auto";

export function diffSiteSources(
  planned: EnumeratedSource[],
  existing: ExistingSourceRow[],
  mode: SiteImportMode,
  startUrl: string,
): SourceDiff {
  if (mode !== "auto") return diffSources(planned, existing, mode === "force");
  const prefix = sitePrefix(startUrl);
  const ownPage = (row: { origin: string; canvas_id: string | null }) =>
    row.origin === "site_page" && (row.canvas_id ?? "").startsWith(prefix);
  const pages = diffSources(planned.filter(ownPage), existing.filter(ownPage), true);
  const rest = diffSources(planned.filter((r) => !ownPage(r)), existing.filter((r) => !ownPage(r)), false);
  return {
    toInsert: [...pages.toInsert, ...rest.toInsert],
    toRefresh: [...pages.toRefresh, ...rest.toRefresh],
    toPatch: [...pages.toPatch, ...rest.toPatch],
  };
}
