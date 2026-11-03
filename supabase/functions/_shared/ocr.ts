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
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFStream } from "https://esm.sh/pdf-lib@1.17.1";

import type { AiProvider } from "./ai-budget.ts";
import type { PageText } from "./chunker.ts";
import { sanitizeDbText } from "./db-text.ts";
import { GEMINI_KEY, geminiFetchWithRetry, isDailyQuotaBody, parseRetryDelayMs } from "./embeddings.ts";
import {
  FIGURE_INSTRUCTION,
  FIGURE_ONLY_PROMPT,
  figureLines,
  LARGE_PDF_BYTES,
  splitPageMarkers,
  WHOLE_DOC_MAX_PAGES,
  wholeDocumentPrompt,
} from "./ocr-pages.ts";

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
  `commentary, no headings you invent. ${FIGURE_INSTRUCTION} If the page has no readable text and no ` +
  "pictures, output nothing.";

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

type AnthropicInputBlock =
  | { type: "document"; source: AnthropicDocumentSource }
  | { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } };

// Haiku 5.5: adaptive thinking is on by default and sampling parameters are
// rejected, so the request carries only the document, the prompt, and a low
// effort level; text is read from content blocks by type.
async function anthropicTranscribe(
  input: AnthropicInputBlock,
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
            input,
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
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: toBase64(pdfBytes) } },
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
// id, asking for the batch's pages behind "=== PAGE n ===" markers: image-only
// pages transcribed in full, and slide-like pages (text already read) for
// their pictures only. Every page of the file counts as input tokens on each
// call, so this is only used where slicing would exceed the CPU budget
// (LARGE_PDF_BYTES).
async function ocrWholeDocument(
  bytes: ArrayBuffer,
  pageNums: number[],
  totalPages: number,
  figurePages: number[] = [],
): Promise<PdfPagesRead> {
  const fileId = await uploadToAnthropicFiles(bytes);
  const source = { type: "document", source: { type: "file", file_id: fileId } } as const;
  const sort = (text: string, transcribe: number[], figures: number[]): PdfPagesRead => {
    const split = splitPageMarkers(text, [...transcribe, ...figures], 1);
    return {
      transcribed: split.filter((p) => transcribe.includes(p.pageNum) && p.text.length >= OCR_MIN_CHARS),
      figures: split
        .filter((p) => figures.includes(p.pageNum))
        .map((p) => ({ pageNum: p.pageNum, text: figureLines(p.text) }))
        .filter((p) => p.text.length > 0),
    };
  };
  try {
    try {
      const text = await anthropicTranscribe(
        source,
        wholeDocumentPrompt(pageNums, totalPages, figurePages),
        WHOLE_DOC_MAX_OUTPUT_TOKENS,
      );
      return sort(text, pageNums, figurePages);
    } catch (err) {
      // Transcribing ten pages of a published book at once trips an output
      // content filter (400 "Output blocked by content filtering policy";
      // seen on literature excerpts, 2026-10-09). One page at a time is a
      // short excerpt and usually passes, so retry that way, skipping any
      // page that is still blocked.
      if (!isContentFiltered(err) || pageNums.length + figurePages.length === 1) throw err;
      console.warn(
        `[polya-import] whole-document OCR was content-filtered; retrying ${pageNums.length + figurePages.length} pages singly`,
      );
      const out: PdfPagesRead = { transcribed: [], figures: [] };
      const singles = [
        ...pageNums.map((pageNum) => ({ pageNum, figure: false })),
        ...figurePages.map((pageNum) => ({ pageNum, figure: true })),
      ];
      for (const { pageNum, figure } of singles) {
        try {
          const text = await anthropicTranscribe(
            source,
            figure ? wholeDocumentPrompt([], totalPages, [pageNum]) : wholeDocumentPrompt([pageNum], totalPages),
            MAX_OUTPUT_TOKENS,
          );
          const one = sort(text, figure ? [] : [pageNum], figure ? [pageNum] : []);
          out.transcribed.push(...one.transcribed);
          out.figures.push(...one.figures);
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

async function ocrWithGemini(
  bytes: Uint8Array,
  mimeType: "application/pdf" | "image/jpeg" = "application/pdf",
  prompt = OCR_PROMPT,
): Promise<string> {
  const response = await geminiFetchWithRetry(`${GEMINI_ENDPOINT}?key=${GEMINI_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { inline_data: { mime_type: mimeType, data: toBase64(bytes) } },
            { text: prompt },
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
  return await firstProvider(
    [
      ["anthropic", () => ocrWithAnthropic(pdfBytes)],
      ["gemini", () => ocrWithGemini(pdfBytes)],
    ],
    `page ${pageNum}`,
  );
}

// Try each configured provider in order: a decline moves on to the next, a
// transient failure re-queues the batch, and a page every provider rejects is
// logged and comes back empty.
async function firstProvider(
  runs: Array<[AiProvider, () => Promise<string>]>,
  what: string,
): Promise<string> {
  let lastError: unknown = null;
  for (const [provider, run] of runs) {
    if (provider === "anthropic" ? !ANTHROPIC_KEY : !GEMINI_KEY) continue;
    try {
      return await run();
    } catch (err) {
      if (err instanceof OcrTransientError) throw err;
      lastError = err;
      console.warn(`[polya-import] ${provider} OCR declined ${what}, trying next provider:`, err);
    }
  }
  console.error(`[polya-import] OCR skipped ${what}: every provider failed:`, lastError);
  return "";
}

const IMAGE_OCR_PROMPT =
  "Transcribe ALL readable text in this photo of course material (notes, a handout, slides, a " +
  "whiteboard) into plain text, preserving reading order and line breaks. Include handwriting and " +
  "text inside figures, tables, and diagrams. Render equations and chemical formulae as inline text " +
  "(e.g. Vmax, [S], H2O, ATP). Output only the transcribed text — no commentary, no headings you " +
  `invent. ${FIGURE_INSTRUCTION} If the photo has no readable text and no pictures, output nothing.`;

// A photo a student added as course material (a JPEG, already shrunk by the
// browser). Same providers and fallbacks as a scanned PDF page; returns "" for
// a photo with no readable text or one every provider declined.
export async function ocrImage(jpegBytes: Uint8Array): Promise<string> {
  if (!ocrEnabled()) return "";
  const data = toBase64(jpegBytes);
  const text = await firstProvider(
    [
      [
        "anthropic",
        () =>
          anthropicTranscribe(
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
            IMAGE_OCR_PROMPT,
            MAX_OUTPUT_TOKENS,
          ),
      ],
      ["gemini", () => ocrWithGemini(jpegBytes, "image/jpeg", IMAGE_OCR_PROMPT)],
    ],
    "a photo",
  );
  return text.length >= OCR_MIN_CHARS ? text : "";
}

export interface PdfPagesRead {
  /** Image-only pages, transcribed (with a "Figure:" line per picture). */
  transcribed: PageText[];
  /** Slide-like pages whose text was already read: just their "Figure:" lines. */
  figures: PageText[];
}

// A picture big enough to be content: smaller ones are logos, icons and bullets.
const MIN_PICTURE_SIDE = 120;
const MIN_PICTURE_AREA = 300 * 300;

// The content-sized images a page draws, directly or through a form (two
// levels deep), as object keys ("12 0 R") so the same image on many pages is
// recognized as one.
function pageImageKeys(doc: PDFDocument, pageIndex: number): string[] {
  const keys: string[] = [];
  const imageName = PDFName.of("Image");
  const formName = PDFName.of("Form");
  const visit = (resources: PDFDict | undefined, depth: number) => {
    const xobjects = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    if (!xobjects) return;
    for (const [name, value] of xobjects.entries()) {
      const object = doc.context.lookup(value);
      if (!(object instanceof PDFStream)) continue;
      const subtype = object.dict.lookup(PDFName.of("Subtype"));
      if (subtype === imageName) {
        const width = object.dict.lookupMaybe(PDFName.of("Width"), PDFNumber)?.asNumber() ?? 0;
        const height = object.dict.lookupMaybe(PDFName.of("Height"), PDFNumber)?.asNumber() ?? 0;
        if (Math.min(width, height) >= MIN_PICTURE_SIDE && width * height >= MIN_PICTURE_AREA) {
          keys.push(value instanceof PDFRef ? value.toString() : `page${pageIndex}:${name.toString()}`);
        }
      } else if (subtype === formName && depth < 2) {
        visit(object.dict.lookupMaybe(PDFName.of("Resources"), PDFDict), depth + 1);
      }
    }
  };
  visit(doc.getPage(pageIndex).node.Resources(), 0);
  return keys;
}

/**
 * Which of `pageNums` (1-indexed) draw a real picture. An image repeated on at
 * least half of a deck's pages (four or more) is its template, a background or
 * a logo, and doesn't count: in real decks the template image sits on every
 * slide, which would otherwise send every short slide for a description.
 */
export function pagesWithPictures(doc: PDFDocument, pageNums: readonly number[]): number[] {
  const total = doc.getPageCount();
  const uses = new Map<string, number>();
  const onPage = new Map<number, string[]>();
  const wanted = new Set(pageNums);
  for (let index = 0; index < total; index++) {
    const keys = [...new Set(pageImageKeys(doc, index))];
    for (const key of keys) uses.set(key, (uses.get(key) ?? 0) + 1);
    if (wanted.has(index + 1)) onPage.set(index + 1, keys);
  }
  const template = (key: string) => total >= 4 && (uses.get(key) ?? 0) >= Math.max(4, total / 2);
  return pageNums.filter((pageNum) => (onPage.get(pageNum) ?? []).some((key) => !template(key)));
}

// Read the pictures in a PDF batch: `transcribe` pages (no usable text layer)
// in full, and `figureCandidates` (slide-like pages with a little text) for
// their pictures, keeping only candidates that really draw a content-sized
// image so a text-only slide costs nothing. `charge` meters the pages about to
// be sent, before any model call; its daily-cap error is transient, so the
// pump re-queues the batch. Blank and declined pages are dropped. No-op when
// no provider key is set, so local/offline runs and the eval harness work.
export async function readPdfPages(
  bytes: ArrayBuffer,
  transcribe: number[],
  figureCandidates: number[],
  totalPages: number,
  charge: (pages: number) => Promise<void>,
): Promise<PdfPagesRead> {
  const none: PdfPagesRead = { transcribed: [], figures: [] };
  if (!ocrEnabled() || (transcribe.length === 0 && figureCandidates.length === 0)) return none;

  if (bytes.byteLength > LARGE_PDF_BYTES) {
    // Too big to slice within the edge CPU budget (see LARGE_PDF_BYTES), and
    // too big to look for pictures page by page, so every candidate goes in
    // the one request. The Gemini fallback is inline-only (20 MB request cap),
    // so a large scan is Anthropic-or-nothing; a decline skips the pages.
    if (!ANTHROPIC_KEY || totalPages > WHOLE_DOC_MAX_PAGES) {
      console.warn(
        `[polya-import] OCR skipped ${transcribe.length + figureCandidates.length} page(s): file is ${
          Math.round(bytes.byteLength / 1048576)
        } MB / ${totalPages} pages, beyond what can be read whole`,
      );
      return none;
    }
    await charge(transcribe.length + figureCandidates.length);
    try {
      return await ocrWholeDocument(bytes, transcribe, totalPages, figureCandidates);
    } catch (err) {
      if (err instanceof OcrTransientError) throw err;
      console.error(`[polya-import] OCR skipped pages ${[...transcribe, ...figureCandidates].join(",")} of a large file:`, err);
      return none;
    }
  }

  const src = await PDFDocument.load(bytes.slice(0), { ignoreEncryption: true });
  const total = src.getPageCount();
  const inRange = (pageNum: number) => pageNum >= 1 && pageNum <= total;
  const targets = transcribe.filter(inRange);
  const figurePages = pagesWithPictures(src, figureCandidates.filter(inRange));
  if (targets.length + figurePages.length === 0) return none;
  await charge(targets.length + figurePages.length);

  const slice = async (pageNum: number): Promise<Uint8Array> => {
    const doc = await PDFDocument.create();
    const [copied] = await doc.copyPages(src, [pageNum - 1]);
    doc.addPage(copied);
    return await doc.save();
  };

  const out: PdfPagesRead = { transcribed: [], figures: [] };
  for (const pageNum of targets) {
    const text = await ocrOnePage(await slice(pageNum), pageNum);
    if (text.length >= OCR_MIN_CHARS) out.transcribed.push({ pageNum, text });
  }
  for (const pageNum of figurePages) {
    const pdf = await slice(pageNum);
    const text = await firstProvider(
      [
        [
          "anthropic",
          () =>
            anthropicTranscribe(
              { type: "document", source: { type: "base64", media_type: "application/pdf", data: toBase64(pdf) } },
              FIGURE_ONLY_PROMPT,
              MAX_OUTPUT_TOKENS,
            ),
        ],
        ["gemini", () => ocrWithGemini(pdf, "application/pdf", FIGURE_ONLY_PROMPT)],
      ],
      `the pictures on page ${pageNum}`,
    );
    const figures = figureLines(text);
    if (figures) out.figures.push({ pageNum, text: figures });
  }
  return out;
}
