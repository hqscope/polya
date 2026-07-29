// polya-import — enumerate a Canvas course into queued sources, report import
// progress, and register manually-uploaded transcripts.
// Actions: start | status | add_upload. (The `process` state machine that
// fetches/parses/chunks/embeds is added in M3.)
import { corsHeaders, json } from "../_shared/cors.ts";
import { HttpError, requireAuthUser } from "../_shared/auth-user.ts";
import { assertCourseOwned, assertUserStoragePath } from "../_shared/authz.ts";
import { loadConnectionWithToken } from "../_shared/connections.ts";
import { service, STORAGE_BUCKET } from "../_shared/service.ts";
import {
  CanvasAuthError,
  CanvasClient,
  extractKalturaEntryIds,
  type CanvasFileMeta,
} from "../_shared/canvas.ts";
import {
  listCourseMediaEntries,
  openCourseMediaSession,
  type KalturaMediaEntry,
} from "../_shared/kaltura.ts";
import { classifyContentRole } from "../_shared/content-roles.ts";
import { diffSources, type EnumeratedSource, type ExistingSourceRow } from "../_shared/enumerate.ts";
import {
  advanceClaimedSource,
  finishOrWait,
  newAdvanceContext,
  processOneStep,
  SOURCE_COLUMNS,
  type Connection,
} from "../_shared/process.ts";
import type { SourceRow } from "../_shared/ingest.ts";

// Local-only escape hatch so the mock-Canvas integration test can point a
// connection at 127.0.0.1. Never set in the deployed project.
const ALLOW_INSECURE_CANVAS = Deno.env.get("POLYA_ALLOW_INSECURE_CANVAS") === "1";

// Background worker (pump) config. The import runs server-side: `start` queues
// sources and kicks a self-chaining worker that claims a batch, processes it
// concurrently, and re-invokes itself until the queue drains — so imports keep
// going after the user navigates away or closes the tab.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// Low-privilege shared secret so the pg_cron sweeper (which can't hold the
// service-role key) can trigger the worker. Sent in the x-polya-pump-secret
// header alongside the public anon key (to pass the JWT gateway).
const PUMP_SECRET = Deno.env.get("POLYA_PUMP_SECRET") ?? "";
const PUMP_BATCH = 3; // sources advanced concurrently per cycle (bounds Gemini load)
const PUMP_BUDGET_MS = 60_000; // per-invocation wall budget, then hand off to a fresh one
// When every pending source is waiting out a retry backoff longer than this,
// the worker parks (drops its lease and exits) instead of chaining idle
// self-invocations; the pg_cron sweeper re-kicks once work comes due.
const PARK_MS = 5 * 60_000;
const LEASE_TTL_SECONDS = 150; // worker lease; a crashed worker frees it after this
const ENUMERATE_CONCURRENCY = 3; // courses enumerated at once in a multi-course start
const MAX_COURSES_PER_START = 20;

// Run a promise past the response in the Supabase edge runtime (keeps the
// invocation alive). Falls back to fire-and-forget locally where EdgeRuntime is
// absent.
function background(promise: Promise<unknown>): void {
  const er = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  if (er?.waitUntil) er.waitUntil(promise);
  else void promise;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// Bounded-concurrency map — enumerate several courses at once without a burst.
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

interface StartBody {
  action: "start";
  connection_id?: string;
  // One course (back-compat) or several at once ("import all" / multi-select).
  canvas_course_id?: string;
  canvas_course_ids?: string[];
  // Re-check every source even when Canvas reports no newer timestamp (covers
  // syllabus/module items that carry none). Used by "Check for updates".
  force?: boolean;
}
interface CourseBody {
  action: "status";
  course_id: string;
}
// Resume the background worker for the caller. Idempotent: no-ops if a worker
// already holds the lease. Used after start and by the client indicator to
// revive a stalled import.
interface KickBody {
  action: "kick";
}
// Read progress for every course the caller is importing (for the global
// background-import indicator), plus whether a worker is currently alive.
interface StatusAllBody {
  action: "status_all";
}
// Internal: the self-chaining background worker. Authenticated by the
// service-role key (see handlePump), NOT a user JWT.
interface PumpBody {
  action: "pump";
  user_id: string;
  lease_token: string;
}
interface UploadBody {
  action: "add_upload";
  course_id: string;
  storage_path: string;
  title: string;
  kind: "transcript_txt" | "transcript_json" | "transcript_vtt" | "transcript_srt";
}
interface ProcessBody {
  action: "process";
  course_id: string;
}
interface RetryFailedBody {
  action: "retry_failed";
  course_id: string;
}
// Remove a course the student no longer wants from their library, along with
// everything imported for it (sources, chunks, conversations) and its files.
interface DeleteCourseBody {
  action: "delete_course";
  course_id: string;
}
interface SeedFixtureBody {
  action: "seed_fixture";
  course_name: string;
  files: Array<{
    title: string;
    origin: string;
    source_kind: string;
    content_role?: string;
    content_base64: string;
    content_type: string;
    ext: string;
  }>;
}
// Canvascope-extension import: same account, zero pairing. The extension
// enumerates the course through the student's Canvas session, uploads content
// to storage under the user's prefix, and registers it here; the ordinary
// process pump ingests it (storage_path branch, no Canvas fetch).
interface ExtensionManifestEntry {
  origin: "canvas_file" | "canvas_page" | "canvas_assignment" | "canvas_syllabus";
  source_kind: "pdf" | "html";
  canvas_id: string;
  title: string;
  module_name?: string | null;
  folder_path?: string | null;
  canvas_url?: string | null;
  size_bytes?: number | null;
  canvas_updated_at?: string | null;
  due_at?: string | null;
  content_sha256: string;
  content_role?: string;
}
interface ExtensionImportStartBody {
  action: "extension_import_start";
  canvas: {
    base_url: string;
    course_id: string;
    name: string;
    code?: string | null;
    term_name?: string | null;
  };
  manifest: ExtensionManifestEntry[];
}
interface ExtensionRegisterSourceBody {
  action: "extension_register_source";
  course_id: string;
  source: ExtensionManifestEntry & { storage_path: string };
}

type Body =
  | StartBody
  | KickBody
  | StatusAllBody
  | PumpBody
  | CourseBody
  | UploadBody
  | ProcessBody
  | RetryFailedBody
  | DeleteCourseBody
  | SeedFixtureBody
  | ExtensionImportStartBody
  | ExtensionRegisterSourceBody;

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = (await request.json()) as Body;

    // The background worker authenticates with the service-role key, not a user
    // JWT — handle it before requireAuthUser.
    if (body.action === "pump") {
      return await handlePump(request, body);
    }

    const user = await requireAuthUser(request);

    switch (body.action) {
      case "start":
        return await handleStart(user.id, body);
      case "kick":
        return await handleKick(user.id);
      case "status":
        return await handleStatus(user.id, body.course_id);
      case "status_all":
        return await handleStatusAll(user.id);
      case "add_upload":
        return await handleAddUpload(user.id, body);
      case "process":
        return await handleProcess(user.id, body.course_id);
      case "retry_failed":
        return await handleRetryFailed(user.id, body.course_id);
      case "delete_course":
        return await handleDeleteCourse(user.id, body.course_id);
      case "seed_fixture":
        return await handleSeedFixture(user.id, body);
      case "extension_import_start":
        return await handleExtensionImportStart(user.id, body);
      case "extension_register_source":
        return await handleExtensionRegisterSource(user.id, body);
      default:
        return json({ error: "Unknown action", code: "bad_request" }, 400);
    }
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message, code: httpErrorCode(error.status) }, error.status);
    }
    if (error instanceof CanvasAuthError) {
      return json(
        { error: "Your Canvas access token stopped working — paste a new one.", code: "canvas_auth" },
        400,
      );
    }
    console.error("[polya-import] error:", error);
    return json({ error: "Something went wrong importing your course.", code: "internal" }, 500);
  }
});

