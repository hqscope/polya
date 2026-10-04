// The import pump's single bounded step: claim one source, advance it one
// stage (fetch -> parse a page batch -> chunk+embed -> ready), persist cursors,
// return whether more work remains. Sources with a pre-set storage_path
// (fixtures, uploaded transcripts) skip the Canvas fetch.
import { service } from "./service.ts";
import { CONNECTIONS_TABLE } from "./connections.ts";
import { transientBackoffMs, type TransientHint } from "./backoff.ts";
import { trackServer } from "./events.ts";
import {
  CanvasAuthError,
  CanvasClient,
  extractCanvasFileIds,
  extractKalturaEntryIds,
} from "./canvas.ts";
import { classifyContentRole } from "./content-roles.ts";
import {
  chunksFromPages,
  chunksFromText,
  downloadFromStorage,
  embedAndInsertChunks,
  sha256Hex,
  storageKeyFor,
  uploadToStorage,
  type SourceRow,
} from "./ingest.ts";
import { extractPageRange, getPdfInfo } from "./pdf.ts";
import type { PageText } from "./chunker.ts";
import { ocrEnabled, ocrPdfPages } from "./ocr.ts";
import { GeminiTransientError } from "./embeddings.ts";
import { chargeImportUnits } from "./import-caps.ts";
import { STORAGE_FULL_MESSAGE, StorageFullError } from "./storage-quota.ts";
import {
  fetchBestTranscript,
  getMediaEntry,
  openCourseMediaSession,
  type KalturaSession,
} from "./kaltura.ts";
import { parseTranscript } from "./transcripts.ts";
import { extractProcedures } from "./procedures.ts";
import { embedAndInsertTranscript, embedAndInsertProcedures } from "./ingest-extra.ts";

// Small page window so a step that has to OCR every page still fits the edge
// CPU/wall budget (OCR is ~seconds/page); text-only PDFs just take a few more
// cheap steps.
const PARSE_PAGE_BATCH = 10;
const LEASE_MS = 2 * 60 * 1000; // matches polya_claim_import_work's 2-minute lease
const MAX_ATTEMPTS = 8; // transient (quota/rate-limit) retries before giving up

// Columns advance() needs off a claimed source. Exported so the background
// pump's batch claim projects the same shape as processOneStep's single claim.
export const SOURCE_COLUMNS =
  "id, user_id, course_id, origin, source_kind, canvas_id, title, folder_path, module_name, canvas_url, storage_path, content_role, page_count, pages_parsed, chunks_embedded, attempts, status, content_sha256, needs_refresh, due_at";

export interface ProcessResult {
  done: boolean;
  source_id?: string;
  status?: string;
  retry_after_ms?: number;
  // True milliseconds until the next source becomes claimable (lease expiry AND
  // retry backoff both elapsed). Unlike retry_after_ms it is NOT capped at the
  // lease window — the background pump uses it to park instead of spinning
  // through self-invocations while every source waits out an hours-long backoff.
  next_work_in_ms?: number;
  // Set when the source failed because Canvas rejected the token — the pump uses
  // it to stop hammering the same broken connection, and the legacy single-step
  // path re-throws it so the client can prompt for a fresh token.
  canvas_auth?: boolean;
}

export interface Connection {
  base_url: string;
  access_token: string;
  // Local-only escape hatch for the mock-Canvas integration test.
  allow_insecure?: boolean;
}

// Per-pump-invocation state shared across the sources advanced in one run.
// Holds one lecture-video (Kaltura) session per course so entries from the same
// course reuse a single LTI dance; the session KS lives only here, never
// persisted or logged.
export interface AdvanceContext {
  kalturaSessions: Map<string, Promise<KalturaSession | null>>;
}

export function newAdvanceContext(): AdvanceContext {
  return { kalturaSessions: new Map() };
}

