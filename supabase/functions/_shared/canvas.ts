// Canvas REST client — port of the extension's background.js endpoint map
// (fetchWithRetry / parseLinkNext / fetchAllPages / normalizeRichText /
// fetchCourseFilesForImport), swapped from session-cookie transport to a
// user-supplied personal access token. Pure module: standard fetch only.

export class CanvasAuthError extends Error {
  constructor(message = "Canvas rejected the access token") {
    super(message);
    this.name = "CanvasAuthError";
  }
}

export class CanvasHttpError extends Error {
  status: number;

  constructor(status: number, url: string) {
    super(`Canvas request failed (${status}) for ${url}`);
    this.name = "CanvasHttpError";
    this.status = status;
  }
}

export class CanvasUrlError extends Error {
  constructor(message = "That doesn't look like a Canvas web address.") {
    super(message);
    this.name = "CanvasUrlError";
  }
}

const MAX_PAGES = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface NormalizeBaseUrlOptions {
  // Local-only escape hatch for the mock-Canvas integration test
  // (POLYA_ALLOW_INSECURE_CANVAS). Never enabled in the deployed project.
  allowInsecure?: boolean;
}

// The normalized URL is fetched server-side with the stored token, so this is
// an SSRF boundary: https only, public hostnames only. Hostname-pattern
// filtering is the extent of what the edge runtime allows — DNS pinning /
// rebinding defense is not practical here (documented in ARCHITECTURE.md).
export function normalizeBaseUrl(raw: string, opts?: NormalizeBaseUrlOptions): string {
  const allowInsecure = opts?.allowInsecure ?? false;
  let value = String(raw || "").trim();
  if (!value) throw new CanvasUrlError("Missing Canvas URL");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CanvasUrlError();
  }

  if (url.protocol !== "https:" && !(allowInsecure && url.protocol === "http:")) {
    throw new CanvasUrlError("Canvas connections must use https.");
  }
  if (url.username || url.password) throw new CanvasUrlError();
  if (url.port && !allowInsecure) throw new CanvasUrlError();

  const hostname = url.hostname.toLowerCase();
  const isIpLike =
    hostname.startsWith("[") || hostname.includes(":") || // IPv6
    /^[0-9.]+$/.test(hostname) || /^0x/i.test(hostname); // IPv4 / numeric forms
  const isInternalName =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa") ||
    !hostname.includes("."); // bare intranet names
  if ((isIpLike || isInternalName) && !allowInsecure) throw new CanvasUrlError();

  return `${url.protocol}//${url.host}`;
}

export function parseLinkNext(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const parts = linkHeader.split(",");
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1]!;
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTML → text (Pages, syllabus, assignment descriptions). DOM-free port of
// normalizeRichText: entity decode + block-aware stripping.
// ---------------------------------------------------------------------------
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

export function stripHtmlToText(value: unknown): string {
  const html = String(value ?? "");
  if (!html.trim()) return "";

  const withBreaks = html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|tr|table|ul|ol|blockquote|section|article)\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n• ")
    .replace(/<[^>]+>/g, " ");

  return decodeEntities(withBreaks)
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeRichText(
  value: unknown,
  maxChars = 60_000,
): { text: string | null; truncated: boolean } {
  const stripped = stripHtmlToText(value);
  if (!stripped) {
    return { text: null, truncated: false };
  }
  if (stripped.length <= maxChars) {
    return { text: stripped, truncated: false };
  }
  return {
    text: `${stripped.slice(0, maxChars).trimEnd()}…`,
    truncated: true,
  };
}

// Pull Canvas file ids referenced inside a page/assignment HTML body. Recovers
// files that are linked from a page (e.g. "Lab 1 Lecture Slides") even when the
// course's flat Files index is hidden from students. Matches the file-link
// shapes Canvas emits: instructure_file_link anchors, data-api-endpoint, and
// bare /files/:id or /courses/:cid/files/:id hrefs.
export function extractCanvasFileIds(html: unknown): string[] {
  const text = String(html ?? "");
  if (!text) return [];
  const ids = new Set<string>();
  const patterns = [
    /\/api\/v1\/courses\/\d+\/files\/(\d+)/g,
    /\/courses\/\d+\/files\/(\d+)/g,
    /\/files\/(\d+)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) ids.add(match[1]!);
  }
  return Array.from(ids);
}