type QueuedSource = EnumeratedSource;

async function handleStart(userId: string, body: StartBody): Promise<Response> {
  const connection = await loadConnectionWithToken(userId, body.connection_id);
  if (!connection) {
    return json({ error: "Connect your Canvas first.", code: "no_connection" }, 404);
  }

  const canvasCourseIds = normalizeCourseIds(body);
  if (canvasCourseIds.length === 0) {
    return json({ error: "Pick at least one course to bring in.", code: "bad_request" }, 400);
  }

  const client = new CanvasClient(connection.base_url, connection.access_token, {
    allowInsecure: ALLOW_INSECURE_CANVAS,
  });

  // Course headers (name/code/term) — one live course list for the whole batch.
  const courses = await client.listCourses();
  const metaById = new Map(courses.map((course) => [course.id, course]));

  // Enumerate the selected courses (metadata only — bytes come later, in the
  // background worker). Bounded concurrency so "import all" doesn't burst Canvas.
  const enumerated = await mapPool(canvasCourseIds, ENUMERATE_CONCURRENCY, (canvasCourseId) =>
    enumerateCourse(
      userId,
      connection,
      client,
      canvasCourseId,
      metaById.get(canvasCourseId),
      Boolean(body.force),
    ).catch((err) => {
      console.error(
        `[polya-import] enumerate ${canvasCourseId} failed:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }),
  );
  const ok = enumerated.filter((r): r is EnumeratedResult => r !== null);
  if (ok.length === 0) {
    return json({ error: "Couldn't start the import.", code: "internal" }, 500);
  }

  // Hand processing to the self-chaining background worker and return right away
  // so the student can start studying (here or in another course) while the rest
  // imports. The worker keeps going even if this tab closes.
  await kickPump(userId);

  const single = canvasCourseIds.length === 1 ? ok[0] : null;
  return json({
    courses: ok,
    // Back-compat single-course fields (older client + "check for updates").
    course_id: single?.course_id,
    source_count: single?.source_count,
    queued: single?.queued,
    refreshed: single?.refreshed,
    progress: single ? await countProgress(userId, single.course_id) : undefined,
  });
}

interface EnumeratedResult {
  course_id: string;
  canvas_course_id: string;
  name: string;
  source_count: number;
  queued: number;
  refreshed: number;
}

function normalizeCourseIds(body: StartBody): string[] {
  const raw = body.canvas_course_ids ?? (body.canvas_course_id ? [body.canvas_course_id] : []);
  return Array.from(
    new Set(raw.map((id) => String(id)).filter((id) => id.length > 0)),
  ).slice(0, MAX_COURSES_PER_START);
}

// Enumerate one course into queued sources and reconcile against what's already
// imported (insert new, re-queue changed, patch cheap metadata). Does NOT fetch
// bytes — the background worker does that. Returns per-course counts. Throws on a
// hard failure so the caller can drop just this course from the batch.
async function enumerateCourse(
  userId: string,
  connection: { id: string; base_url: string },
  client: CanvasClient,
  canvasCourseId: string,
  courseMeta: { name?: string; code?: string | null; termName?: string | null } | undefined,
  force: boolean,
): Promise<EnumeratedResult> {
  const courseId = canvasCourseId;
  const meta = courseMeta;

  const { data: courseRow, error: courseError } = await service
    .from("polya_courses")
    .upsert(
      {
        user_id: userId,
        connection_id: connection.id,
        canvas_course_id: courseId,
        name: meta?.name ?? `Course ${courseId}`,
        code: meta?.code ?? null,
        term_name: meta?.termName ?? null,
        import_status: "importing",
      },
      { onConflict: "user_id,canvas_course_id" },
    )
    .select("id")
    .single();

  if (courseError || !courseRow) {
    throw new Error(`course upsert failed: ${courseError?.message}`);
  }
  const polyaCourseId = courseRow.id as string;

  // Enumerate sources concurrently (metadata only — bytes come during process).
  // Module items are included because some courses hide the flat /pages and
  // /files index APIs from students and push everything through Modules; the
  // per-enumerator catch logs (not swallows silently) so a lockout is visible.
  const [pdfFiles, pages, assignments, syllabusText, moduleItems, mediaEntries] = await Promise.all([
    client.listPdfFiles(courseId).catch((e) => warnEmpty("listPdfFiles", e)),
    client.listPages(courseId).catch((e) => warnEmpty("listPages", e)),
    client.listAssignments(courseId).catch((e) => warnEmpty("listAssignments", e)),
    client.getCourseSyllabusText(courseId).catch((e) => {
      console.warn("[polya-import] getCourseSyllabusText failed:", e instanceof Error ? e.message : e);
      return null;
    }),
    client.listModuleItems(courseId).catch((e) => warnEmpty("listModuleItems", e)),
    enumerateMediaEntries(client, courseId).catch((e) => warnEmpty("enumerateMedia", e)),
  ]);

  // Diagnostic: log which nav tabs the student token can see so a "pages/files
  // missing" report is traceable to a hidden tab (best-effort; never fatal).
  const hiddenTabs = await client
    .listTabs(courseId)
    .then((tabs) => tabs.filter((t) => t.hidden || t.type === "external").map((t) => t.id))
    .catch(() => [] as string[]);

  const sources: QueuedSource[] = [];

  for (const entry of mediaEntries) {
    sources.push({
      user_id: userId,
      course_id: polyaCourseId,
      origin: "canvas_media",
      // Provisional; the fetch stage overwrites it with the real transcript
      // format (routing is by origin, so this never mis-routes).
      source_kind: "transcript_txt",
      canvas_id: entry.entryId,
      title: entry.title,
      module_name: "Lecture videos",
      folder_path: null,
      canvas_url: entry.canvasUrl,
      content_role: "material",
      size_bytes: null,
      canvas_updated_at: entry.updatedAt,
      due_at: null,
      status: "queued",
    });
  }

  for (const file of pdfFiles) {
    sources.push({
      user_id: userId,
      course_id: polyaCourseId,
      origin: "canvas_file",
      source_kind: "pdf",
      canvas_id: file.fileId,
      title: file.title,
      module_name: file.moduleName,
      folder_path: file.folderPath || null,
      canvas_url: file.downloadUrl,
      content_role: classifyContentRole({
        origin: "canvas_file",
        title: file.title,
        folderPath: file.folderPath,
        moduleName: file.moduleName,
      }),
      size_bytes: file.sizeBytes,
      canvas_updated_at: file.updatedAt,
      due_at: null,
      status: "queued",
    });
  }

  for (const page of pages) {
    sources.push({
      user_id: userId,
      course_id: polyaCourseId,
      origin: "canvas_page",
      source_kind: "html",
      canvas_id: page.urlSlug,
      title: page.title,
      module_name: null,
      folder_path: null,
      canvas_url: page.htmlUrl,
      content_role: "material",
      size_bytes: null,
      canvas_updated_at: page.updatedAt,
      due_at: null,
      status: "queued",
    });
  }

  for (const assignment of assignments) {
    if (!assignment.descriptionHtml) continue; // nothing to index
    sources.push({
      user_id: userId,
      course_id: polyaCourseId,
      origin: "canvas_assignment",
      source_kind: "html",
      canvas_id: assignment.assignmentId,
      title: assignment.title,
      module_name: null,
      folder_path: null,
      canvas_url: assignment.htmlUrl,
      content_role: "assignment",
      size_bytes: null,
      canvas_updated_at: assignment.updatedAt,
      due_at: assignment.dueAt ?? null,
      status: "queued",
    });
  }

  if (syllabusText) {
    sources.push({
      user_id: userId,
      course_id: polyaCourseId,
      origin: "canvas_syllabus",
      source_kind: "html",
      canvas_id: "syllabus",
      title: "Course syllabus",
      module_name: null,
      folder_path: null,
      canvas_url: `${connection.base_url}/courses/${courseId}/assignments/syllabus`,
      content_role: "syllabus",
      size_bytes: null,
      canvas_updated_at: null,
      due_at: null,
      status: "queued",
    });
  }

  // Recover Pages and Files that the flat index APIs hid, from module items.
  const seen = new Set(sources.map((s) => `${s.origin}:${s.canvas_id ?? ""}`));

  for (const item of moduleItems) {
    if (item.type !== "Page" || !item.pageUrl) continue;
    const key = `canvas_page:${item.pageUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      user_id: userId,
      course_id: polyaCourseId,
      origin: "canvas_page",
      source_kind: "html",
      canvas_id: item.pageUrl,
      title: item.title || item.pageUrl,
      module_name: item.moduleName,
      folder_path: null,
      canvas_url: item.htmlUrl,
      content_role: "material",
      size_bytes: null,
      canvas_updated_at: null,
      due_at: null,
      status: "queued",
    });
  }

  // Lecture videos linked as a module item (ExternalUrl/ExternalTool pointing at
  // a Kaltura entry) — queue them as media sources; the fetch stage resolves the
  // title and transcript.
  for (const item of moduleItems) {
    if (!item.externalUrl) continue;
    const [entryId] = extractKalturaEntryIds(item.externalUrl);
    if (!entryId) continue;
    const key = `canvas_media:${entryId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      user_id: userId,
      course_id: polyaCourseId,
      origin: "canvas_media",
      source_kind: "transcript_txt",
      canvas_id: entryId,
      title: item.title || "Lecture video",
      module_name: item.moduleName ?? "Lecture videos",
      folder_path: null,
      canvas_url: item.htmlUrl ?? item.externalUrl,
      content_role: "material",
      size_bytes: null,
      canvas_updated_at: null,
      due_at: null,
      status: "queued",
    });
  }

  // Files attached directly to modules (not via a page): resolve metadata to
  // keep only PDFs, bounded so enumeration stays quick. Page-embedded files are
  // discovered later, lazily, while each page is processed.
  const moduleFileMeta = new Map(
    moduleItems
      .filter((item) => item.type === "File" && item.fileId)
      .map((item) => [item.fileId as string, { title: item.title, moduleName: item.moduleName }]),
  );
  const moduleFileIds = Array.from(moduleFileMeta.keys()).filter(
    (id) => !seen.has(`canvas_file:${id}`),
  );
  for (const meta of await resolveModulePdfs(client, courseId, moduleFileIds)) {
    const key = `canvas_file:${meta.fileId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const extra = moduleFileMeta.get(meta.fileId);
    sources.push({
      user_id: userId,
      course_id: polyaCourseId,
      origin: "canvas_file",
      source_kind: "pdf",
      canvas_id: meta.fileId,
      title: extra?.title || meta.title,
      module_name: extra?.moduleName ?? null,
      folder_path: null,
      canvas_url: meta.downloadUrl,
      content_role: classifyContentRole({
        origin: "canvas_file",
        title: meta.title,
        moduleName: extra?.moduleName,
      }),
      size_bytes: meta.sizeBytes,
      canvas_updated_at: null,
      due_at: null,
      status: "queued",
    });
  }

  // Counts only (no content/token) — confirms which enumeration paths a course
  // exposes to a student token, so a "pages/files missing" report is diagnosable.
  console.log(
    `[polya-import] course ${courseId} enumerated:`,
    JSON.stringify({
      flat_files: pdfFiles.length,
      flat_pages: pages.length,
      assignments: assignments.length,
      module_items: moduleItems.length,
      media_entries: mediaEntries.length,
      hidden_or_external_tabs: hiddenTabs,
      queued_total: sources.length,
    }),
  );

  // Diff against what's already imported: brand-new sources are queued, sources
  // whose Canvas copy looks newer are re-queued for a hash-checked refresh, and
  // cheap metadata (title, due date) is kept current on unchanged rows.
  const { data: existingRows } = await service
    .from("polya_sources")
    .select("id, origin, canvas_id, canvas_updated_at, status, due_at, title, canvas_url")
    .eq("user_id", userId)
    .eq("course_id", polyaCourseId);
  const diff = diffSources(sources, (existingRows ?? []) as ExistingSourceRow[], force);

  if (diff.toInsert.length > 0) {
    // ignoreDuplicates kept as a race guard (two concurrent starts).
    const { error: insertError } = await service
      .from("polya_sources")
      .upsert(diff.toInsert, {
        onConflict: "user_id,course_id,origin,canvas_id",
        ignoreDuplicates: true,
      });
    if (insertError) {
      throw new Error(`source insert failed: ${insertError.message}`);
    }
  }
  for (const { id, patch } of [...diff.toRefresh, ...diff.toPatch]) {
    const { error: patchError } = await service.from("polya_sources").update(patch).eq("id", id);
    if (patchError) {
      console.error(`[polya-import] source patch failed for ${id}:`, patchError.message);
    }
  }

  console.log(
    `[polya-import] course ${courseId} diff:`,
    JSON.stringify({
      inserted: diff.toInsert.length,
      refreshed: diff.toRefresh.length,
      patched: diff.toPatch.length,
    }),
  );

  return {
    course_id: polyaCourseId,
    canvas_course_id: canvasCourseId,
    name: meta?.name ?? `Course ${canvasCourseId}`,
    source_count: sources.length,
    queued: diff.toInsert.length,
    refreshed: diff.toRefresh.length,
  };
}

async function handleStatus(userId: string, courseId: string): Promise<Response> {
  const progress = await countProgress(userId, courseId);
  const { data: sources } = await service
    .from("polya_sources")
    .select("id, title, origin, source_kind, module_name, status, error, page_count, chunks_embedded")
    .eq("user_id", userId)
    .eq("course_id", courseId)
    .order("created_at", { ascending: true });

  return json({ course_id: courseId, progress, sources: sources ?? [] });
}

async function handleAddUpload(userId: string, body: UploadBody): Promise<Response> {
  // The client uploaded the transcript to storage under its own uid prefix;
  // register it as a queued source for the process pump to pick up. Both ids
  // come from the client, so prove ownership before the service-role insert.
  await assertCourseOwned(userId, body.course_id);
  assertUserStoragePath(userId, body.storage_path);
  const { data, error } = await service
    .from("polya_sources")
    .insert({
      user_id: userId,
      course_id: body.course_id,
      origin: "upload_transcript",
      source_kind: body.kind,
      canvas_id: null,
      title: body.title,
      storage_path: body.storage_path,
      content_role: "material",
      status: "queued",
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[polya-import] add_upload failed:", error?.message);
    return json({ error: "Couldn't add that transcript.", code: "internal" }, 500);
  }
  await kickPump(userId); // process the uploaded transcript in the background
  return json({ source_id: data.id });
}

// One bounded pump step: advance a single source, then report progress.
async function handleProcess(userId: string, courseId: string): Promise<Response> {
  const connection = await loadConnectionWithToken(userId); // may be null for fixture/upload-only courses
  const result = await processOneStep(
    userId,
    courseId,
    connection
      ? {
          base_url: connection.base_url,
          access_token: connection.access_token,
          allow_insecure: ALLOW_INSECURE_CANVAS,
        }
      : null,
  );
  const progress = await countProgress(userId, courseId);
  return json({ ...result, progress });
}

// ---------------------------------------------------------------------------
// Background import worker (pump)
//
// `start`/`kick` acquire a per-user lease and fire a `pump` invocation; each
// pump drains a batch, renews the lease, and re-invokes itself (self-fetch)
// until the queue empties — so imports finish server-side without the client
// looping, and keep going after the tab closes. Correctness (no double-process)
// comes from the per-row `for update skip locked` claim lease, not this worker
// lease, so a stray second worker is harmless.
// ---------------------------------------------------------------------------

// Kick the worker for this user. Idempotent: returns false if a worker already
// holds the lease (it picks up newly-queued work on its next cycle).
async function kickPump(userId: string): Promise<boolean> {
  const token = await acquireLease(userId);
  if (!token) return false;
  const ok = await selfInvokePump(userId, token);
  if (!ok) {
    // Couldn't reach the worker — drop the lease so a later kick can retry
    // instead of waiting out the TTL.
    await releaseLease(userId);
    return false;
  }
  return true;
}

async function handleKick(userId: string): Promise<Response> {
  const kicked = await kickPump(userId);
  return json({ kicked });
}

// Internal worker entrypoint. Authenticated by the service-role key (used by the
// self-invoke chain) OR the pump secret in a header (used by the pg_cron
// sweeper) — never a user JWT. The browser holds neither. Returns immediately;
// the drain loop runs as a background task so the trigger doesn't block.
async function handlePump(request: Request, body: PumpBody): Promise<Response> {
  const auth = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
  const pumpSecret = request.headers.get("x-polya-pump-secret")?.trim() ?? "";
  const authorized =
    (SERVICE_ROLE_KEY !== "" && auth === SERVICE_ROLE_KEY) ||
    (PUMP_SECRET !== "" && pumpSecret === PUMP_SECRET);
  if (!authorized) {
    return json({ error: "Not authorized.", code: "forbidden" }, 403);
  }
  if (!body.user_id || !body.lease_token) {
    return json({ error: "Missing worker parameters.", code: "bad_request" }, 400);
  }
  background(runPump(body.user_id, body.lease_token));
  return json({ ok: true });
}

async function acquireLease(userId: string): Promise<string | null> {
  const { data, error } = await service.rpc("polya_acquire_import_lease", {
    p_user_id: userId,
    p_ttl_seconds: LEASE_TTL_SECONDS,
  });
  if (error) {
    console.error("[polya-import] acquire lease failed:", error.message);
    return null;
  }
  return (data as string | null) ?? null;
}

async function renewLease(userId: string, token: string): Promise<boolean> {
  const { data, error } = await service.rpc("polya_renew_import_lease", {
    p_user_id: userId,
    p_token: token,
    p_ttl_seconds: LEASE_TTL_SECONDS,
  });
  if (error) {
    console.error("[polya-import] renew lease failed:", error.message);
    return false;
  }
  return data === true;
}

async function releaseLease(userId: string): Promise<void> {
  const { error } = await service.rpc("polya_release_import_lease", { p_user_id: userId });
  if (error) console.error("[polya-import] release lease failed:", error.message);
}

// Fire a fresh pump invocation (initial kick or hand-off at the budget). Returns
// whether the worker acknowledged.
async function selfInvokePump(userId: string, token: string): Promise<boolean> {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error("[polya-import] cannot self-invoke pump: missing SUPABASE_URL / service key");
    return false;
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/polya-import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ action: "pump", user_id: userId, lease_token: token }),
    });
    return res.ok;
  } catch (err) {
    console.error(
      "[polya-import] pump self-invoke failed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

// Drain queued sources across ALL of the user's importing courses until the
// queue empties or the wall budget is hit (then hand off to a fresh invocation).
async function runPump(userId: string, token: string): Promise<void> {
  const deadline = Date.now() + PUMP_BUDGET_MS;
  const connByCourse = new Map<string, Connection | null>();
  // Shared across this invocation so lecture videos from the same course reuse
  // one media session instead of re-running the LTI dance per entry.
  const ctx = newAdvanceContext();

  try {
    while (true) {
      if (!(await renewLease(userId, token))) return; // superseded by a newer worker

      const { data: claimed, error } = await service
        .rpc("polya_claim_import_batch", {
          p_user_id: userId,
          p_course_id: null,
          p_limit: PUMP_BATCH,
        })
        .select(SOURCE_COLUMNS);
      if (error) {
        console.error("[polya-import] pump claim failed:", error.message);
        return;
      }
      const sources = (claimed ?? []) as SourceRow[];

      if (sources.length > 0) {
        await Promise.all(
          sources.map(async (source) => {
            const connection = await resolveConnection(userId, source, connByCourse);
            await advanceClaimedSource(source, connection, ctx);
          }),
        );
        if (Date.now() >= deadline) {
          await selfInvokePump(userId, token); // hand off to a fresh invocation
          return;
        }
        continue;
      }

      // Nothing claimable: finalize done courses, and find how long until a
      // backing-off source is claimable again (null = everything is finished).
      const wait = await finalizeAndComputeWait(userId);
      if (wait === null) {
        await releaseLease(userId);
        return;
      }
      if (wait >= PARK_MS) {
        // Everything pending is deep in backoff (e.g. a daily quota). Park —
        // otherwise the hand-off below would chain idle invocations for hours.
        await releaseLease(userId);
        return;
      }
      const remaining = deadline - Date.now();
      if (wait >= remaining) {
        await selfInvokePump(userId, token);
        return;
      }
      await sleep(wait);
    }
  } catch (err) {
    console.error("[polya-import] pump error:", err instanceof Error ? err.message : err);
    // Leave the lease to expire; the client indicator re-kicks on a stall.
  }
}

// Resolve (and cache) the Canvas connection for a source's course. Sources whose
// bytes are already in storage (fixtures/uploads/extension) don't need one.
async function resolveConnection(
  userId: string,
  source: SourceRow,
  cache: Map<string, Connection | null>,
): Promise<Connection | null> {
  if (cache.has(source.course_id)) return cache.get(source.course_id) ?? null;

  const { data: course } = await service
    .from("polya_courses")
    .select("connection_id")
    .eq("id", source.course_id)
    .maybeSingle();
  const connectionId = (course?.connection_id as string | null) ?? undefined;
  const loaded = await loadConnectionWithToken(userId, connectionId);
  const connection: Connection | null = loaded
    ? {
        base_url: loaded.base_url,
        access_token: loaded.access_token,
        allow_insecure: ALLOW_INSECURE_CANVAS,
      }
    : null;
  cache.set(source.course_id, connection);
  return connection;
}

// Mark every importing course whose work is done as complete (emits the
// completion event), and return the shortest delay until a still-pending source
// is claimable again — or null when nothing is left to do for the user.
async function finalizeAndComputeWait(userId: string): Promise<number | null> {
  const { data: courses } = await service
    .from("polya_courses")
    .select("id")
    .eq("user_id", userId)
    .eq("import_status", "importing");
  const importing = (courses ?? []).map((c) => c.id as string);
  if (importing.length === 0) return null;

  let allDone = true;
  let soonest: number | null = null;
  for (const courseId of importing) {
    const res = await finishOrWait(userId, courseId);
    if (!res.done) {
      allDone = false;
      // Prefer the uncapped wait so long backoffs park the worker instead of
      // being clamped to the lease window and spinning.
      const w = res.next_work_in_ms ?? res.retry_after_ms ?? 1500;
      soonest = soonest === null ? w : Math.min(soonest, w);
    }
  }
  return allDone ? null : (soonest ?? 1500);
}

// Progress for every course the caller is importing, plus whether a worker is
// currently alive — the client indicator polls this and re-kicks on a stall.
async function handleStatusAll(userId: string): Promise<Response> {
  const { data: courses } = await service
    .from("polya_courses")
    .select("id, name, import_status")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  const importing = (courses ?? []).filter((c) => c.import_status === "importing");
  const out: Array<{ course_id: string; name: string; progress: Progress }> = [];
  for (const course of importing) {
    out.push({
      course_id: course.id as string,
      name: course.name as string,
      progress: await countProgress(userId, course.id as string),
    });
  }

  const { data: job } = await service
    .from("polya_import_jobs")
    .select("status, leased_until")
    .eq("user_id", userId)
    .maybeSingle();
  const workerAlive = Boolean(
    job &&
      job.status === "running" &&
      job.leased_until &&
      new Date(job.leased_until as string).getTime() > Date.now(),
  );

  return json({ courses: out, worker_alive: workerAlive });
}

// Re-queue everything that was skipped/failed (or needs OCR) so a fresh pass can
// pick it up — e.g. after enabling Gemini billing or a transient outage clears.
// Clears any partial output first so a clean re-parse can't duplicate units.
async function handleRetryFailed(userId: string, courseId: string): Promise<Response> {
  const { data: rows } = await service
    .from("polya_sources")
    .select("id")
    .eq("user_id", userId)
    .eq("course_id", courseId)
    .in("status", ["failed", "needs_ocr"]);
  const ids = (rows ?? []).map((row) => row.id as string);

  if (ids.length > 0) {
    await service.from("polya_content_units").delete().in("source_id", ids);
    await service.from("polya_procedures").delete().in("source_id", ids);
    await service
      .from("polya_sources")
      .update({
        status: "queued",
        attempts: 0,
        error: null,
        claimed_at: null,
        next_attempt_at: null,
        pages_parsed: 0,
        chunks_embedded: 0,
      })
      .in("id", ids);
    await service
      .from("polya_courses")
      .update({ import_status: "importing" })
      .eq("id", courseId)
      .eq("user_id", userId);
    await kickPump(userId); // process the re-queued items in the background
  }

  const progress = await countProgress(userId, courseId);
  return json({ course_id: courseId, retried: ids.length, progress });
}

// Permanently remove a course from the caller's library. Deletes the course row
// — FK `on delete cascade` clears its sources, content units, procedures,
// policies, mastery checks, and conversations — after best-effort removal of the
// stored files (storage isn't covered by the DB cascade).
async function handleDeleteCourse(userId: string, courseId: string): Promise<Response> {
  await assertCourseOwned(userId, courseId);

  const { data: stored } = await service
    .from("polya_sources")
    .select("storage_path")
    .eq("user_id", userId)
    .eq("course_id", courseId)
    .not("storage_path", "is", null);
  const paths = (stored ?? [])
    .map((row) => row.storage_path as string | null)
    .filter((path): path is string => !!path);
  if (paths.length > 0) {
    // Best-effort: a failed file delete must not block removing the course.
    await service.storage.from(STORAGE_BUCKET).remove(paths);
  }

  const { error } = await service
    .from("polya_courses")
    .delete()
    .eq("id", courseId)
    .eq("user_id", userId);
  if (error) {
    console.error("[polya-import] delete_course failed:", error);
    throw new HttpError("Couldn't remove that course. Try again.", 500);
  }

  return json({ ok: true, course_id: courseId });
}

// Seed a synthetic course directly from uploaded bytes (no Canvas) — used by the
// fixture seeder and QA. Uploads each file to storage and queues it so the same
// process pump ingests it.
async function handleSeedFixture(userId: string, body: SeedFixtureBody): Promise<Response> {
  const canvasCourseId = `fixture-${crypto.randomUUID().slice(0, 8)}`;
  const { data: courseRow, error: courseError } = await service
    .from("polya_courses")
    .insert({
      user_id: userId,
      canvas_course_id: canvasCourseId,
      name: body.course_name,
      import_status: "importing",
    })
    .select("id")
    .single();
  if (courseError || !courseRow) {
    return json({ error: "Couldn't create the fixture course.", code: "internal" }, 500);
  }
  const courseId = courseRow.id as string;

  for (const file of body.files) {
    const { data: sourceRow, error: sourceError } = await service
      .from("polya_sources")
      .insert({
        user_id: userId,
        course_id: courseId,
        origin: file.origin,
        source_kind: file.source_kind,
        canvas_id: null,
        title: file.title,
        content_role: file.content_role ?? "material",
        status: "queued",
      })
      .select("id")
      .single();
    if (sourceError || !sourceRow) {
      return json({ error: "Couldn't queue a fixture file.", code: "internal" }, 500);
    }
    const sourceId = sourceRow.id as string;
    const storagePath = `${userId}/${courseId}/${sourceId}/original.${file.ext}`;
    const bytes = Uint8Array.from(atob(file.content_base64), (c) => c.charCodeAt(0));
    const { error: uploadError } = await service.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, bytes, { contentType: file.content_type, upsert: true });
    if (uploadError) {
      return json({ error: `Fixture upload failed: ${uploadError.message}`, code: "internal" }, 500);
    }
    await service.from("polya_sources").update({ storage_path: storagePath }).eq("id", sourceId);
  }

  const progress = await countProgress(userId, courseId);
  return json({ course_id: courseId, source_count: body.files.length, progress });
}

const EXTENSION_ORIGINS = new Set([
  "canvas_file",
  "canvas_page",
  "canvas_assignment",
  "canvas_syllabus",
]);
const EXTENSION_KINDS = new Set(["pdf", "html"]);
const EXTENSION_MANIFEST_MAX = 500;

function validManifestEntry(entry: ExtensionManifestEntry): boolean {
  return (
    EXTENSION_ORIGINS.has(entry.origin) &&
    EXTENSION_KINDS.has(entry.source_kind) &&
    typeof entry.canvas_id === "string" &&
    entry.canvas_id.length > 0 &&
    typeof entry.title === "string" &&
    typeof entry.content_sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(entry.content_sha256)
  );
}

// Upsert the course and diff the extension's manifest (by content hash — the
// extension hashed the exact bytes it would upload) against what's stored.
// Returns which items actually need uploading.
async function handleExtensionImportStart(
  userId: string,
  body: ExtensionImportStartBody,
): Promise<Response> {
  const canvasCourseId = String(body.canvas?.course_id ?? "").trim();
  const courseName = String(body.canvas?.name ?? "").trim();
  if (!canvasCourseId || !courseName || !Array.isArray(body.manifest)) {
    return json({ error: "Missing course details.", code: "bad_request" }, 400);
  }
  if (body.manifest.length > EXTENSION_MANIFEST_MAX) {
    return json({ error: "That course has too many items to bring in at once.", code: "bad_request" }, 400);
  }
  const manifest = body.manifest.filter(validManifestEntry);

  // Keyed on (user_id, canvas_course_id) so a PAT import and an extension
  // import of the same course converge on ONE course row. connection_id is
  // deliberately omitted: on conflict it keeps any existing PAT connection.
  const { data: courseRow, error: courseError } = await service
    .from("polya_courses")
    .upsert(
      {
        user_id: userId,
        canvas_course_id: canvasCourseId,
        name: courseName,
        code: body.canvas.code ?? null,
        term_name: body.canvas.term_name ?? null,
        import_status: "importing",
      },
      { onConflict: "user_id,canvas_course_id" },
    )
    .select("id")
    .single();
  if (courseError || !courseRow) {
    console.error("[polya-import] extension course upsert failed:", courseError?.message);
    return json({ error: "Couldn't start the import.", code: "internal" }, 500);
  }
  const courseId = courseRow.id as string;

  const { data: existingRows } = await service
    .from("polya_sources")
    .select("origin, canvas_id, content_sha256, status")
    .eq("user_id", userId)
    .eq("course_id", courseId);
  const byKey = new Map(
    ((existingRows ?? []) as Array<{
      origin: string;
      canvas_id: string | null;
      content_sha256: string | null;
      status: string;
    }>)
      .filter((row) => row.canvas_id !== null)
      .map((row) => [`${row.origin}:${row.canvas_id}`, row]),
  );

  const needed: Array<{ origin: string; canvas_id: string; reason: "new" | "changed" }> = [];
  let unchanged = 0;
  for (const entry of manifest) {
    const current = byKey.get(`${entry.origin}:${entry.canvas_id}`);
    if (!current) {
      needed.push({ origin: entry.origin, canvas_id: entry.canvas_id, reason: "new" });
    } else if (
      current.content_sha256 !== entry.content_sha256 ||
      current.status === "failed" ||
      current.status === "needs_ocr"
    ) {
      needed.push({ origin: entry.origin, canvas_id: entry.canvas_id, reason: "changed" });
    } else {
      unchanged++;
    }
  }

  return json({ course_id: courseId, needed, unchanged });
}

// Register one uploaded item as a queued source for the pump. New rows ingest
// from storage like fixtures/uploads; existing rows go through the hash-checked
// refresh path so unchanged bytes don't rebuild anything.
async function handleExtensionRegisterSource(
  userId: string,
  body: ExtensionRegisterSourceBody,
): Promise<Response> {
  const source = body.source;
  if (!source || !validManifestEntry(source) || typeof source.storage_path !== "string") {
    return json({ error: "That item can't be added.", code: "bad_request" }, 400);
  }
  await assertCourseOwned(userId, body.course_id);
  assertUserStoragePath(userId, source.storage_path);

  const { data: existing } = await service
    .from("polya_sources")
    .select("id")
    .eq("user_id", userId)
    .eq("course_id", body.course_id)
    .eq("origin", source.origin)
    .eq("canvas_id", source.canvas_id)
    .maybeSingle();

  const shared = {
    title: source.title,
    module_name: source.module_name ?? null,
    folder_path: source.folder_path ?? null,
    canvas_url: source.canvas_url ?? null,
    size_bytes: source.size_bytes ?? null,
    canvas_updated_at: source.canvas_updated_at ?? null,
    due_at: source.due_at ?? null,
    storage_path: source.storage_path,
    status: "queued" as const,
    attempts: 0,
    error: null,
    claimed_at: null,
    pages_parsed: 0,
  };

  if (existing) {
    const { error } = await service
      .from("polya_sources")
      .update({ ...shared, needs_refresh: true })
      .eq("id", existing.id as string);
    if (error) {
      console.error("[polya-import] extension source update failed:", error.message);
      return json({ error: "Couldn't add that item.", code: "internal" }, 500);
    }
    await kickPump(userId); // process the (re)registered item in the background
    return json({ source_id: existing.id });
  }

  const { data, error } = await service
    .from("polya_sources")
    .insert({
      user_id: userId,
      course_id: body.course_id,
      origin: source.origin,
      source_kind: source.source_kind,
      canvas_id: source.canvas_id,
      content_role:
        source.content_role ??
        classifyContentRole({
          origin: source.origin,
          title: source.title,
          folderPath: source.folder_path ?? undefined,
          moduleName: source.module_name ?? undefined,
        }),
      ...shared,
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("[polya-import] extension source insert failed:", error?.message);
    return json({ error: "Couldn't add that item.", code: "internal" }, 500);
  }
  await kickPump(userId); // process the registered item in the background
  return json({ source_id: data.id });
}

// ---------------------------------------------------------------------------
function httpErrorCode(status: number): string {
  if (status === 404) return "not_found";
  if (status === 403) return "forbidden";
  if (status === 400) return "bad_request";
  return "unauthorized";
}

// Enumerator failure → log and treat as empty (non-fatal; another source path
// may still work).
function warnEmpty(label: string, error: unknown): never[] {
  console.warn(`[polya-import] ${label} failed:`, error instanceof Error ? error.message : error);
  return [];
}

interface MediaSourceEntry extends KalturaMediaEntry {
  canvasUrl: string;
}

// Discover the course's Kaltura media gallery and list its lecture videos.
// Returns each entry with a Canvas deep-link (the gallery tool tab) for the
// "Open in Canvas" affordance. Transcript availability is resolved later, at
// fetch time — enumeration stays cheap (one LTI dance per course).
async function enumerateMediaEntries(
  client: CanvasClient,
  courseId: string,
): Promise<MediaSourceEntry[]> {
  const media = await openCourseMediaSession(client, courseId);
  if (!media) return []; // course has no Kaltura tool
  const galleryUrl = `${client.baseUrl}/courses/${courseId}/external_tools/${media.tool.id}`;
  const entries = await listCourseMediaEntries(media.session);
  return entries.map((entry) => ({ ...entry, canvasUrl: galleryUrl }));
}

// Resolve module File ids → PDF metadata, bounded (cap + limited concurrency) so
// enumeration stays fast. Non-PDF and inaccessible files are dropped.
async function resolveModulePdfs(
  client: CanvasClient,
  courseId: string,
  fileIds: string[],
): Promise<CanvasFileMeta[]> {
  const capped = fileIds.slice(0, 100);
  const concurrency = 8;
  const out: CanvasFileMeta[] = [];
  for (let i = 0; i < capped.length; i += concurrency) {
    const batch = capped.slice(i, i + concurrency);
    const metas = await Promise.all(
      batch.map((id) => client.getFileMeta(courseId, id).catch(() => null)),
    );
    for (const meta of metas) {
      if (meta && meta.isPdf) out.push(meta);
    }
  }
  return out;
}

interface Progress {
  total: number;
  queued: number;
  fetching: number;
  parsing: number;
  embedding: number;
  ready: number;
  failed: number;
  skipped: number;
  needs_ocr: number;
}

async function countProgress(userId: string, courseId: string): Promise<Progress> {
  const { data } = await service
    .from("polya_sources")
    .select("status")
    .eq("user_id", userId)
    .eq("course_id", courseId);

  const progress: Progress = {
    total: 0,
    queued: 0,
    fetching: 0,
    parsing: 0,
    embedding: 0,
    ready: 0,
    failed: 0,
    skipped: 0,
    needs_ocr: 0,
  };
  for (const row of data ?? []) {
    progress.total += 1;
    const status = row.status as keyof Progress;
    if (status in progress) progress[status] += 1;
  }
  return progress;
}
