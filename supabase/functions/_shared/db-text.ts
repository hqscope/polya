// Text that ends up in a Postgres `text` column must be valid UTF-8 with no NUL
// bytes: PostgREST rejects "\u0000" (22P05 "unsupported Unicode escape
// sequence") and lone UTF-16 surrogates can't be encoded at all. pdf.js emits
// NULs for unmapped glyphs (common with CID fonts), and OCR / transcript files
// can carry them too, so every extraction path cleans its text here before
// length checks, chunking, embedding, or insert.
// Pure module: no runtime globals, so Node's test runner can import it.

const NUL_RE = /\u0000/g;
// A high surrogate not followed by a low one, or a low one not preceded by a high.
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function sanitizeDbText(text: string): string {
  return String(text ?? "")
    .replace(NUL_RE, "")
    .replace(LONE_SURROGATE_RE, "�");
}

// Join pdf.js text-content items into one page string: sanitized first, so a
// page whose "text" is only NUL glyphs collapses to empty and is routed to OCR
// instead of being counted as a text page.
export function pageTextFromItems(items: ReadonlyArray<unknown>): string {
  return sanitizeDbText(
    items.map((item) => (item as { str?: string } | null)?.str ?? "").join(" "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

// Join Gemini response parts into one OCR'd page string.
export function ocrTextFromParts(parts: ReadonlyArray<{ text?: string }>): string {
  return sanitizeDbText(parts.map((part) => part.text ?? "").join(""))
    .replace(/\s+\n/g, "\n")
    .trim();
}