// Legacy single-step pump: claim one source and advance it. Kept for the
// `process` action and tests; the background pump claims a batch and runs
// advanceClaimedSource() concurrently instead.
export async function processOneStep(
  userId: string,
  courseId: string,
  connection: Connection | null,
): Promise<ProcessResult> {
  const { data: claimed, error } = await service
    .rpc("polya_claim_import_work", { p_user_id: userId, p_course_id: courseId })
    .select(SOURCE_COLUMNS);

  if (error) throw new Error(`claim failed: ${error.message}`);
  const source = (Array.isArray(claimed) ? claimed[0] : claimed) as SourceRow | undefined;

  // Nothing claimable: finish only if no non-terminal work remains; otherwise
  // sources are leased mid-backoff, so tell the client to wait and re-pump.
  if (!source) return await finishOrWait(userId, courseId);

  const result = await advanceClaimedSource(source, connection);
  // Preserve the legacy contract: surface an auth failure so the client prompts
  // for a fresh token (the pump instead reads result.canvas_auth and moves on).
  if (result.canvas_auth) {
    throw new CanvasAuthError("Your Canvas access token stopped working.");
  }
  return result;
}

// Advance one already-claimed source by a single stage. Shared by processOneStep
// and the background pump. Never throws for an *expected* import failure — it
// records the outcome on the row and returns a terminal / "retrying" status so a
// batch pump can keep draining other sources; only unexpected errors propagate.
export async function advanceClaimedSource(
  source: SourceRow,
  connection: Connection | null,
  ctx?: AdvanceContext,
): Promise<ProcessResult> {
  try {
    const status = await advance(source, connection, ctx);
    // Release the lease so a still-in-progress source (e.g. a PDF mid-parse) can
    // be re-claimed on the very next pump cycle.
    await service.from("polya_sources").update({ claimed_at: null }).eq("id", source.id);
    return { done: false, source_id: source.id, status };
  } catch (err) {
    if (err instanceof CanvasAuthError) {
      if (connection) {
        await service
          .from(CONNECTIONS_TABLE)
          .update({ status: "invalid" })
          .eq("user_id", source.user_id)
          .eq("base_url", connection.base_url);
      }
      await failSource(source.id, "Your Canvas access token stopped working.");
      return { done: false, source_id: source.id, status: "failed", canvas_auth: true };
    }

    // Over the Lectra storage quota (4.3): nothing was stored. Fail the source
    // with the storage-full message; "retry failed" re-queues it once there's room.
    if (err instanceof StorageFullError) {
      await failSource(source.id, STORAGE_FULL_MESSAGE);
      return { done: false, source_id: source.id, status: "failed" };
    }

    const attempts = (source.attempts ?? 0) + 1;

    // Transient (quota / rate limit / 5xx / network): re-queue with a stretched
    // next_attempt_at backoff so a daily quota can actually reset between
    // attempts; the claim RPCs skip the row until then while other sources
    // proceed. Retry until MAX_ATTEMPTS, then give up with a friendly message.
    if (isTransient(err) && attempts < MAX_ATTEMPTS) {
      const hint = err as TransientHint;
      const backoff = transientBackoffMs(attempts, hint);
      console.warn(
        `[polya-import] transient on ${source.id} (attempt ${attempts}, retry in ${Math.round(backoff / 1000)}s):`,
        errMessage(err),
      );
      await service
        .from("polya_sources")
        .update({
          attempts,
          last_error_at: new Date().toISOString(),
          next_attempt_at: new Date(Date.now() + backoff).toISOString(),
          claimed_at: null,
        })
        .eq("id", source.id);
      // Provider-wide limits gate the whole queue, not just this row -- see
      // gateSiblingSources for why this is the difference between one storage
      // download per attempt cycle and one per source.
      if (isProviderWide(err)) {
        await gateSiblingSources(source, backoff);
      }
      // Short delay hint so the legacy client immediately claims the next source.
      return { done: false, source_id: source.id, status: "retrying", retry_after_ms: 400 };
    }

    console.error(`[polya-import] source ${source.id} failed:`, err);
    await failSource(
      source.id,
      isTransient(err)
        ? "We couldn't finish reading this after several tries — it may be a rate limit. Try again later."
        : errMessage(err).slice(0, 400),
      attempts,
    );
    return { done: false, source_id: source.id, status: "failed" };
  }
}

