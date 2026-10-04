// Per-user request windows for Polya's edge functions (Phase 9 A-9, A-17).
// Pure module (no Deno globals) so Node's test runner covers it directly.
// Every window is claimed through the shared limiter (rate-limit.ts), which
// fails closed: a limiter error refuses the request.
//
// Starting values; tune after a week of logs, like appendix B.2's.

export const HOUR_SECONDS = 3_600;

// ---------------------------------------------------------------------------
// polya-import: three hourly windows, so the web app's progress polling can't
// crowd out what a student actually does, and a script can't spend the room
// the cheap reads need on starting imports.
//   - start:   enumerating Canvas, registering an upload, retrying or
//              deleting a course. Human-initiated, a handful per session.
//   - kick:    resuming the background worker. The sidebar indicator retries
//              it every 4 s while an import is paused; the 15-minute sweeper
//              revives a stalled worker anyway, so a refused kick costs
//              nothing.
//   - default: progress reads (every 4 s per open tab while importing),
//              per-item registration from the extension (up to ~300 per
//              course), and the refresh loop's process steps. Page and OCR
//              work is also metered per day (import-caps.ts).
// ---------------------------------------------------------------------------
export type ImportActionClass = "start" | "kick" | "default";

export const IMPORT_HOURLY_LIMITS: Readonly<Record<ImportActionClass, number>> = {
  start: 60,
  kick: 120,
  default: 7_200,
};

const IMPORT_BUCKETS: Readonly<Record<ImportActionClass, string>> = {
  start: "polya-import:start:hour",
  kick: "polya-import:kick:hour",
  default: "polya-import:hour",
};

const START_ACTIONS = new Set([
  "start",
  "extension_import_start",
  "add_upload",
  "retry_failed",
  "delete_course",
  "seed_fixture",
]);

export function importActionClass(action: unknown): ImportActionClass {
  if (typeof action !== "string") return "default";
  if (START_ACTIONS.has(action)) return "start";
  if (action === "kick") return "kick";
  return "default";
}

export function importRateWindow(action: unknown): { bucket: string; limit: number } {
  const actionClass = importActionClass(action);
  return { bucket: IMPORT_BUCKETS[actionClass], limit: IMPORT_HOURLY_LIMITS[actionClass] };
}

// polya-import's whole-request body cap. The largest real body is the
// extension's manifest (at most 500 entries of short metadata, well under
// 1 MB). `seed_fixture` carries base64 files, so where that action exists
// (local dev and QA only) the cap is larger.
export const IMPORT_MAX_BODY_BYTES = 1_048_576;
export const IMPORT_MAX_BODY_BYTES_WITH_SEED_FIXTURE = 25 * 1_048_576;

// ---------------------------------------------------------------------------
// polya-tutor: the hourly window under usage.ts's 100 turns/day, matching
// claude-proxy's 40/hr.
// ---------------------------------------------------------------------------
export const TUTOR_HOURLY_LIMIT = 40;
export const TUTOR_HOURLY_BUCKET = "polya-tutor:hour";

// ---------------------------------------------------------------------------
// polya-search: the daily window over its 120/hr (5x the hourly, the same
// ratio as gemini-proxy's 60/hr and 300/day).
// ---------------------------------------------------------------------------
export const SEARCH_DAILY_LIMIT = 600;
export const SEARCH_DAILY_BUCKET = "polya-search:day";