// Pull Kaltura media entry ids referenced inside course HTML. Lecture videos
// embedded on a page arrive as LTI iframes (external_tools/retrieve?url=…
// browseandembed…/entryid/1_xxxx, often URL-encoded) or as player embeds/data
// attributes. Entry ids look like 0_/1_ + 8 base36 chars; matching is anchored
// to an entryid-ish context so random tokens in prose can't false-positive.
export function extractKalturaEntryIds(html: unknown): string[] {
  const text = String(html ?? "");
  if (!text) return [];
  const ids = new Set<string>();
  const patterns = [
    /entryid(?:%2F|\/|=|%3D)([01]_[a-z0-9]{8})/gi, // browseandembed paths (raw or URL-encoded)
    /entry_id[=/]([01]_[a-z0-9]{8})/gi, // player embed query params
    /data-entryid=["']([01]_[a-z0-9]{8})["']/gi,
    /["']entryId["']\s*:\s*["']([01]_[a-z0-9]{8})["']/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) ids.add(match[1]!.toLowerCase());
  }
  return Array.from(ids);
}

// ---------------------------------------------------------------------------
// Folder paths (port of buildIndexedPathMetadata / fetchCourseFilesForImport)
// ---------------------------------------------------------------------------
export function splitPathSegments(rawPath: string): string[] {
  return String(rawPath || "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export interface CanvasFolderMeta {
  folderPath: string;
  pathSegments: string[];
  name: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
export interface CanvasCourse {
  id: string;
  name: string;
  code: string;
  termName: string | null;
  startAt: string | null;
  endAt: string | null;
}

export interface CanvasPdfFile {
  fileId: string;
  title: string;
  downloadUrl: string;
  folderPath: string;
  moduleName: string | null;
  sizeBytes: number | null;
  updatedAt: string | null;
}

export interface CanvasPageStub {
  pageId: string;
  urlSlug: string;
  title: string;
  htmlUrl: string | null;
  updatedAt: string | null;
}

export interface CanvasAssignmentStub {
  assignmentId: string;
  title: string;
  descriptionHtml: string | null;
  htmlUrl: string | null;
  dueAt: string | null;
  updatedAt: string | null;
}

// A single item inside a Canvas module. Modules are the reliable way to
// enumerate a course when the flat Pages/Files index APIs are hidden from
// students (the instructor pushes content through Modules instead).
export interface CanvasModuleItem {
  type: string; // Page | File | Assignment | Quiz | Discussion | SubHeader | ExternalUrl | ...
  title: string;
  moduleName: string | null;
  pageUrl: string | null; // slug, for type === "Page"
  fileId: string | null; // content_id, for type === "File"
  contentId: string | null; // content_id for Assignment/Quiz/Discussion
  htmlUrl: string | null;
  externalUrl: string | null; // for ExternalUrl/ExternalTool items (e.g. a lecture-video link)
}

// An LTI tool available in a course (e.g. the media gallery). `domain`/`url`
// identify the provider; `id` feeds the sessionless launch API.
export interface CanvasExternalTool {
  id: string;
  name: string;
  url: string | null;
  domain: string | null;
}

// A course navigation tab. `hidden` means the instructor removed it from the
// student nav — useful both as an import diagnostic ("Files is hidden, expect
// the flat index to 403") and to spot external-tool tabs like Media Gallery.
export interface CanvasTab {
  id: string;
  label: string;
  type: string; // "internal" | "external"
  hidden: boolean;
}

// File metadata resolved by id (for module- or page-discovered files whose flat
// listing is blocked).
export interface CanvasFileMeta {
  fileId: string;
  title: string;
  downloadUrl: string;
  contentType: string;
  sizeBytes: number | null;
  isPdf: boolean;
}

export class CanvasClient {
  readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, accessToken: string, opts?: NormalizeBaseUrlOptions) {
    this.baseUrl = normalizeBaseUrl(baseUrl, opts);
    this.token = String(accessToken || "").trim();
    if (!this.token) throw new Error("Missing Canvas access token");
  }

  private headers(): HeadersInit {
    return { Authorization: `Bearer ${this.token}` };
  }

  // Resilient fetch: exponential backoff + Retry-After for 429/5xx and network
  // errors; immediate failure (no retry) on 401/403/404. 401 → CanvasAuthError.
  async fetchWithRetry(url: string, maxRetries = 3): Promise<Response> {
    let attempt = 0;
    while (attempt < maxRetries) {
      let resp: Response;
      try {
        resp = await fetch(url, { headers: this.headers() });
      } catch (error) {
        attempt++;
        if (attempt >= maxRetries) throw error;
        await sleep(Math.pow(2, attempt) * 1000 + Math.random() * 500);
        continue;
      }

      if (resp.ok) return resp;
      if (resp.status === 401) throw new CanvasAuthError();

      if (resp.status === 429 || resp.status >= 500) {
        attempt++;
        if (attempt >= maxRetries) return resp;

        let delayMs = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        const retryAfter = resp.headers.get("Retry-After");
        if (retryAfter) {
          const parsed = Number.parseInt(retryAfter, 10);
          if (!Number.isNaN(parsed)) delayMs = parsed * 1000;
        }
        await resp.body?.cancel();
        await sleep(delayMs);
        continue;
      }

      // 403/404 and other client errors: fail fast, caller decides.
      return resp;
    }
    throw new Error(`Failed to fetch ${url} after ${maxRetries} attempts`);
  }

  async fetchJson<T>(url: string): Promise<T> {
    const resp = await this.fetchWithRetry(url);
    if (!resp.ok) throw new CanvasHttpError(resp.status, url);
    return (await resp.json()) as T;
  }

  // Follows `Link: rel="next"` with a safety cap (port of fetchAllPages).
  async fetchAllPages<T>(url: string): Promise<T[]> {
    const allItems: T[] = [];
    let nextUrl: string | null = url;
    let page = 0;

    while (nextUrl && page < MAX_PAGES) {
      page++;
      const resp = await this.fetchWithRetry(nextUrl);
      if (!resp.ok) {
        if (allItems.length === 0) throw new CanvasHttpError(resp.status, nextUrl);
        break;
      }

      const items = (await resp.json()) as unknown;
      if (!Array.isArray(items) || items.length === 0) break;

      allItems.push(...(items as T[]));
      nextUrl = parseLinkNext(resp.headers.get("Link"));
    }

    return allItems;
  }

  async getSelf(): Promise<{ id: string; name: string }> {
    const data = await this.fetchJson<{ id: number | string; name?: string; short_name?: string }>(
      `${this.baseUrl}/api/v1/users/self`,
    );
    return {
      id: String(data.id),
      name: String(data.name || data.short_name || "Canvas user"),
    };
  }

  async listCourses(): Promise<CanvasCourse[]> {
    interface RawCourse {
      id: number | string;
      name?: string;
      course_code?: string;
      term?: { name?: string };
      start_at?: string | null;
      end_at?: string | null;
    }
    const data = await this.fetchAllPages<RawCourse>(
      `${this.baseUrl}/api/v1/courses?per_page=100&enrollment_state=active&include[]=term`,
    );
    return data
      .filter((course) => course.id && course.name)
      .map((course) => ({
        id: String(course.id),
        name: String(course.name),
        code: String(course.course_code ?? ""),
        termName: course.term?.name ?? null,
        startAt: course.start_at ?? null,
        endAt: course.end_at ?? null,
      }));
  }

  async getCourseSyllabusText(courseId: string): Promise<string | null> {
    return (await this.getCourseSyllabusRaw(courseId)).text;
  }

  // Raw syllabus fetch: stripped text for embedding plus the raw HTML body so
  // the processor can scan it for embedded file links and lecture videos.
  async getCourseSyllabusRaw(
    courseId: string,
  ): Promise<{ text: string | null; html: string | null }> {
    const detail = await this.fetchJson<{ syllabus_body?: string | null }>(
      `${this.baseUrl}/api/v1/courses/${courseId}?include[]=term&include[]=syllabus_body`,
    );
    const html = detail?.syllabus_body ?? null;
    return { text: normalizeRichText(html).text, html };
  }

  // LTI tools reachable from this course (include_parents pulls in the
  // account-level installs, which is where media galleries usually live).
  async listExternalTools(courseId: string): Promise<CanvasExternalTool[]> {
    interface RawTool {
      id: number | string;
      name?: string;
      url?: string | null;
      domain?: string | null;
    }
    const tools = await this.fetchAllPages<RawTool>(
      `${this.baseUrl}/api/v1/courses/${courseId}/external_tools?per_page=100&include_parents=true`,
    );
    return tools
      .filter((tool) => tool.id != null)
      .map((tool) => ({
        id: String(tool.id),
        name: String(tool.name ?? ""),
        url: tool.url ?? null,
        domain: tool.domain ?? null,
      }));
  }

  // One-time launch URL for an LTI tool. Fetching it (no auth needed — it
  // carries its own verifier) returns the auto-submitting launch form.
  async getSessionlessLaunchUrl(courseId: string, toolId: string): Promise<string | null> {
    const data = await this.fetchJson<{ url?: string | null }>(
      `${this.baseUrl}/api/v1/courses/${courseId}/external_tools/sessionless_launch?id=${encodeURIComponent(toolId)}`,
    );
    return data?.url ?? null;
  }

  async listTabs(courseId: string): Promise<CanvasTab[]> {
    interface RawTab {
      id?: string;
      label?: string;
      type?: string;
      hidden?: boolean;
    }
    const tabs = await this.fetchJson<RawTab[]>(
      `${this.baseUrl}/api/v1/courses/${courseId}/tabs?per_page=100`,
    );
    if (!Array.isArray(tabs)) return [];
    return tabs.map((tab) => ({
      id: String(tab.id ?? ""),
      label: String(tab.label ?? ""),
      type: String(tab.type ?? "internal"),
      hidden: tab.hidden === true,
    }));
  }

  // Folder map + PDF files (port of fetchCourseFilesForImport).
  async listPdfFiles(courseId: string): Promise<CanvasPdfFile[]> {
    interface RawFolder {
      id: number | string;
      name?: string;
      full_name?: string;
    }
    interface RawFile {
      id: number | string;
      display_name?: string;
      filename?: string;
      "content-type"?: string;
      content_type?: string;
      folder_id?: number | string;
      size?: number;
      updated_at?: string;
      modified_at?: string;
    }

    const folderMap = new Map<string, CanvasFolderMeta>();
    try {
      const folders = await this.fetchAllPages<RawFolder>(
        `${this.baseUrl}/api/v1/courses/${courseId}/folders?per_page=100`,
      );
      for (const folder of folders) {
        const isRoot = /^course files?$/i.test(String(folder.name || "").trim());
        const fullName = String(folder.full_name || "")
          .replace(/^course files\/?/i, "")
          .trim();
        const segments = splitPathSegments(fullName);
        if (segments.length === 0 && !isRoot && folder.name) {
          segments.push(String(folder.name).trim());
        }
        folderMap.set(String(folder.id), {
          folderPath: segments.join(" > "),
          pathSegments: segments,
          name: isRoot ? "Files" : String(folder.name || segments[segments.length - 1] || "Files"),
        });
      }
    } catch {
      // Folder metadata is best-effort; files still import without paths.
    }

    const moduleNameByFileId = await this.mapModuleNamesForFiles(courseId);

    const items = await this.fetchAllPages<RawFile>(
      `${this.baseUrl}/api/v1/courses/${courseId}/files?per_page=100`,
    );

    const files: CanvasPdfFile[] = [];
    for (const item of items) {
      const name = String(item.display_name || item.filename || "");
      const ext = name.split(".").pop()?.toLowerCase();
      const contentType = String(item["content-type"] || item.content_type || "").toLowerCase();
      const isPdf = ext === "pdf" || contentType.includes("pdf");
      if (!isPdf) continue;

      const folder = folderMap.get(String(item.folder_id ?? ""));
      files.push({
        fileId: String(item.id),
        title: name.replace(/\.pdf$/i, "").trim() || name,
        downloadUrl: `${this.baseUrl}/files/${item.id}/download?download_frd=1`,
        folderPath: folder?.folderPath ?? "",
        moduleName: moduleNameByFileId.get(String(item.id)) ?? null,
        sizeBytes: typeof item.size === "number" ? item.size : null,
        updatedAt: item.updated_at ?? item.modified_at ?? null,
      });
    }
    return files;
  }

  // All items across all modules, normalized. Modules reflect exactly what a
  // student can navigate to, so this recovers Pages and Files that the flat
  // /pages and /files index APIs hide when the instructor disables those tabs.
  async listModuleItems(courseId: string): Promise<CanvasModuleItem[]> {
    interface RawModuleItem {
      type?: string;
      title?: string;
      content_id?: number | string;
      page_url?: string;
      html_url?: string;
      external_url?: string;
    }
    interface RawModule {
      name?: string;
      items?: RawModuleItem[];
    }

    const modules = await this.fetchAllPages<RawModule>(
      `${this.baseUrl}/api/v1/courses/${courseId}/modules?per_page=50&include[]=items&include[]=content_details`,
    );

    const out: CanvasModuleItem[] = [];
    for (const module of modules) {
      const moduleName = String(module.name || "").trim() || null;
      if (!Array.isArray(module.items)) continue;
      for (const item of module.items) {
        const type = String(item.type || "");
        const contentId = item.content_id != null ? String(item.content_id) : null;
        out.push({
          type,
          title: String(item.title || "").trim(),
          moduleName,
          pageUrl: type === "Page" && item.page_url ? String(item.page_url) : null,
          fileId: type === "File" ? contentId : null,
          contentId,
          htmlUrl: item.html_url ?? null,
          externalUrl: item.external_url ? String(item.external_url) : null,
        });
      }
    }
    return out;
  }

  // Module structure: maps Canvas file IDs → module name (instructional grouping).
  private async mapModuleNamesForFiles(courseId: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      for (const item of await this.listModuleItems(courseId)) {
        if (item.type === "File" && item.fileId && item.moduleName) {
          map.set(item.fileId, item.moduleName);
        }
      }
    } catch {
      // Modules are enrichment only here.
    }
    return map;
  }

  // Resolve a file by id → title + a token-authenticated download URL. Used for
  // files discovered via modules or embedded in page bodies (whose flat listing
  // may be blocked). The /files/:id/download?download_frd=1 shape is downloaded
  // with the Bearer header (see downloadFile).
  async getFileMeta(courseId: string, fileId: string): Promise<CanvasFileMeta | null> {
    interface RawFile {
      display_name?: string;
      filename?: string;
      "content-type"?: string;
      content_type?: string;
      size?: number;
    }
    const urls = [
      `${this.baseUrl}/api/v1/courses/${courseId}/files/${fileId}`,
      `${this.baseUrl}/api/v1/files/${fileId}`,
    ];
    for (const url of urls) {
      try {
        const file = await this.fetchJson<RawFile>(url);
        const name = String(file.display_name || file.filename || "").trim();
        const contentType = String(file["content-type"] || file.content_type || "").toLowerCase();
        const ext = name.split(".").pop()?.toLowerCase();
        return {
          fileId,
          title: name.replace(/\.pdf$/i, "").trim() || name || `File ${fileId}`,
          downloadUrl: `${this.baseUrl}/files/${fileId}/download?download_frd=1`,
          contentType,
          sizeBytes: typeof file.size === "number" ? file.size : null,
          isPdf: ext === "pdf" || contentType.includes("pdf"),
        };
      } catch {
        // try the next URL shape
      }
    }
    return null;
  }

  async listPages(courseId: string): Promise<CanvasPageStub[]> {
    interface RawPage {
      page_id?: number | string;
      url?: string;
      title?: string;
      html_url?: string;
      updated_at?: string;
      published?: boolean;
    }
    const pages = await this.fetchAllPages<RawPage>(
      `${this.baseUrl}/api/v1/courses/${courseId}/pages?per_page=100`,
    );
    return pages
      .filter((page) => page.url && page.title && page.published !== false)
      .map((page) => ({
        pageId: String(page.page_id ?? page.url),
        urlSlug: String(page.url),
        title: String(page.title),
        htmlUrl: page.html_url ?? null,
        updatedAt: page.updated_at ?? null,
      }));
  }

  // Raw page fetch: returns both the stripped text (for embedding) and the raw
  // HTML body (for scanning embedded file links).
  async getPageRaw(
    courseId: string,
    urlSlug: string,
  ): Promise<{ text: string | null; html: string | null }> {
    const page = await this.fetchJson<{ body?: string | null }>(
      `${this.baseUrl}/api/v1/courses/${courseId}/pages/${encodeURIComponent(urlSlug)}`,
    );
    const html = page?.body ?? null;
    return { text: normalizeRichText(html).text, html };
  }

  async getPageText(courseId: string, urlSlug: string): Promise<string | null> {
    return (await this.getPageRaw(courseId, urlSlug)).text;
  }

  async listAssignments(courseId: string): Promise<CanvasAssignmentStub[]> {
    interface RawAssignment {
      id: number | string;
      name?: string;
      description?: string | null;
      html_url?: string;
      due_at?: string | null;
      updated_at?: string;
    }
    const assignments = await this.fetchAllPages<RawAssignment>(
      `${this.baseUrl}/api/v1/courses/${courseId}/assignments?per_page=100`,
    );
    return assignments
      .filter((assignment) => assignment.id && assignment.name)
      .map((assignment) => ({
        assignmentId: String(assignment.id),
        title: String(assignment.name),
        descriptionHtml: assignment.description ?? null,
        htmlUrl: assignment.html_url ?? null,
        dueAt: assignment.due_at ?? null,
        updatedAt: assignment.updated_at ?? null,
      }));
  }

  async downloadFile(downloadUrl: string): Promise<ArrayBuffer> {
    const resp = await this.fetchWithRetry(downloadUrl);
    if (!resp.ok) throw new CanvasHttpError(resp.status, downloadUrl);
    return await resp.arrayBuffer();
  }
}