// Called when nothing is claimable. Marks the course complete only when every
// source is terminal; otherwise the remaining sources are leased mid-backoff, so
// wait until the soonest lease expires and let the client re-pump.
export async function finishOrWait(userId: string, courseId: string): Promise<ProcessResult> {
  const { data } = await service
    .from("polya_sources")
    .select("status, claimed_at, next_attempt_at")
    .eq("user_id", userId)
    .eq("course_id", courseId);

  const rows = (data ?? []) as Array<{
    status: string;
    claimed_at: string | null;
    next_attempt_at: string | null;
  }>;
  const pending = rows.filter((row) =>
    ["queued", "fetching", "parsing", "embedding"].includes(row.status),
  );

  if (pending.length === 0) {
    // Only the transition to complete emits the event (not every idle poll).
    const { data: updated } = await service
      .from("polya_courses")
      .update({ import_status: "complete", imported_at: new Date().toISOString() })
      .eq("id", courseId)
      .eq("user_id", userId)
      .neq("import_status", "complete")
      .select("id");
    if ((updated ?? []).length > 0) {
      const counts: Record<string, number> = {};
      for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
      await trackServer(userId, "import_completed", courseId, counts);
    }
    return { done: true };
  }

  // A row is claimable once BOTH its lease and its retry backoff have elapsed.
  const now = Date.now();
  let soonest = Number.POSITIVE_INFINITY;
  for (const row of pending) {
    const leaseIn = row.claimed_at ? new Date(row.claimed_at).getTime() + LEASE_MS - now : 0;
    const backoffIn = row.next_attempt_at ? new Date(row.next_attempt_at).getTime() - now : 0;
    soonest = Math.min(soonest, Math.max(0, leaseIn, backoffIn));
    if (soonest === 0) break;
  }
  if (!Number.isFinite(soonest)) soonest = 0;
  return {
    done: false,
    // Capped hint for the legacy client's re-pump loop…
    retry_after_ms: Math.min(LEASE_MS, Math.max(1500, soonest + 500)),
    // …and the uncapped truth for the background pump's park decision.
    next_work_in_ms: soonest,
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isTransient(err: unknown): boolean {
  if (err instanceof GeminiTransientError) return true;
  // Duck-typed so other adapters (e.g. the lecture-video fetcher) can mark
  // their own errors retryable without importing Gemini's class.
  if (typeof err === "object" && err !== null && (err as { transient?: boolean }).transient === true) {
    return true;
  }
  const message = errMessage(err).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("quota") ||
    message.includes("rate limit") ||
    message.includes("timeout") ||
    message.includes("temporarily") ||
    message.includes("(500)") ||
    message.includes("(502)") ||
    message.includes("(503)") ||
    message.includes("(504)")
  );
}

// A provider-wide limit (embedding quota, 429, rate limit) is a property of the
// account, not of the source that happened to trip it. Backing off only that
// source lets every sibling get claimed and re-discover the same wall -- and
// because the embed step runs *after* downloadFromStorage, each rediscovery
// costs a full PDF pull from Storage. One stuck import of 100 sources therefore
// burned ~100 downloads per attempt cycle instead of one.
function isProviderWide(err: unknown): boolean {
  if (err instanceof GeminiTransientError) return true;
  if (typeof err === "object" && err !== null && (err as TransientHint).daily === true) {
    return true;
  }
  const message = errMessage(err).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("quota") ||
    message.includes("rate limit")
  );
}

// Push every other pending source for this user out past the same backoff, so
// the pump stops handing out claims that can only fail. Never pulls a source
// *earlier* than it was already gated for.
async function gateSiblingSources(source: SourceRow, backoffMs: number): Promise<void> {
  const until = new Date(Date.now() + backoffMs).toISOString();
  const { error } = await service
    .from("polya_sources")
    .update({ next_attempt_at: until, claimed_at: null })
    .eq("user_id", source.user_id)
    .in("status", ["queued", "fetching", "parsing", "embedding"])
    .neq("id", source.id)
    .or(`next_attempt_at.is.null,next_attempt_at.lt.${until}`);
  if (error) {
    // Best effort: the per-source backoff already applied, so a failure here
    // costs extra downloads but never correctness.
    console.warn(`[polya-import] sibling gate failed for ${source.user_id}:`, error.message);
  }
}

