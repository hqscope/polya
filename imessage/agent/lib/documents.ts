// Sending a student their own course document (or one page of it) as an iMessage attachment.
//
// The send_document tool finds the PDF (filtered by the student's user_id) and returns a short-lived
// signed link in its output. The Photon channel's `action.result` handler (channels/photon.ts) sees
// that output, downloads the PDF, cuts out the requested page, and posts it to the thread as a file.
// Tools can't post to the thread themselves; channel event handlers can.
import type { SupabaseClient } from "@supabase/supabase-js";
import { PDFDocument } from "pdf-lib";

export const SEND_DOCUMENT_TOOL = "send_document";
const DOCUMENTS_BUCKET = "polya_documents";
/** Long enough for the channel to download it right after the tool returns. */
const SEND_LINK_SECONDS = 10 * 60;
/** iMessage handles large files, but a whole-term PDF isn't a useful text. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export interface DocumentMatch {
  id: string;
  title: string;
  storage_path: string;
  page_count: number | null;
  course_id: string;
}

export interface SendDocumentOutput {
  status: "sending";
  title: string;
  page: number | null;
  filename: string;
  url: string;
}

export interface SendDocumentMiss {
  status: "not_found" | "no_page";
  message: string;
  candidates?: string[];
}

/** Words that carry meaning in a document request ("lecture 4 slides" -> ["lecture", "4"]). */
export function queryTerms(query: string): string[] {
  const stop = new Set(["the", "a", "an", "of", "slide", "slides", "page", "pages", "pdf", "my", "for", "on", "in", "deck"]);
  return query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 0 && !stop.has(w));
}

/** Scores titles against the request: every term must appear; numbers must match as whole numbers. */
export function scoreTitle(title: string, terms: readonly string[]): number {
  const t = ` ${title.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  let score = 0;
  for (const term of terms) {
    const re = /^\d+$/.test(term) ? new RegExp(`(^|[^0-9])0*${term}([^0-9]|$)`) : new RegExp(term);
    if (!re.test(t)) return 0;
    score += term.length;
  }
  return score;
}

export function pickDocument(rows: readonly DocumentMatch[], query: string): DocumentMatch | DocumentMatch[] {
  const terms = queryTerms(query);
  const exact = rows.find((r) => r.id === query.trim());
  if (exact) return exact;
  const scored = rows
    .map((r) => ({ r, s: scoreTitle(r.title, terms) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.r.title.length - b.r.title.length);
  if (scored.length === 0) return [];
  if (scored.length === 1 || scored[0]!.s > scored[1]!.s) return scored[0]!.r;
  return scored.slice(0, 5).map((x) => x.r);
}

export function attachmentName(title: string, page: number | null): string {
  const base = title.replace(/\.pdf$/i, "").replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "document";
  return page ? `${base}-p${page}.pdf` : `${base}.pdf`;
}

/** The student's PDFs in one course (or all their courses), only rows they own. */
export async function studentPdfs(db: SupabaseClient, studentId: string, courseId?: string): Promise<DocumentMatch[]> {
  let q = db
    .from("polya_sources")
    .select("id, title, storage_path, page_count, course_id")
    .eq("user_id", studentId)
    .eq("source_kind", "pdf")
    .not("storage_path", "is", null)
    .limit(500);
  if (courseId) q = q.eq("course_id", courseId);
  const { data, error } = await q;
  if (error) throw new Error(`documents lookup failed (${error.code ?? "unknown"})`);
  return (data ?? []) as DocumentMatch[];
}

export async function signedDocumentUrl(db: SupabaseClient, path: string): Promise<string> {
  const { data, error } = await db.storage.from(DOCUMENTS_BUCKET).createSignedUrl(path, SEND_LINK_SECONDS);
  if (error || !data?.signedUrl) throw new Error("could not open that document right now");
  return data.signedUrl;
}

/** One page of a PDF as its own PDF (1-based page). Returns null when the page doesn't exist. */
export async function extractPage(bytes: Uint8Array, page: number): Promise<Uint8Array | null> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  if (page < 1 || page > src.getPageCount()) return null;
  const out = await PDFDocument.create();
  const [copied] = await out.copyPages(src, [page - 1]);
  out.addPage(copied!);
  return out.save();
}

export function isSendOutput(value: unknown): value is SendDocumentOutput {
  const v = value as Partial<SendDocumentOutput> | null;
  return (
    !!v &&
    v.status === "sending" &&
    typeof v.url === "string" &&
    v.url.startsWith("https://") &&
    typeof v.filename === "string" &&
    (v.page === null || typeof v.page === "number")
  );
}
