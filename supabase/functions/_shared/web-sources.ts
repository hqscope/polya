// The import pump's fetch step for course-website sources: a site page's
// readable text, a PDF the site hosts, or a linked Google file (public export
// first, then the student's own Google account). Pure module (fetch and the
// Drive reader are injected) so Node's test runner covers it.
import { MAX_HTML_BYTES, MAX_SITE_FILE_BYTES, pageMainText } from "./course-site.ts";
import { fetchPublicGooglePdf, parseGoogleSourceKey } from "./google-drive.ts";
import type { DriveReader } from "./drive-grant.ts";
import {
  FILE_TIMEOUT_MS,
  fetchPublic,
  type FetchLike,
  looksLikePdf,
  ResponseTooLargeError,
  UnsafeUrlError,
} from "./safe-fetch.ts";

/** A rendered notes chapter runs ~40k characters; this bounds one page's chunk+embed step. */
export const MAX_PAGE_TEXT_CHARS = 200_000;

/** Origins whose bytes come from the open web rather than Canvas. */
export const WEB_ORIGINS: ReadonlySet<string> = new Set(["site_page", "site_file", "drive_file"]);

/** The polya_sources fields a web fetch needs (structural, so this module stays free of ingest.ts's Deno imports). */
export interface WebSourceRef {
  origin: string;
  canvas_id: string | null;
  canvas_url: string | null;
  user_id: string;
}

/** A permanent reason a web source can't be read; the message is user-facing. */
export class WebSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSourceError";
  }
}

const COPY = {
  pageGone: "This page is no longer on the course website.",
  pageUnreadable: "We couldn't open this page.",
  fileGone: "This file is no longer on the course website.",
  notPdf: "This link didn't lead to a PDF.",
  tooLarge: "This file is too large to bring in.",
  badLink: "We couldn't open this file's link.",
} as const;

async function get(fetchFn: FetchLike, url: string, maxBytes: number, accept: string, timeoutMs?: number) {
  try {
    return await fetchPublic(fetchFn, url, { maxBytes, accept, timeoutMs });
  } catch (error) {
    if (error instanceof ResponseTooLargeError) throw new WebSourceError(COPY.tooLarge);
    if (error instanceof UnsafeUrlError) throw new WebSourceError(COPY.badLink);
    throw error; // TransientFetchError → retried by the pump
  }
}

/** A site page's main-content text, or null when the address isn't an HTML page. */
export async function fetchSitePageText(url: string, fetchFn: FetchLike = fetch): Promise<string | null> {
  const response = await get(fetchFn, url, MAX_HTML_BYTES, "text/html,application/xhtml+xml");
  if (response.status === 404 || response.status === 410) throw new WebSourceError(COPY.pageGone);
  if (response.status !== 200) throw new WebSourceError(COPY.pageUnreadable);
  if (!/html/.test(response.contentType)) return null;
  return pageMainText(new TextDecoder().decode(response.bytes)).slice(0, MAX_PAGE_TEXT_CHARS);
}

/** PDF bytes for a site_file or drive_file source. */
export async function fetchWebPdf(
  source: WebSourceRef,
  driveReader: () => DriveReader,
  fetchFn: FetchLike = fetch,
): Promise<Uint8Array> {
  if (source.origin === "drive_file") {
    const ref = parseGoogleSourceKey(source.canvas_id);
    if (!ref) throw new WebSourceError(COPY.badLink);
    const open = await fetchPublicGooglePdf(fetchFn, ref);
    if (open) return open;
    // Shared only inside the school's Google domain: read it as the student.
    return await driveReader().readPdf(source.user_id, ref);
  }

  if (!source.canvas_url) throw new WebSourceError(COPY.badLink);
  const response = await get(fetchFn, source.canvas_url, MAX_SITE_FILE_BYTES, "application/pdf", FILE_TIMEOUT_MS);
  if (response.status === 404 || response.status === 410) throw new WebSourceError(COPY.fileGone);
  if (response.status !== 200) throw new WebSourceError(COPY.badLink);
  if (!looksLikePdf(response.bytes)) throw new WebSourceError(COPY.notPdf);
  return response.bytes;
}