async function advance(
  source: SourceRow,
  connection: Connection | null,
  ctx?: AdvanceContext,
): Promise<string> {
  // Lecture videos: before their transcript exists in storage, fetch it from
  // the media gallery. Once stored, the row carries a real transcript_* kind
  // and a storage_path, so it falls through to advanceTranscript below.
  if (source.origin === "canvas_media" && (!source.storage_path || source.needs_refresh)) {
    return await advanceMediaFetch(source, connection, ctx);
  }
  if (source.source_kind === "pdf") return await advancePdf(source, connection);
  if (source.source_kind === "html") return await advanceHtml(source, connection);
  if (source.source_kind.startsWith("transcript_")) return await advanceTranscript(source);
  await failSource(source.id, `Unsupported source kind: ${source.source_kind}`);
  return "failed";
}

// PDF: queued -> fetch bytes to storage + read page count -> parsing;
// parsing -> extract next page batch, chunk+embed, bump cursor -> ready.
// A queued source with needs_refresh re-fetches its bytes, hash-compares, and
// rebuilds its units only when the content actually changed.
async function advancePdf(source: SourceRow, connection: Connection | null): Promise<string> {
  if (source.status === "queued") {
    const refreshing = Boolean(source.needs_refresh);
    // Refreshing a Canvas source must re-fetch from Canvas, not reuse the
    // stored copy — the stored copy is exactly what might be stale.
    const fetchFromCanvas =
      connection && source.canvas_url && (!source.storage_path || refreshing);

    if (fetchFromCanvas) {
      const client = new CanvasClient(connection.base_url, connection.access_token, {
        allowInsecure: connection.allow_insecure,
      });
      const bytes = await client.downloadFile(source.canvas_url!);
      const sha = await sha256Hex(bytes);
      if (refreshing && source.content_sha256 && sha === source.content_sha256) {
        // Timestamp moved but bytes didn't — keep the existing units.
        await service
          .from("polya_sources")
          .update({ needs_refresh: false, status: "ready" })
          .eq("id", source.id);
        return "ready";
      }
      if (refreshing) await clearSourceOutput(source.id);
      const storagePath = source.storage_path ?? storageKeyFor(source, "pdf");
      await uploadToStorage(source.user_id, storagePath, bytes, "application/pdf");
      const info = await getPdfInfo(bytes);
      await service
        .from("polya_sources")
        .update({
          storage_path: storagePath,
          content_sha256: sha,
          size_bytes: bytes.byteLength,
          page_count: info.totalPages,
          status: "parsing",
          pages_parsed: 0,
          chunks_embedded: 0,
          needs_refresh: false,
        })
        .eq("id", source.id);
      return "parsing";
    }

    if (!source.storage_path) {
      await failSource(source.id, "No way to fetch this file.");
      return "failed";
    }
    // Fixture / uploaded / extension-registered PDF: bytes already in storage.
    const bytes = await downloadFromStorage(source.storage_path);
    const sha = await sha256Hex(bytes);
    if (refreshing && source.content_sha256 && sha === source.content_sha256) {
      await service
        .from("polya_sources")
        .update({ needs_refresh: false, status: "ready" })
        .eq("id", source.id);
      return "ready";
    }
    if (refreshing) await clearSourceOutput(source.id);
    const info = await getPdfInfo(bytes);
    await service
      .from("polya_sources")
      .update({
        content_sha256: sha,
        page_count: info.totalPages,
        status: "parsing",
        pages_parsed: 0,
        chunks_embedded: 0,
        needs_refresh: false,
      })
      .eq("id", source.id);
    return "parsing";
  }

  // status === "parsing" — extract this page batch's text layer (unpdf), then
  // OCR any image-only pages in the batch and merge them in before chunking.
  // Both are metered per user per day before the work runs (import-caps.ts);
  // over a cap, the source waits for the daily reset instead of failing.
  const batchPages = Math.max(1, Math.min(PARSE_PAGE_BATCH, (source.page_count ?? 0) - source.pages_parsed));
  await chargeImportUnits(service, source.user_id, "pages", batchPages);
  const bytes = await downloadFromStorage(source.storage_path!);
  const range = await extractPageRange(bytes, source.pages_parsed + 1, PARSE_PAGE_BATCH);

  let pages = range.pages;
  if (range.emptyPages.length > 0 && ocrEnabled()) {
    // Outside the try below: a cap error must re-queue the batch, not be
    // swallowed as a permanent OCR failure (which would drop these pages).
    await chargeImportUnits(service, source.user_id, "ocr", range.emptyPages.length);
    try {
      const ocrPages = await ocrPdfPages(bytes, range.emptyPages);
      pages = mergePages(range.pages, ocrPages);
    } catch (err) {
      // Transient OCR failure → let the pump re-queue and retry the whole batch.
      if (err instanceof GeminiTransientError) throw err;
      // Permanent OCR failure → skip these image pages (fall through, text only).
      console.error(`[polya-import] OCR failed for ${source.id}:`, err);
    }
  }

  const inserted = await embedAndInsertChunks(source, chunksFromPages(pages), source.chunks_embedded);

  // Extract procedures from this page batch (numbered-method decks).
  const procedureUnits = await embedAndInsertProcedures(
    source,
    extractProcedures(pages),
    source.chunks_embedded + inserted,
  );

  const chunksEmbedded = source.chunks_embedded + inserted + procedureUnits;
  const pagesParsed = range.done ? source.page_count : range.nextPage - 1;

  if (!range.done) {
    await service
      .from("polya_sources")
      .update({ pages_parsed: pagesParsed, chunks_embedded: chunksEmbedded, status: "parsing" })
      .eq("id", source.id);
    return "parsing";
  }

  // Done with every page. If nothing at all was extractable (OCR off, or it
  // produced no text on any page), flag needs_ocr so it's visible rather than
  // silently empty; otherwise ready.
  const status = chunksEmbedded === 0 && source.page_count > 0 ? "needs_ocr" : "ready";
  await service
    .from("polya_sources")
    .update({ pages_parsed: pagesParsed, chunks_embedded: chunksEmbedded, status })
    .eq("id", source.id);
  return status;
}

