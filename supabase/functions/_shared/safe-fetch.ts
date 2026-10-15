// Server-side fetches of public web addresses a student gave us (a course
// website, the files it links). Every address — the first one and each
// redirect hop — passes the same SSRF boundary as a Canvas base URL (https,
// public hostname, no userinfo or nonstandard port), redirects are followed by
// hand so a hop can't slip past it, and bodies are size-capped while they
// stream. Pure module (no Deno globals; fetch is injected) so Node's test
// runner covers it.
import { CanvasUrlError, normalizeBaseUrl } from "./canvas.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 20_000;
/** Files get longer: Google renders a lecture deck to PDF on request (~20 s for 6 MB). */
export const FILE_TIMEOUT_MS = 120_000;

/** The address isn't one we'll fetch (not https, a private host, …). */
export class UnsafeUrlError extends Error {
  constructor(message = "That address can't be opened.") {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

/** The body grew past the cap. */
export class ResponseTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`response over ${maxBytes} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

/** A retryable failure (429, 5xx, network): process.ts re-queues on `transient`. */
export class TransientFetchError extends Error {
  readonly transient = true;
  constructor(message: string) {
    super(message);
    this.name = "TransientFetchError";
  }
}

/** Parses `raw` and throws UnsafeUrlError unless it is a public https URL. */
export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError();
  }
  try {
    normalizeBaseUrl(url.origin);
  } catch (error) {
    if (error instanceof CanvasUrlError) throw new UnsafeUrlError();
    throw error;
  }
  if (url.protocol !== "https:" || url.username || url.password) throw new UnsafeUrlError();
  return url;
}

export interface PublicResponse {
  status: number;
  /** The address that answered, after redirects. */
  url: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface FetchPublicOptions {
  maxBytes: number;
  accept?: string;
  /** Stop at the first redirect to a host this rejects; the redirect is returned unfollowed. */
  allowRedirectHost?: (host: string) => boolean;
  /** Per-hop limit, so a stalled server can't hold an import (default 20 s). */
  timeoutMs?: number;
}

/**
 * GET a public URL, following redirects by hand. A 429/5xx/network failure
 * throws TransientFetchError; any other status comes back as-is (with an
 * empty body) so the caller decides what it means.
 */
export async function fetchPublic(
  fetchFn: FetchLike,
  rawUrl: string,
  opts: FetchPublicOptions,
): Promise<PublicResponse> {
  let url = assertPublicUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Response;
    try {
      response = await fetchFn(url.toString(), {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        headers: {
          Accept: opts.accept ?? "*/*",
          "User-Agent": "Polya course import (+https://askpolya.com)",
        },
      });
    } catch (error) {
      throw new TransientFetchError(`unreachable: ${String(error).slice(0, 200)}`);
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get("Location");
      if (!location) return { status: response.status, url: url.toString(), contentType: "", bytes: new Uint8Array() };
      const next = assertPublicUrl(new URL(location, url).toString());
      if (opts.allowRedirectHost && !opts.allowRedirectHost(next.hostname.toLowerCase())) {
        return { status: response.status, url: next.toString(), contentType: "", bytes: new Uint8Array() };
      }
      url = next;
      continue;
    }

    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel().catch(() => {});
      throw new TransientFetchError(`(${response.status}) from ${url.hostname}`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { status: response.status, url: url.toString(), contentType: "", bytes: new Uint8Array() };
    }
    let bytes: Uint8Array;
    try {
      bytes = await readCapped(response, opts.maxBytes);
    } catch (error) {
      // A connection dropped (or timed out) mid-body is worth another try.
      if (error instanceof ResponseTooLargeError) throw error;
      throw new TransientFetchError(`body read failed: ${String(error).slice(0, 200)}`);
    }
    return {
      status: response.status,
      url: url.toString(),
      contentType: (response.headers.get("Content-Type") ?? "").toLowerCase(),
      bytes,
    };
  }
  throw new UnsafeUrlError("Too many redirects.");
}

/** Reads a response body, refusing to hold more than `maxBytes`. */
export async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("Content-Length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError(maxBytes);
  }
  if (!response.body) {
    const whole = new Uint8Array(await response.arrayBuffer());
    if (whole.byteLength > maxBytes) throw new ResponseTooLargeError(maxBytes);
    return whole;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ResponseTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** True when the bytes start with a PDF header. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 5 &&
    bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d; // "%PDF-"
}
