// Kaltura media-gallery adapter: reach the lecture videos a course hosts behind
// the Kaltura LTI tool and pull their transcripts (caption assets and vendor
// transcript attachments) so they can be ingested like any other material.
//
// Access path, confirmed by live probe against Berkeley's KMS/KAF:
//   1. Canvas sessionless_launch → one-time URL → LTI 1.3 login/redirect dance
//      (auto-submitting forms + redirects) → lands on the KMS host, which JS-
//      redirects to the course channel page /channel/{courseId}/{categoryId}.
//   2. From the channel page read partnerId, the gallery category id, and the
//      visible media entry ids (server-rendered into the page).
//   3. Every KMS-issued client KS is URI-restricted (EXCEEDED_RESTRICTED_URI),
//      so instead open an anonymous *widget session* for the partner — enough
//      to read entry metadata, caption assets, and transcript attachments — and
//      download each asset via getUrl → CDN.
//
// Runtime-agnostic (global fetch, no Deno APIs) so Node's test runner covers
// the pure parsers directly. KAF deployments vary, so the dance records a
// status-only diagnostics trail — never a session token or cookie.
import { decodeEntities } from "./canvas.ts";

// Marks a fetch/dance failure the import pump may retry later (network, 5xx,
// rate limit). Duck-typed `transient` matches the pump's isTransient check.
export class KalturaTransientError extends Error {
  readonly transient = true;
  constructor(message: string) {
    super(message);
    this.name = "KalturaTransientError";
  }
}

export type TranscriptKind =
  | "transcript_srt"
  | "transcript_vtt"
  | "transcript_json"
  | "transcript_txt";

export interface KalturaSession {
  // Kaltura API endpoint (SaaS: https://www.kaltura.com).
  serviceUrl: string;
  partnerId: string;
  // Anonymous widget-session KS used for all API reads. Not entitlement-bearing
  // and short-lived; kept in memory only, never persisted or logged.
  widgetKs: string;
  // Gallery category id (from the channel URL) — a best-effort listing hint.
  categoryId: string | null;
  // Media entry ids server-rendered into the channel/gallery page. This is the
  // reliable enumeration source (anonymous category listing is entitlement-
  // gated and returns nothing).
  entryIds: string[];
  // Step-by-step trail (names + status codes only; no secrets).
  diagnostics: string[];
}

export interface KalturaMediaEntry {
  entryId: string;
  title: string;
  durationMs: number | null;
  updatedAt: string | null; // ISO
}

export interface KalturaTranscriptFile {
  kind: TranscriptKind;
  bytes: ArrayBuffer;
  // e.g. "captions (srt, English)" / "attachment lecture7.txt" — for logs only.
  label: string;
}

// ---------------------------------------------------------------------------
// Media-gallery tool discovery (pure)
// ---------------------------------------------------------------------------
export interface ExternalToolInfo {
  id: string;
  name: string;
  url: string | null;
  domain: string | null;
}

// Kaltura installs surface as kaltura.com / *.kaf.kaltura.com hosts, school
// MediaSpace aliases, or bare "kaf." aliases (Berkeley: kaf.berkeley.edu).
const KALTURA_HOST_RE = /kaltura|mediaspace|(^|\.|\/\/)kaf\./i;
const KALTURA_NAME_RE = /kaltura/i;
const GALLERY_NAME_RE = /media\s*gallery|course\s*(media|gallery)|lecture\s*(video|capture)/i;
const NON_GALLERY_NAME_RE = /my\s*media|browse|embed|upload/i;

// Rank the course's LTI tools and pick the one that looks like the course
// media gallery. Never assumes a fixed tool id — schools differ.
export function pickMediaGalleryTool(tools: ExternalToolInfo[]): ExternalToolInfo | null {
  const isKalturaHosted = (tool: ExternalToolInfo) =>
    KALTURA_HOST_RE.test(tool.domain ?? "") || KALTURA_HOST_RE.test(tool.url ?? "");

  const scored = tools
    .map((tool) => {
      let score = 0;
      if (isKalturaHosted(tool)) score += 4;
      if (KALTURA_NAME_RE.test(tool.name)) score += 4;
      if (/course-gallery/i.test(tool.url ?? "")) score += 4;
      if (GALLERY_NAME_RE.test(tool.name)) score += 2;
      if (NON_GALLERY_NAME_RE.test(tool.name)) score -= 3;
      return { tool, score };
    })
    .filter(({ score }) => score >= 4)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.tool ?? null;
}