// Merge text-layer pages with OCR'd pages, ordered by page number.
function mergePages(textPages: PageText[], ocrPages: PageText[]): PageText[] {
  return [...textPages, ...ocrPages].sort((a, b) => a.pageNum - b.pageNum);
}

// HTML (page/assignment/syllabus): single step — get text, discover any files
// linked in the body, chunk, embed, ready.
async function advanceHtml(source: SourceRow, connection: Connection | null): Promise<string> {
  let text: string | null = null;
  let rawHtml: string | null = null;

  if (source.storage_path) {
    const bytes = await downloadFromStorage(source.storage_path);
    rawHtml = new TextDecoder().decode(bytes);
    const { stripHtmlToText } = await import("./canvas.ts");
    text = stripHtmlToText(rawHtml);
  } else if (connection) {
    const client = new CanvasClient(connection.base_url, connection.access_token, {
      allowInsecure: connection.allow_insecure,
    });
    const [, courseId] = await courseCanvasId(source.course_id);
    if (source.origin === "canvas_page" && source.canvas_id) {
      const raw = await client.getPageRaw(courseId, source.canvas_id);
      text = raw.text;
      rawHtml = raw.html;
    } else if (source.origin === "canvas_syllabus") {
      const raw = await client.getCourseSyllabusRaw(courseId);
      text = raw.text;
      rawHtml = raw.html;
    } else if (source.origin === "canvas_assignment" && source.canvas_id) {
      const assignments = await client.listAssignments(courseId);
      const match = assignments.find((a) => a.assignmentId === source.canvas_id);
      const { normalizeRichText } = await import("./canvas.ts");
      rawHtml = match?.descriptionHtml ?? null;
      text = match ? normalizeRichText(match.descriptionHtml).text : null;
    }

    // Pull in PDFs and lecture videos linked inside a page/assignment/syllabus
    // body — the main recovery path when the flat Files index is hidden and the
    // way videos embedded outside the gallery still get transcribed.
    if (rawHtml) {
      await discoverEmbeddedFiles(source, client, courseId, rawHtml);
      await discoverEmbeddedMedia(source, rawHtml);
    }
  }

  if (!text || text.trim().length < 20) {
    await service
      .from("polya_sources")
      .update({ status: "skipped", needs_refresh: false })
      .eq("id", source.id);
    return "skipped";
  }

  // Hash the normalized text (HTML rows previously stored no hash) so a
  // refresh can skip the rebuild when only the timestamp moved.
  const sha = await sha256Hex(new TextEncoder().encode(text).buffer as ArrayBuffer);
  if (source.needs_refresh && source.content_sha256 && sha === source.content_sha256) {
    await service
      .from("polya_sources")
      .update({ needs_refresh: false, status: "ready" })
      .eq("id", source.id);
    return "ready";
  }
  if (source.needs_refresh) await clearSourceOutput(source.id);

  const inserted = await embedAndInsertChunks(source, chunksFromText(text), 0);
  await service
    .from("polya_sources")
    .update({ chunks_embedded: inserted, status: "ready", content_sha256: sha, needs_refresh: false })
    .eq("id", source.id);
  return "ready";
}

