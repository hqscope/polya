// Per-user daily caps on import work that costs money or heavy CPU: PDF pages
// parsed, and image-only pages sent to OCR (one Gemini call each). Pure module
// (no Deno globals) so Node's test runner covers it directly.
//
// Sizing, from plans/september-2026/COSTS.md §1: a typical course is about
// 1,620 PDF pages, of which about 320 need OCR (worst case 1,120-1,620 if every
// slide deck is image-only), at about $0.00135 per OCR page.
//   - 10,000 pages/day  ~ six typical courses, so "import all" for a normal
//     term load finishes the same day.
//   - 2,000 OCR pages/day ~ six typical courses' OCR, or one fully image-only
//     course; worst-case OCR spend is about $2.70 per user per day.
// Hitting a cap never fails an import: the source waits and resumes after the
// daily reset (UTC midnight) through the pump's normal retry backoff.
// OCR pages and document embeddings also draw on the project-wide Gemini
// budget (ai-budget.ts, R-5), which waits for the reset the same way.
import { incrementUsageDaily, type RpcClient } from "./rate-limit.ts";
import { claimAiBudget, estimateEmbeddingUnits, OCR_PAGE_UNITS } from "./ai-budget.ts";

export const DAILY_PDF_PAGE_CAP = 10_000;
export const DAILY_OCR_PAGE_CAP = 2_000;

export type ImportUnit = "pages" | "ocr";

const BUCKETS: Record<ImportUnit, { bucket: string; cap: number }> = {
  pages: { bucket: "polya-import:pages", cap: DAILY_PDF_PAGE_CAP },
  ocr: { bucket: "polya-import:ocr-pages", cap: DAILY_OCR_PAGE_CAP },
};

export function importCapBucket(unit: ImportUnit): { bucket: string; cap: number } {
  return BUCKETS[unit];
}

export function msUntilUtcMidnight(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1_000, next - now.getTime());
}

// Duck-typed transient errors: process.ts's isTransient() retries anything with
// `transient: true`, backoff.ts reads `retryAfterMs` / `daily`, and a `daily`
// error gates the user's other queued sources too (isProviderWide).
export class DailyImportCapError extends Error {
  readonly transient = true;
  readonly daily = true;
  readonly retryAfterMs: number;
  readonly unit: ImportUnit;
  constructor(unit: ImportUnit, now: Date = new Date()) {
    super(`Daily ${unit === "ocr" ? "OCR" : "page"} import quota reached; resuming after the daily reset.`);
    this.name = "DailyImportCapError";
    this.unit = unit;
    this.retryAfterMs = msUntilUtcMidnight(now);
  }
}

// The project-wide Gemini budget (R-5, ai-budget.ts) is spent for today. Same
// shape as DailyImportCapError: the source waits for the UTC reset, and the
// user's other queued sources are gated too (they'd hit the same wall).
export class AiBudgetBusyError extends Error {
  readonly transient = true;
  readonly daily = true;
  readonly retryAfterMs: number;
  constructor(now: Date = new Date()) {
    super("Import paused: the daily AI budget is used up; resuming after the daily reset.");
    this.name = "AiBudgetBusyError";
    this.retryAfterMs = msUntilUtcMidnight(now);
  }
}

// The meter couldn't be read. Fail closed (no unmetered work), but as an
// ordinary short-backoff retry, not a wait until tomorrow.
export class ImportMeterUnavailableError extends Error {
  readonly transient = true;
  constructor() {
    super("Import meter temporarily unavailable.");
    this.name = "ImportMeterUnavailableError";
  }
}

/**
 * Adds `units` to today's total for the user and throws when the new total is
 * over the cap (DailyImportCapError) or the meter can't be read
 * (ImportMeterUnavailableError). Call it BEFORE doing the work it meters.
 */
export async function chargeImportUnits(
  client: RpcClient,
  userId: string,
  unit: ImportUnit,
  units: number,
  now: Date = new Date(),
): Promise<void> {
  if (units <= 0) return;
  const { bucket, cap } = BUCKETS[unit];
  const total = await incrementUsageDaily(client, userId, bucket, Math.ceil(units));
  if (total === null) throw new ImportMeterUnavailableError();
  if (total > cap) throw new DailyImportCapError(unit, now);
  // OCR pages are Gemini calls, so they also draw on the project-wide budget,
  // after the user's own cap has passed.
  if (unit === "ocr") {
    await chargeAiBudget(client, userId, Math.ceil(units) * OCR_PAGE_UNITS, now);
  }
}

/**
 * Charges the project-wide Gemini budget for embedding `texts` (R-5). Call it
 * right before embedTexts. Throws AiBudgetBusyError when today's budget is
 * spent, or ImportMeterUnavailableError when the budget can't be read.
 */
export async function chargeEmbeddingBudget(
  client: RpcClient,
  userId: string,
  texts: string[],
  now: Date = new Date(),
): Promise<void> {
  if (texts.length === 0) return;
  const chars = texts.reduce((sum, text) => sum + text.length, 0);
  await chargeAiBudget(client, userId, estimateEmbeddingUnits(chars), now);
}

async function chargeAiBudget(client: RpcClient, userId: string, units: number, now: Date): Promise<void> {
  const result = await claimAiBudget(client, "gemini", userId, units);
  if (result === "busy") throw new AiBudgetBusyError(now);
  if (result !== "ok") throw new ImportMeterUnavailableError();
}
