// Embeddings — Gemini gemini-embedding-001 at 1536 dims.
// gemini-embedding-001 only returns pre-normalized vectors at 3072 dims, so at
// 1536 we MUST L2-normalize ourselves or cosine ranking is silently wrong.
// When GEMINI_API_KEY is absent (local dev / offline tests) a deterministic
// hashed fallback keeps the pipeline runnable; embedding_model records which
// path produced each vector so a later re-embed can target the fallback rows.

export const EMBED_DIM = 1536;
export const EMBED_MODEL = "gemini-embedding-001@1536";
export const EMBED_MODEL_FALLBACK = "polya-hash-fallback@1536";
export const EMBED_BATCH_MAX = 96;

// Read via globalThis so this module type-checks under Node (tests) without a
// Deno global declaration, while still resolving the key in the Deno runtime.
const denoEnv = (globalThis as { Deno?: { env: { get(key: string): string | undefined } } }).Deno
  ?.env;
export const GEMINI_KEY = denoEnv?.get("GEMINI_API_KEY") ?? "";
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// In-call backoff, capped so a single edge invocation never stalls: base 0.8s,
// doubling, capped at 8s, plus jitter.
function backoffMs(attempt: number): number {
  return Math.min(8_000, 800 * Math.pow(2, attempt - 1)) + Math.random() * 400;
}

// Honor an explicit Retry-After header (seconds) or Gemini's
// error.details[].retryDelay ("12s") from the response body.
export function parseRetryDelayMs(retryAfter: string | null, body: string): number | null {
  if (retryAfter) {
    const secs = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(secs)) return secs * 1000;
  }
  const match = body.match(/"retryDelay":\s*"([0-9.]+)s"/);
  if (match) {
    const secs = Number.parseFloat(match[1]!);
    if (Number.isFinite(secs)) return Math.ceil(secs * 1000);
  }
  return null;
}

// Marks an error a caller can treat as retryable (429/5xx/network/quota) so the
// import pump re-queues the source instead of failing it permanently. Carries
// the provider's retry hints so the pump can pick a backoff that has a chance
// of clearing the limit: `retryAfterMs` from Retry-After/retryDelay, and
// `daily` when the violated quota is a per-day one (waiting minutes is useless).
export class GeminiTransientError extends Error {
  readonly transient = true;
  readonly retryAfterMs: number | null;
  readonly daily: boolean;
  constructor(message: string, hints: { retryAfterMs?: number | null; daily?: boolean } = {}) {
    super(message);
    this.name = "GeminiTransientError";
    this.retryAfterMs = hints.retryAfterMs ?? null;
    this.daily = hints.daily ?? false;
  }
}

// Gemini free-tier daily quotas surface as quota ids like
// "GenerateRequestsPerDayPerProjectPerModel-FreeTier" in the 429 body.
export function isDailyQuotaBody(body: string): boolean {
  return /per[_]?day/i.test(body);
}

// fetch() with short in-call retries for transient Gemini failures. Sustained
// quota limits (still 429 after the retries) surface to the caller, which lets
// the pump apply its longer cross-invocation lease backoff. In-call sleeps are
// capped at ~10s so one step never blocks near the lease window.
export async function geminiFetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 3,
): Promise<Response> {
  let attempt = 0;
  while (true) {
    attempt++;
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (attempt > maxRetries) throw error;
      await sleep(backoffMs(attempt));
      continue;
    }

    if (response.ok) return response;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt > maxRetries) return response;

    const retryAfter = response.headers.get("Retry-After");
    const body = await response.text().catch(() => "");
    const hinted = parseRetryDelayMs(retryAfter, body);
    const delay = Math.min(10_000, Math.max(backoffMs(attempt), hinted ?? 0));
    await sleep(delay);
  }
}

export type EmbedTask = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export interface EmbeddedText {
  values: number[];
  model: string;
}

// L2-normalize in place so cosine == dot product downstream.
export function l2Normalize(vector: number[]): number[] {
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) return vector;
  for (let i = 0; i < vector.length; i++) vector[i] = vector[i]! / norm;
  return vector;
}

// Deterministic offline embedding: hash tokens into EMBED_DIM buckets with a
// signed feature hash, then L2-normalize. Not semantic, but stable and unit-norm
// so the pipeline (and eval harness) run without a network key.
export function fallbackEmbedding(text: string): number[] {
  const vector = new Array<number>(EMBED_DIM).fill(0);
  const tokens = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1);

  for (const token of tokens) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const bucket = Math.abs(hash) % EMBED_DIM;
    const sign = (hash & 1) === 0 ? 1 : -1;
    vector[bucket] += sign;
  }
  return l2Normalize(vector);
}

export function usingRealEmbeddings(): boolean {
  return GEMINI_KEY.length > 0;
}

async function geminiBatch(texts: string[], task: EmbedTask): Promise<number[][]> {
  const response = await geminiFetchWithRetry(`${GEMINI_ENDPOINT}?key=${GEMINI_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: texts.map((text) => ({
        model: "models/gemini-embedding-001",
        content: { parts: [{ text }] },
        taskType: task,
        outputDimensionality: EMBED_DIM,
      })),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const message = `Gemini embed failed (${response.status}): ${detail.slice(0, 200)}`;
    // Sustained quota / server errors are retryable by the pump, not terminal.
    if (response.status === 429 || response.status >= 500) {
      throw new GeminiTransientError(message, {
        retryAfterMs: parseRetryDelayMs(response.headers.get("Retry-After"), detail),
        daily: isDailyQuotaBody(detail),
      });
    }
    throw new Error(message);
  }

  const data = (await response.json()) as { embeddings?: Array<{ values: number[] }> };
  const embeddings = data.embeddings ?? [];
  if (embeddings.length !== texts.length) {
    throw new Error(`Gemini returned ${embeddings.length} embeddings for ${texts.length} inputs`);
  }
  return embeddings.map((embedding) => l2Normalize(embedding.values));
}

// Embed a list of texts (auto-batched to EMBED_BATCH_MAX). Returns unit vectors.
export async function embedTexts(texts: string[], task: EmbedTask): Promise<EmbeddedText[]> {
  if (texts.length === 0) return [];

  if (!usingRealEmbeddings()) {
    return texts.map((text) => ({ values: fallbackEmbedding(text), model: EMBED_MODEL_FALLBACK }));
  }

  const out: EmbeddedText[] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_MAX) {
    const batch = texts.slice(i, i + EMBED_BATCH_MAX);
    const vectors = await geminiBatch(batch, task);
    for (const values of vectors) out.push({ values, model: EMBED_MODEL });
  }
  return out;
}

export async function embedQuery(text: string): Promise<number[]> {
  const [embedded] = await embedTexts([text], "RETRIEVAL_QUERY");
  return embedded ? embedded.values : fallbackEmbedding(text);
}

// pgvector text literal for a vector column: '[0.1,0.2,...]'
export function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}