// Remove a source's derived output before a rebuild. Units first (they can
// reference procedures), then procedures (steps cascade) — same order as
// retry_failed.
async function clearSourceOutput(sourceId: string): Promise<void> {
  await service.from("polya_content_units").delete().eq("source_id", sourceId);
  await service.from("polya_procedures").delete().eq("source_id", sourceId);
}

// Scan a page/assignment HTML body for Canvas file links and queue any PDFs as
// new sources (deduped by canvas identity). Bounded so a link-heavy page can't
// balloon a single step.
async function discoverEmbeddedFiles(
  source: SourceRow,
  client: CanvasClient,
  courseId: string,
  rawHtml: string,
): Promise<void> {
  const fileIds = extractCanvasFileIds(rawHtml).slice(0, 25);
  if (fileIds.length === 0) return;

  const rows: Array<Record<string, unknown>> = [];
  for (const fileId of fileIds) {
    const meta = await client.getFileMeta(courseId, fileId);
    if (!meta || !meta.isPdf) continue;
    rows.push({
      user_id: source.user_id,
      course_id: source.course_id,
      origin: "canvas_file",
      source_kind: "pdf",
      canvas_id: meta.fileId,
      title: meta.title,
      module_name: source.module_name ?? null,
      folder_path: null,
      canvas_url: meta.downloadUrl,
      content_role: classifyContentRole({ origin: "canvas_file", title: meta.title }),
      size_bytes: meta.sizeBytes,
      status: "queued",
    });
  }
  if (rows.length === 0) return;

  const { error } = await service
    .from("polya_sources")
    .upsert(rows, { onConflict: "user_id,course_id,origin,canvas_id", ignoreDuplicates: true });
  if (error) {
    console.error(`[polya-import] embedded-file queue failed for ${source.id}:`, error.message);
  }
}

const TRANSCRIPT_EXT: Record<string, string> = {
  transcript_srt: "srt",
  transcript_vtt: "vtt",
  transcript_json: "json",
  transcript_txt: "txt",
};

// Lecture video (Kaltura): open (or reuse) the course's media session, download
// the best available transcript for this entry, and store it. Leaves the row
// queued with a real transcript_* kind + storage_path so the next pump step
// parses and embeds it via advanceTranscript. Entries with no transcript yet
// are skipped (not failed) so the course can still complete.
async function advanceMediaFetch(
  source: SourceRow,
  connection: Connection | null,
  ctx?: AdvanceContext,
): Promise<string> {
  if (!connection) {
    await failSource(source.id, "We couldn't reach this lecture video.");
    return "failed";
  }
  if (!source.canvas_id) {
    await failSource(source.id, "This lecture video is missing its reference.");
    return "failed";
  }

  const [, canvasCourseId] = await courseCanvasId(source.course_id);
  const session = await getMediaSession(source.course_id, canvasCourseId, connection, ctx);
  if (!session) {
    // Tool vanished or the session couldn't be opened for a non-transient
    // reason — surface it plainly (never leak Kaltura/LTI/KS terms).
    await failSource(source.id, "We couldn't open this course's lecture videos.");
    return "failed";
  }

  // Videos discovered embedded on a page carry a placeholder title — resolve
  // the real one now that we have a session (gallery entries already have it).
  let titlePatch: { title: string } | null = null;
  if (!source.title || source.title === "Lecture video") {
    const entry = await getMediaEntry(session, source.canvas_id);
    if (entry && entry.title && entry.title !== source.canvas_id) titlePatch = { title: entry.title };
  }

  const transcript = await fetchBestTranscript(session, source.canvas_id);
  if (!transcript) {
    await service
      .from("polya_sources")
      .update({ status: "skipped", needs_refresh: false, ...(titlePatch ?? {}) })
      .eq("id", source.id);
    return "skipped";
  }

  const sha = await sha256Hex(transcript.bytes);
  if (source.needs_refresh && source.content_sha256 && sha === source.content_sha256) {
    await service
      .from("polya_sources")
      .update({ needs_refresh: false, status: "ready" })
      .eq("id", source.id);
    return "ready";
  }
  if (source.needs_refresh) await clearSourceOutput(source.id);

  const ext = TRANSCRIPT_EXT[transcript.kind] ?? "txt";
  const storagePath = source.storage_path ?? storageKeyFor(source, ext);
  await uploadToStorage(source.user_id, storagePath, transcript.bytes, "text/plain; charset=utf-8");
  await service
    .from("polya_sources")
    .update({
      storage_path: storagePath,
      source_kind: transcript.kind,
      content_sha256: sha,
      size_bytes: transcript.bytes.byteLength,
      needs_refresh: false,
      status: "queued", // re-claimed next cycle → advanceTranscript
      ...(titlePatch ?? {}),
    })
    .eq("id", source.id);
  return "queued";
}