// ---------------------------------------------------------------------------
// LTI launch-form parsing (pure)
// ---------------------------------------------------------------------------
export interface LtiLaunchForm {
  action: string;
  fields: Array<[string, string]>;
}

const FORM_RE = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
const INPUT_RE = /<input\b[^>]*>/gi;

function attrValue(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  if (!match) return null;
  return decodeEntities(match[2] ?? match[3] ?? "");
}

// Extract the auto-submitting launch form Canvas (or an intermediate LTI hop)
// renders: the first <form> that carries LTI-ish fields. Returns the POST
// target plus every input, entity-decoded.
export function parseLtiLaunchForm(html: string): LtiLaunchForm | null {
  FORM_RE.lastIndex = 0;
  let formMatch: RegExpExecArray | null;
  while ((formMatch = FORM_RE.exec(html)) !== null) {
    const action = attrValue(`<form ${formMatch[1] ?? ""}>`, "action");
    if (!action) continue;

    const fields: Array<[string, string]> = [];
    const body = formMatch[2] ?? "";
    INPUT_RE.lastIndex = 0;
    let inputMatch: RegExpExecArray | null;
    while ((inputMatch = INPUT_RE.exec(body)) !== null) {
      const name = attrValue(inputMatch[0], "name");
      if (!name) continue;
      fields.push([name, attrValue(inputMatch[0], "value") ?? ""]);
    }

    const names = new Set(fields.map(([name]) => name.toLowerCase()));
    const ltiish =
      names.has("lti_message_type") || // LTI 1.1 launch
      names.has("oauth_signature") ||
      names.has("iss") || // LTI 1.3 OIDC login initiation
      names.has("login_hint") ||
      names.has("lti_message_hint") ||
      names.has("id_token") || // LTI 1.3 final hop
      names.has("jwt") ||
      names.has("authenticity_token"); // Canvas interstitial
    if (ltiish && fields.length > 0) return { action, fields };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Channel-page scraping (pure)
// ---------------------------------------------------------------------------
// The KMS landing page bootstraps with a JS redirect to the real gallery:
//   window.location.href = '/channel/1554425/410171172'
export function extractJsRedirect(html: string): string | null {
  const match =
    /window\.location\.href\s*=\s*["']([^"']+)["']/.exec(html) ??
    /window\.location\.replace\(\s*["']([^"']+)["']/.exec(html);
  return match ? match[1]! : null;
}

// Category id is the last path segment of /channel/{courseId}/{categoryId}.
export function extractCategoryIdFromPath(path: string): string | null {
  const match = /\/channel\/\d+\/(\d+)/.exec(path) ?? /\/channel\/(\d+)(?:\/|$)/.exec(path);
  return match ? match[1]! : null;
}

export function extractPartnerId(text: string): string | null {
  const patterns = [
    /["']partnerId["']\s*[:=]\s*["']?(\d{5,9})/i,
    /partner_?id[=/](\d{5,9})/i,
    /\/p\/(\d{5,9})\//,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[1]!;
  }
  return null;
}

export function extractServiceUrl(html: string): string | null {
  const match = /["']serviceUrl["']\s*:\s*["'](https:[^"']+kaltura[^"']*)["']/i.exec(html);
  if (!match) return null;
  return match[1]!.replace(/\\\//g, "/").replace(/\/+$/, "");
}

const ENTRY_ID_SCRAPE_RES = [
  /data-entryid=["']([01]_[a-z0-9]{8})["']/gi,
  /["']entryId["']\s*:\s*["']([01]_[a-z0-9]{8})["']/gi,
  /entry_?id[=/]([01]_[a-z0-9]{8})/gi,
  /\/media\/(?:t\/)?([01]_[a-z0-9]{8})/gi,
];

export function scrapeEntryIds(html: string): string[] {
  const ids = new Set<string>();
  for (const pattern of ENTRY_ID_SCRAPE_RES) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) ids.add(match[1]!.toLowerCase());
  }
  return Array.from(ids);
}

// ---------------------------------------------------------------------------
// The LTI dance → channel page → widget session
// ---------------------------------------------------------------------------
const MAX_HOPS = 14;

// Per-host cookie jar so Canvas cookies are never replayed to Kaltura and vice
// versa. Path/expiry handling is deliberately minimal — the dance lives for a
// few seconds.
class CookieJar {
  private jars = new Map<string, Map<string, string>>();

  absorb(url: string, response: Response): void {
    const host = new URL(url).host;
    const jar = this.jars.get(host) ?? new Map<string, string>();
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    for (const line of headers.getSetCookie?.() ?? []) {
      const pair = line.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    this.jars.set(host, jar);
  }

  headerFor(url: string): string | null {
    const jar = this.jars.get(new URL(url).host);
    if (!jar || jar.size === 0) return null;
    return Array.from(jar.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

async function danceFetch(
  url: string,
  init: RequestInit,
  jar: CookieJar,
  diagnostics: string[],
  step: string,
): Promise<Response> {
  const cookie = jar.headerFor(url);
  const headers = new Headers(init.headers);
  if (cookie) headers.set("Cookie", cookie);
  headers.set("User-Agent", "Mozilla/5.0 (compatible; Polya import)");

  let response: Response;
  try {
    response = await fetch(url, { ...init, headers, redirect: "manual" });
  } catch (err) {
    diagnostics.push(`${step}: network error`);
    throw new KalturaTransientError(
      `Lecture-video service unreachable during ${step}: ${err instanceof Error ? err.message : err}`,
    );
  }
  jar.absorb(url, response);
  diagnostics.push(`${step}: ${response.status} ${new URL(url).host}`);
  if (response.status === 429 || response.status >= 500) {
    throw new KalturaTransientError(`Lecture-video service returned ${response.status} during ${step}`);
  }
  return response;
}

// Start an anonymous widget session for the partner. This is what the player
// itself uses; it reads entry metadata, captions, and attachments without a
// URI restriction (unlike the KMS app KS).
async function startWidgetSession(serviceUrl: string, partnerId: string): Promise<string> {
  const body = new URLSearchParams({ format: "1", widgetId: `_${partnerId}` });
  let response: Response;
  try {
    response = await fetch(`${serviceUrl}/api_v3/service/session/action/startWidgetSession`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (err) {
    throw new KalturaTransientError(
      `Lecture-video session start failed: ${err instanceof Error ? err.message : err}`,
    );
  }
  if (response.status === 429 || response.status >= 500) {
    throw new KalturaTransientError(`Lecture-video session start returned ${response.status}`);
  }
  const data = (await response.json().catch(() => null)) as { ks?: string; message?: string } | null;
  if (!data?.ks) throw new Error(`Could not start a lecture-video session (${data?.message ?? "no ks"})`);
  return data.ks;
}

// Follow the sessionless launch through the LTI dance and the KMS JS redirect
// to the course channel page, then open an anonymous widget session for reads.
export async function openKalturaSession(sessionlessLaunchUrl: string): Promise<KalturaSession> {
  const jar = new CookieJar();
  const diagnostics: string[] = [];
  let next: { url: string; init: RequestInit } = { url: sessionlessLaunchUrl, init: { method: "GET" } };
  let landingHtml = "";
  let landingUrl = sessionlessLaunchUrl;

  // Form/redirect hops until we land on a page with no auto-submit form.
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const response = await danceFetch(next.url, next.init, jar, diagnostics, `hop${hop}`);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      await response.body?.cancel().catch(() => {});
      if (!location) break;
      next = { url: new URL(location, next.url).toString(), init: { method: "GET" } };
      continue;
    }

    const html = await response.text().catch(() => "");
    landingHtml = html;
    landingUrl = next.url;

    const form = parseLtiLaunchForm(html);
    if (!form) break; // landed on a real page

    const body = new URLSearchParams();
    for (const [name, value] of form.fields) body.append(name, value);
    next = {
      url: new URL(form.action, next.url).toString(),
      init: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      },
    };
  }

  // Follow the KMS JS redirect(s) to the channel/gallery page.
  let channelHtml = landingHtml;
  let channelUrl = landingUrl;
  for (let redirect = 0; redirect < 3; redirect++) {
    const target = extractJsRedirect(channelHtml);
    if (!target) break;
    const resolved = new URL(target, channelUrl).toString();
    const response = await danceFetch(resolved, { method: "GET" }, jar, diagnostics, `channel${redirect}`);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      await response.body?.cancel().catch(() => {});
      if (!location) break;
      channelUrl = new URL(location, resolved).toString();
      channelHtml = "";
      // Re-fetch the redirected location on the next loop by seeding it as a
      // JS redirect target is awkward; fetch it directly here instead.
      const followed = await danceFetch(channelUrl, { method: "GET" }, jar, diagnostics, `channel${redirect}b`);
      channelHtml = await followed.text().catch(() => "");
      channelUrl = channelUrl;
    } else {
      channelHtml = await response.text().catch(() => "");
      channelUrl = resolved;
    }
  }

  const partnerId = extractPartnerId(channelHtml) ?? extractPartnerId(landingHtml);
  if (!partnerId) {
    throw new Error(`No lecture-video partner found (${diagnostics.join(" → ")})`);
  }
  const serviceUrl = extractServiceUrl(channelHtml) ?? "https://www.kaltura.com";
  const categoryId = extractCategoryIdFromPath(channelUrl) ?? extractCategoryIdFromPath(channelHtml);
  const entryIds = scrapeEntryIds(channelHtml);
  const widgetKs = await startWidgetSession(serviceUrl, partnerId);

  return { serviceUrl, partnerId, widgetKs, categoryId, entryIds, diagnostics };
}

// ---------------------------------------------------------------------------
// Kaltura API v3 (anonymous widget session)
// ---------------------------------------------------------------------------
interface KalturaApiException {
  objectType: "KalturaAPIException";
  code?: string;
  message?: string;
}

function isApiException(value: unknown): value is KalturaApiException {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { objectType?: string }).objectType === "KalturaAPIException"
  );
}

async function kalturaApi<T>(
  session: KalturaSession,
  serviceName: string,
  action: string,
  params: Record<string, string>,
): Promise<T> {
  const body = new URLSearchParams({ format: "1", ks: session.widgetKs, ...params });
  let response: Response;
  try {
    response = await fetch(`${session.serviceUrl}/api_v3/service/${serviceName}/action/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (err) {
    throw new KalturaTransientError(
      `Lecture-video API unreachable (${serviceName}.${action}): ${err instanceof Error ? err.message : err}`,
    );
  }
  if (response.status === 429 || response.status >= 500) {
    throw new KalturaTransientError(`Lecture-video API returned ${response.status} (${serviceName}.${action})`);
  }
  if (!response.ok) {
    throw new Error(`Lecture-video API returned ${response.status} (${serviceName}.${action})`);
  }
  const data = (await response.json().catch(() => null)) as unknown;
  if (isApiException(data)) {
    const code = data.code ?? "";
    if (code === "SERVICE_FORBIDDEN_TEMPORARY" || /INTERNAL_SERVER/i.test(code)) {
      throw new KalturaTransientError(`Lecture-video API error ${code} (${serviceName}.${action})`);
    }
    throw new Error(`Lecture-video API error ${code || "unknown"} (${serviceName}.${action}): ${data.message ?? ""}`);
  }
  return data as T;
}

interface RawMediaEntry {
  id?: string;
  name?: string;
  duration?: number; // seconds
  updatedAt?: number; // unix seconds
}

function toMediaEntry(raw: RawMediaEntry): KalturaMediaEntry | null {
  if (!raw.id) return null;
  return {
    entryId: raw.id,
    title: String(raw.name ?? raw.id).trim() || raw.id,
    durationMs: typeof raw.duration === "number" ? raw.duration * 1000 : null,
    updatedAt:
      typeof raw.updatedAt === "number" ? new Date(raw.updatedAt * 1000).toISOString() : null,
  };
}

// List the course's media entries. Enumeration source is the entry ids scraped
// from the gallery page (anonymous category listing is entitlement-gated and
// returns nothing); baseEntry.list resolves their titles/durations in bulk.
export async function listCourseMediaEntries(session: KalturaSession): Promise<KalturaMediaEntry[]> {
  const ids = session.entryIds.slice(0, 500);
  if (ids.length === 0) return [];

  const resolved = new Map<string, KalturaMediaEntry>();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    try {
      const data = await kalturaApi<{ objects?: RawMediaEntry[] }>(session, "baseentry", "list", {
        "filter[objectType]": "KalturaBaseEntryFilter",
        "filter[idIn]": batch.join(","),
        "pager[pageSize]": "50",
      });
      for (const raw of data.objects ?? []) {
        const entry = toMediaEntry(raw);
        if (entry) resolved.set(entry.entryId, entry);
      }
    } catch (err) {
      if (err instanceof KalturaTransientError) throw err;
      // Non-transient (e.g. one bad id) — fall back to bare ids below.
    }
  }

  // Any id we couldn't resolve still gets a row (title = id) so its transcript
  // is fetched; a missing title is cosmetic.
  return ids.map((id) => resolved.get(id) ?? { entryId: id, title: id, durationMs: null, updatedAt: null });
}

// Resolve a single entry discovered outside the gallery (embedded on a page).
export async function getMediaEntry(
  session: KalturaSession,
  entryId: string,
): Promise<KalturaMediaEntry | null> {
  try {
    const raw = await kalturaApi<RawMediaEntry>(session, "baseentry", "get", { entryId });
    return toMediaEntry(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Transcript assets
// ---------------------------------------------------------------------------
export interface CaptionAssetInfo {
  id: string;
  format: string; // "1" SRT, "2" DFXP, "3" WEBVTT
  language: string;
  fileExt: string;
}

export interface AttachmentAssetInfo {
  id: string;
  filename: string;
  title: string;
  fileExt: string;
}

export interface TranscriptPick {
  source: "caption" | "attachment";
  id: string;
  kind: TranscriptKind;
  label: string;
}

// Preference: timed captions (SRT, then WebVTT — parse cleanly with the
// existing cue parser) → plain-text attachment (clean sentences) → JSON
// attachment (REACH word-level, last resort). DFXP/XML captions are skipped.
export function pickBestTranscriptAsset(
  captions: CaptionAssetInfo[],
  attachments: AttachmentAssetInfo[],
): TranscriptPick | null {
  const english = (language: string) => /^en|english/i.test(language);
  const captionRank = (caption: CaptionAssetInfo): number => {
    const format = String(caption.format);
    const ext = caption.fileExt.toLowerCase();
    let rank = -1;
    if (format === "1" || ext === "srt") rank = 2;
    else if (format === "3" || ext === "vtt") rank = 1;
    if (rank >= 0 && english(caption.language)) rank += 2;
    return rank;
  };
  const bestCaption = captions
    .map((caption) => ({ caption, rank: captionRank(caption) }))
    .filter(({ rank }) => rank >= 0)
    .sort((a, b) => b.rank - a.rank)[0]?.caption;
  if (bestCaption) {
    const kind: TranscriptKind =
      String(bestCaption.format) === "3" || bestCaption.fileExt.toLowerCase() === "vtt"
        ? "transcript_vtt"
        : "transcript_srt";
    return {
      source: "caption",
      id: bestCaption.id,
      kind,
      label: `captions (${kind.replace("transcript_", "")}, ${bestCaption.language || "unknown"})`,
    };
  }

  const attachmentKind = (attachment: AttachmentAssetInfo): TranscriptKind | null => {
    const name = `${attachment.filename} ${attachment.title} ${attachment.fileExt}`.toLowerCase();
    if (/\btxt\b|\.txt/.test(name)) return "transcript_txt";
    if (/\bjson\b|\.json/.test(name)) return "transcript_json";
    return null;
  };
  for (const wanted of ["transcript_txt", "transcript_json"] as const) {
    const match = attachments.find((attachment) => attachmentKind(attachment) === wanted);
    if (match) {
      return {
        source: "attachment",
        id: match.id,
        kind: wanted,
        label: `attachment ${match.filename || match.title || match.id}`,
      };
    }
  }
  return null;
}

interface RawAsset {
  id?: string;
  format?: number | string;
  language?: string;
  languageCode?: string;
  fileExt?: string;
  filename?: string;
  title?: string;
}

export async function listTranscriptAssets(
  session: KalturaSession,
  entryId: string,
): Promise<{ captions: CaptionAssetInfo[]; attachments: AttachmentAssetInfo[] }> {
  const [captionData, attachmentData] = await Promise.all([
    kalturaApi<{ objects?: RawAsset[] }>(session, "caption_captionasset", "list", {
      "filter[objectType]": "KalturaAssetFilter",
      "filter[entryIdEqual]": entryId,
    }).catch((err) => {
      if (err instanceof KalturaTransientError) throw err;
      return { objects: [] as RawAsset[] };
    }),
    kalturaApi<{ objects?: RawAsset[] }>(session, "attachment_attachmentasset", "list", {
      "filter[objectType]": "KalturaAssetFilter",
      "filter[entryIdEqual]": entryId,
    }).catch((err) => {
      if (err instanceof KalturaTransientError) throw err;
      return { objects: [] as RawAsset[] };
    }),
  ]);

  const captions: CaptionAssetInfo[] = (captionData.objects ?? [])
    .filter((asset) => asset.id)
    .map((asset) => ({
      id: String(asset.id),
      format: String(asset.format ?? ""),
      language: String(asset.language ?? asset.languageCode ?? ""),
      fileExt: String(asset.fileExt ?? ""),
    }));
  const attachments: AttachmentAssetInfo[] = (attachmentData.objects ?? [])
    .filter((asset) => asset.id)
    .map((asset) => ({
      id: String(asset.id),
      filename: String(asset.filename ?? ""),
      title: String(asset.title ?? ""),
      fileExt: String(asset.fileExt ?? ""),
    }));
  return { captions, attachments };
}

// Download an asset's bytes. The `serve` action on the API host returns empty;
// `getUrl` yields a CDN URL (with its own embedded KS) that actually streams
// the file, so resolve then fetch that.
async function downloadAsset(
  session: KalturaSession,
  serviceName: "caption_captionasset" | "attachment_attachmentasset",
  assetId: string,
): Promise<ArrayBuffer> {
  const url = await kalturaApi<string>(session, serviceName, "getUrl", { id: assetId });
  if (typeof url !== "string" || !/^https?:/.test(url)) {
    throw new Error(`Lecture-video transcript URL missing for ${assetId}`);
  }
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new KalturaTransientError(
      `Transcript download unreachable: ${err instanceof Error ? err.message : err}`,
    );
  }
  if (response.status === 429 || response.status >= 500) {
    throw new KalturaTransientError(`Transcript download returned ${response.status}`);
  }
  if (!response.ok) throw new Error(`Transcript download returned ${response.status}`);
  return await response.arrayBuffer();
}

// Fetch the best transcript for one media entry, or null when it has none yet.
export async function fetchBestTranscript(
  session: KalturaSession,
  entryId: string,
): Promise<KalturaTranscriptFile | null> {
  const { captions, attachments } = await listTranscriptAssets(session, entryId);
  const pick = pickBestTranscriptAsset(captions, attachments);
  if (!pick) return null;

  const bytes =
    pick.source === "caption"
      ? await downloadAsset(session, "caption_captionasset", pick.id)
      : await downloadAsset(session, "attachment_attachmentasset", pick.id);
  return { kind: pick.kind, bytes, label: pick.label };
}

// ---------------------------------------------------------------------------
// High-level: Canvas course → Kaltura session
// ---------------------------------------------------------------------------
// Structural client interface so this module doesn't depend on CanvasClient's
// concrete class (keeps the dependency one-way and test doubles thin).
export interface CanvasLtiClient {
  listExternalTools(courseId: string): Promise<ExternalToolInfo[]>;
  getSessionlessLaunchUrl(courseId: string, toolId: string): Promise<string | null>;
}

export interface CourseMediaSession {
  session: KalturaSession;
  tool: ExternalToolInfo;
}

// Discover the course's media gallery and open a Kaltura session for it.
// Returns null when the course simply has no Kaltura tool.
export async function openCourseMediaSession(
  client: CanvasLtiClient,
  courseId: string,
): Promise<CourseMediaSession | null> {
  const tools = await client.listExternalTools(courseId);
  const tool = pickMediaGalleryTool(tools);
  if (!tool) return null;

  const launchUrl = await client.getSessionlessLaunchUrl(courseId, tool.id);
  if (!launchUrl) return null;

  const session = await openKalturaSession(launchUrl);
  return { session, tool };
}
