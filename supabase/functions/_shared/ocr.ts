// OCR for image-only PDF pages (scanned handouts, slide decks exported as
// images). Pages that have a real text layer are handled by unpdf in pdf.ts;
// only the pages that come back empty are sent here, so a text PDF costs
// nothing. Each target page is sliced into its own tiny sub-PDF with pdf-lib
// and transcribed individually, which keeps page → text mapping exact so
// citations still open the right page.
//
// Provider order (data/ocr-eval, 2026-10-07, 27 real course pages):
//   1. Claude Haiku 5.5 — matched the best Gemini Flash on word recall (0.95),
//      ~1.6 s/page, ~$0.0003/page, and transcribed pages Gemini refused.
//   2. Gemini 3.1 Flash-Lite — fallback when Anthropic's safety classifiers
//      decline a page (stop_reason "refusal"; Haiku has no server-side
//      fallback) or no Anthropic key is set. gemini-2.5-flash is closed to new
//      Google projects, so the fallback targets a model that still exists.
// A page both providers reject is logged and skipped; a transient failure
// (rate limit, 5xx) re-queues the whole batch via the pump.
// Files over LARGE_PDF_BYTES skip the slicing (too much CPU for one edge
// invocation) and are transcribed whole through the Files API (ocr-pages.ts).
import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";

import type { AiProvider } from "./ai-budget.ts";
import type { PageText } from "./chunker.ts";
import { sanitizeDbText } from "./db-text.ts";
import { GEMINI_KEY, geminiFetchWithRetry, isDailyQuotaBody, parseRetryDelayMs } from "./embeddings.ts";
import { LARGE_PDF_BYTES, splitPageMarkers, WHOLE_DOC_MAX_PAGES, wholeDocumentPrompt } from "./ocr-pages.ts";

// Read via globalThis so this module type-checks under Node (tests) without a
// Deno global declaration, while still resolving the key in the Deno runtime.
const denoEnv = (globalThis as { Deno?: { env: { get(key: string): string | undefined } } }).Deno
  ?.env;
const ANTHROPIC_KEY = denoEnv?.get("ANTHROPIC_API_KEY") ?? "";

const ANTHROPIC_MODEL = "claude-haiku-5-5";
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_FILES_ENDPOINT = "https://api.anthropic.com/v1/files";
const GEMINI_MODEL = "gemini-3.1-flash-lite";
const GEMINI_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MAX_OUTPUT_TOKENS = 8192;
const WHOLE_DOC_MAX_OUTPUT_TOKENS = 16384; // up to ten dense pages in one reply
const OCR_MIN_CHARS = 12; // below this the page is treated as genuinely blank

const OCR_PROMPT =
  "Transcribe ALL readable text from this PDF page into plain text, preserving reading order and " +
  "line breaks. Include text inside figures, tables, and diagrams. Render equations and chemical " +
  "formulae as inline text (e.g. Vmax, [S], H2O, ATP). Output only the transcribed text — no " +
  "commentary, no headings you invent. If the page has no readable text, output nothing.";

export function ocrEnabled(): boolean {
  return ANTHROPIC_KEY.length > 0 || GEMINI_KEY.length > 0;
}

/** Which project-wide AI budget (ai-budget.ts) OCR pages draw on. A page that
 * falls back to the other provider is still charged here; the per-page flat
 * rate (OCR_PAGE_UNITS) already overestimates either provider. */
export function ocrProvider(): AiProvider {
  return ANTHROPIC_KEY.length > 0 ? "anthropic" : "gemini";
}

// Same shape as GeminiTransientError / DailyImportCapError: process.ts's
// isTransient() re-queues anything with `transient: true`, and backoff.ts
// reads `retryAfterMs` / `daily`.
export class OcrTransientError extends Error {
  readonly transient = true;
  readonly retryAfterMs: number | null;
  readonly daily: boolean;
  constructor(message: string, hints: { retryAfterMs?: number | null; daily?: boolean } = {}) {
    super(message);
    this.name = "OcrTransientError";
    this.retryAfterMs = hints.retryAfterMs ?? null;
    this.daily = hints.daily ?? false;
  }
}

/** The provider declined to transcribe this page (safety classifier, or
 * Gemini's recitation filter on course material). Not transient: try the other
 * provider, then skip the page. */
export class OcrDeclinedError extends Error {
  constructor(provider: AiProvider, reason: string) {
    super(`${provider} declined OCR: ${reason}`);
    this.name = "OcrDeclinedError";
  }
}

// Base64-encode bytes in chunks so we never blow the argument limit of
// String.fromCharCode on large buffers.
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// OCR output goes straight into content_units, so NULs and lone surrogates
// are dropped here too (db-text.ts), not only in the pdf.js text path.
function tidy(text: string): string {
  return sanitizeDbText(text).replace(/\s+\n/g, "\n").trim();
}