// One Kaltura session per course per pump invocation (the LTI dance is the
// costly part). The KS lives only in the context map — never persisted/logged.
async function getMediaSession(
  polyaCourseId: string,
  canvasCourseId: string,
  connection: Connection,
  ctx?: AdvanceContext,
): Promise<KalturaSession | null> {
  const open = (): Promise<KalturaSession | null> => {
    const client = new CanvasClient(connection.base_url, connection.access_token, {
      allowInsecure: connection.allow_insecure,
    });
    return openCourseMediaSession(client, canvasCourseId).then((m) => m?.session ?? null);
  };

  if (!ctx) return await open();
  let cached = ctx.kalturaSessions.get(polyaCourseId);
  if (!cached) {
    cached = open();
    ctx.kalturaSessions.set(polyaCourseId, cached);
  }
  return await cached;
}

// Scan a page/assignment/syllabus body for embedded lecture videos (Kaltura)
// and queue them as canvas_media sources so videos placed outside the gallery
// still get transcribed. Titles are resolved later, at fetch time. Bounded.
async function discoverEmbeddedMedia(source: SourceRow, rawHtml: string): Promise<void> {
  const entryIds = extractKalturaEntryIds(rawHtml).slice(0, 25);
  if (entryIds.length === 0) return;

  const rows = entryIds.map((entryId) => ({
    user_id: source.user_id,
    course_id: source.course_id,
    origin: "canvas_media",
    source_kind: "transcript_txt", // provisional; fetch sets the real format
    canvas_id: entryId,
    title: "Lecture video",
    module_name: "Lecture videos",
    folder_path: null,
    canvas_url: source.canvas_url, // deep-link to the page it was embedded on
    content_role: "material",
    status: "queued",
  }));

  const { error } = await service
    .from("polya_sources")
    .upsert(rows, { onConflict: "user_id,course_id,origin,canvas_id", ignoreDuplicates: true });
  if (error) {
    console.error(`[polya-import] embedded-media queue failed for ${source.id}:`, error.message);
  }
}

// Transcript (from storage): parse into timed segments, embed, ready.
async function advanceTranscript(source: SourceRow): Promise<string> {
  if (!source.storage_path) {
    await failSource(source.id, "Transcript file missing.");
    return "failed";
  }
  const bytes = await downloadFromStorage(source.storage_path);
  const raw = new TextDecoder().decode(bytes);
  const segments = parseTranscript(raw, source.source_kind);

  if (segments.length === 0) {
    await failSource(source.id, "Couldn't read any text from that transcript.");
    return "failed";
  }

  const inserted = await embedAndInsertTranscript(source, segments);
  await service
    .from("polya_sources")
    .update({ chunks_embedded: inserted, status: "ready" })
    .eq("id", source.id);
  return "ready";
}

async function courseCanvasId(polyaCourseId: string): Promise<[string, string]> {
  const { data } = await service
    .from("polya_courses")
    .select("canvas_course_id")
    .eq("id", polyaCourseId)
    .single();
  return [polyaCourseId, String(data?.canvas_course_id ?? "")];
}

async function failSource(sourceId: string, message: string, attempts?: number): Promise<void> {
  const update: Record<string, unknown> = {
    status: "failed",
    error: message,
    last_error_at: new Date().toISOString(),
  };
  if (attempts != null) update.attempts = attempts;
  await service.from("polya_sources").update(update).eq("id", sourceId);
}
