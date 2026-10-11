// OCR for image-only PDF pages (scanned handouts, slide decks exported as
// images) using Gemini vision. Pages that have a real text layer are handled by
// unpdf in pdf.ts; only the pages that come back empty are sent here, so a text
// PDF costs nothing. Each target page is sliced into its own tiny sub-PDF with
// pdf-lib and transcribed individually, which keeps page → text mapping exact so
// citations still open the right page.
import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";

import type { PageText } from "./chunker.ts";
import { ocrTextFromParts } from "./db-text.ts";
import {
  GEMINI_KEY,
  GeminiTransientError,
  geminiFetchWithRetry,
  isDailyQuotaBody,
  parseRetryDelayMs,
} from "./embeddings.ts";

const OCR_MODEL = "gemini-2.5-flash";
const OCR_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${OCR_MODEL}:generateContent`;
const OCR_MIN_CHARS = 12; // below this the page is treated as genuinely blank

const OCR_PROMPT =
  "Transcribe ALL readable text from this PDF page into plain text, preserving reading order and " +
  "line breaks. Include text inside figures, tables, and diagrams. Render equations and chemical " +
  "formulae as inline text (e.g. Vmax, [S], H2O, ATP). Output only the transcribed text — no " +
  "commentary, no headings you invent. If the page has no readable text, output nothing.";

export function ocrEnabled(): boolean {
  return GEMINI_KEY.length > 0;
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

async function ocrOnePage(pdfBytes: Uint8Array): Promise<string> {
  const response = await geminiFetchWithRetry(`${OCR_ENDPOINT}?key=${GEMINI_KEY}`, {
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
      generationConfig: { temperature: 0, maxOutputTokens: 8192 },
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const message = `Gemini OCR failed (${response.status}): ${detail.slice(0, 200)}`;
    if (response.status === 429 || response.status >= 500) {
      throw new GeminiTransientError(message, {
        retryAfterMs: parseRetryDelayMs(response.headers.get("Retry-After"), detail),
        daily: isDailyQuotaBody(detail),
      });
    }
    throw new Error(message);
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return ocrTextFromParts(data.candidates?.[0]?.content?.parts ?? []);
}

// OCR the given 1-indexed pages of a PDF. Returns one PageText per page that
// yielded readable text (blank pages dropped). No-op when no Gemini key is set,
// so local/offline runs and the eval harness still work.
export async function ocrPdfPages(bytes: ArrayBuffer, pageNums: number[]): Promise<PageText[]> {
  if (!ocrEnabled() || pageNums.length === 0) return [];

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

    const text = await ocrOnePage(slice);
    if (text.length >= OCR_MIN_CHARS) out.push({ pageNum, text });
  }
  return out;
}