async function throwForStatus(provider: AiProvider, response: Response): Promise<never> {
  const detail = await response.text().catch(() => "");
  const message = `${provider} OCR failed (${response.status}): ${detail.slice(0, 200)}`;
  if (response.status === 429 || response.status >= 500) {
    throw new OcrTransientError(message, {
      retryAfterMs: parseRetryDelayMs(response.headers.get("Retry-After"), detail),
      daily: provider === "gemini" && isDailyQuotaBody(detail),
    });
  }
  throw new Error(message);
}

type AnthropicDocumentSource =
  | { type: "base64"; media_type: "application/pdf"; data: string }
  | { type: "file"; file_id: string };

// Haiku 5.5: adaptive thinking is on by default and sampling parameters are
// rejected, so the request carries only the document, the prompt, and a low
// effort level; text is read from content blocks by type.
async function anthropicTranscribe(
  source: AnthropicDocumentSource,
  prompt: string,
  maxTokens: number,
): Promise<string> {
  // geminiFetchWithRetry is provider-neutral: it retries 429/5xx with backoff.
  const response = await geminiFetchWithRetry(ANTHROPIC_ENDPOINT, {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      output_config: { effort: "low" },
      messages: [
        {
          role: "user",
          content: [
            { type: "document", source },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });
  if (!response.ok) await throwForStatus("anthropic", response);

  const data = (await response.json()) as {
    stop_reason?: string;
    stop_details?: { category?: string | null } | null;
    content?: Array<{ type: string; text?: string }>;
  };
  if (data.stop_reason === "refusal") {
    throw new OcrDeclinedError("anthropic", data.stop_details?.category ?? "refusal");
  }
  return tidy(
    (data.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join(""),
  );
}

async function ocrWithAnthropic(pdfBytes: Uint8Array): Promise<string> {
  return await anthropicTranscribe(
    { type: "base64", media_type: "application/pdf", data: toBase64(pdfBytes) },
    OCR_PROMPT,
    MAX_OUTPUT_TOKENS,
  );
}

// Files API (GA, no beta header): the raw bytes go up as multipart, which is
// a copy rather than a parse, so a 30 MB scan costs almost no CPU here. The
// file is scoped to the workspace, so it is deleted again as soon as the
// transcription returns, with a one-hour expiry as the backstop.
async function uploadToAnthropicFiles(pdfBytes: ArrayBuffer): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([pdfBytes], { type: "application/pdf" }), "source.pdf");
  form.append("expires_in_seconds", "3600");
  const response = await geminiFetchWithRetry(ANTHROPIC_FILES_ENDPOINT, {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: form,
  });
  if (!response.ok) await throwForStatus("anthropic", response);
  const data = (await response.json()) as { id?: string };
  if (!data.id) throw new Error("anthropic file upload returned no id");
  return data.id;
}

async function deleteAnthropicFile(fileId: string): Promise<void> {
  try {
    await fetch(`${ANTHROPIC_FILES_ENDPOINT}/${fileId}`, {
      method: "DELETE",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    });
  } catch {
    // Best effort; the upload expires on its own within the hour.
  }
}

// Large scans: one request per parse batch with the whole file attached by
// id, asking for the batch's pages behind "=== PAGE n ===" markers. Every
// page of the file counts as input tokens on each call, so this is only used
// where slicing would exceed the CPU budget (LARGE_PDF_BYTES).
async function ocrWholeDocument(
  bytes: ArrayBuffer,
  pageNums: number[],
  totalPages: number,
): Promise<PageText[]> {
  const fileId = await uploadToAnthropicFiles(bytes);
  const source = { type: "file", file_id: fileId } as const;
  try {
    try {
      const text = await anthropicTranscribe(
        source,
        wholeDocumentPrompt(pageNums, totalPages),
        WHOLE_DOC_MAX_OUTPUT_TOKENS,
      );
      return splitPageMarkers(text, pageNums, OCR_MIN_CHARS);
    } catch (err) {
      // Transcribing ten pages of a published book at once trips an output
      // content filter (400 "Output blocked by content filtering policy";
      // seen on literature excerpts, 2026-10-09). One page at a time is a
      // short excerpt and usually passes, so retry that way, skipping any
      // page that is still blocked.
      if (!isContentFiltered(err) || pageNums.length === 1) throw err;
      console.warn(`[polya-import] whole-document OCR was content-filtered; retrying ${pageNums.length} pages singly`);
      const out: PageText[] = [];
      for (const pageNum of pageNums) {
        try {
          const text = await anthropicTranscribe(
            source,
            wholeDocumentPrompt([pageNum], totalPages),
            MAX_OUTPUT_TOKENS,
          );
          out.push(...splitPageMarkers(text, [pageNum], OCR_MIN_CHARS));
        } catch (pageErr) {
          if (pageErr instanceof OcrTransientError) throw pageErr;
          console.warn(`[polya-import] OCR skipped page ${pageNum} of a large file:`, pageErr);
          // A single page still blocked means the filter is about the work
          // itself (a published book), so the rest of the batch will be too;
          // each try re-reads the whole file, so stop here.
          if (isContentFiltered(pageErr)) break;
        }
      }
      return out;
    }
  } finally {
    await deleteAnthropicFile(fileId);
  }
}

function isContentFiltered(err: unknown): boolean {
  return err instanceof Error && !(err instanceof OcrTransientError) &&
    /content filtering/i.test(err.message);
}

async function ocrWithGemini(pdfBytes: Uint8Array): Promise<string> {
  const response = await geminiFetchWithRetry(`${GEMINI_ENDPOINT}?key=${GEMINI_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { inline_data: { mime_type: "application/pdf", data: toBase64(pdfBytes) } },
            { text: OCR_PROMPT },
          ],
        },
      ],
      generationConfig: { temperature: 0, maxOutputTokens: MAX_OUTPUT_TOKENS },
    }),
  });
  if (!response.ok) await throwForStatus("gemini", response);

  const data = (await response.json()) as {
    candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>;
  };
  const candidate = data.candidates?.[0];
  const text = tidy((candidate?.content?.parts ?? []).map((part) => part.text ?? "").join(""));
  // Gemini's recitation and safety filters return an empty candidate with a
  // finish reason instead of an error. Course material trips the recitation
  // filter, so an empty page here is a decline, not a blank page.
  const reason = candidate?.finishReason ?? "STOP";
  if (text.length === 0 && reason !== "STOP" && reason !== "MAX_TOKENS") {
    throw new OcrDeclinedError("gemini", reason);
  }
  return text;
}

async function ocrOnePage(pdfBytes: Uint8Array, pageNum: number): Promise<string> {
  const providers: Array<[AiProvider, (bytes: Uint8Array) => Promise<string>]> = [];
  if (ANTHROPIC_KEY) providers.push(["anthropic", ocrWithAnthropic]);
  if (GEMINI_KEY) providers.push(["gemini", ocrWithGemini]);

  let lastError: unknown = null;
  for (const [provider, run] of providers) {
    try {
      return await run(pdfBytes);
    } catch (err) {
      if (err instanceof OcrTransientError) throw err;
      lastError = err;
      console.warn(`[polya-import] ${provider} OCR declined page ${pageNum}, trying next provider:`, err);
    }
  }
  console.error(`[polya-import] OCR skipped page ${pageNum}: every provider failed:`, lastError);
  return "";
}

// OCR the given 1-indexed pages of a PDF. Returns one PageText per page that
// yielded readable text (blank and declined pages dropped). No-op when no
// provider key is set, so local/offline runs and the eval harness still work.
export async function ocrPdfPages(
  bytes: ArrayBuffer,
  pageNums: number[],
  totalPages?: number,
): Promise<PageText[]> {
  if (!ocrEnabled() || pageNums.length === 0) return [];

  if (bytes.byteLength > LARGE_PDF_BYTES) {
    // Too big to slice within the edge CPU budget (see LARGE_PDF_BYTES). The
    // Gemini fallback is inline-only (20 MB request cap), so a large scan is
    // Anthropic-or-nothing; a decline here skips the pages, like elsewhere.
    const total = totalPages ?? Math.max(...pageNums);
    if (!ANTHROPIC_KEY || total > WHOLE_DOC_MAX_PAGES) {
      console.warn(
        `[polya-import] OCR skipped ${pageNums.length} page(s): file is ${
          Math.round(bytes.byteLength / 1048576)
        } MB / ${total} pages, beyond what can be transcribed whole`,
      );
      return [];
    }
    try {
      return await ocrWholeDocument(bytes, pageNums, total);
    } catch (err) {
      if (err instanceof OcrTransientError) throw err;
      console.error(`[polya-import] OCR skipped pages ${pageNums.join(",")} of a large file:`, err);
      return [];
    }
  }

  const src = await PDFDocument.load(bytes.slice(0), { ignoreEncryption: true });
  const total = src.getPageCount();

  const out: PageText[] = [];
  for (const pageNum of pageNums) {
    const index = pageNum - 1;
    if (index < 0 || index >= total) continue;

    const doc = await PDFDocument.create();
    const [copied] = await doc.copyPages(src, [index]);
    doc.addPage(copied);
    const slice = await doc.save();

    const text = await ocrOnePage(slice, pageNum);
    if (text.length >= OCR_MIN_CHARS) out.push({ pageNum, text });
  }
  return out;
}
