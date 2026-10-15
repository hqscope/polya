import { defineTool } from "eve/tools";
import { z } from "zod";

import { serviceDb } from "../lib/db.ts";
import {
  attachmentName,
  pickDocument,
  signedDocumentUrl,
  studentPdfs,
  type SendDocumentMiss,
  type SendDocumentOutput,
} from "../lib/documents.ts";
import { requireStudentId } from "../lib/student.ts";

export default defineTool({
  description:
    "Texts the student one of their own course PDFs as an attachment, or a single page of it (for example one lecture slide). Use when they ask to see, show, or send a slide, page, handout, or document. The file arrives as its own message right after your reply.",
  inputSchema: z.object({
    document: z
      .string()
      .min(1)
      .max(200)
      .describe('The document title, or words from it such as "lecture 4", or a source id from search results.'),
    page: z.number().int().min(1).max(2000).optional().describe("1-based page or slide number to send on its own."),
    course_id: z.string().uuid().optional().describe("The course id from list_courses, when known."),
  }),
  async execute({ document, page, course_id }, ctx): Promise<SendDocumentOutput | SendDocumentMiss> {
    const studentId = requireStudentId(ctx.session.auth);
    const db = serviceDb();
    const rows = await studentPdfs(db, studentId, course_id);
    const pick = pickDocument(rows, document);
    if (Array.isArray(pick)) {
      return pick.length === 0
        ? { status: "not_found", message: "No PDF in the student's courses matches that. Ask which document they mean, or search first." }
        : { status: "not_found", message: "Several documents match. Ask which one.", candidates: pick.map((d) => d.title) };
    }
    if (page && pick.page_count && page > pick.page_count) {
      return { status: "no_page", message: `${pick.title} has ${pick.page_count} pages.` };
    }
    return {
      status: "sending",
      title: pick.title,
      page: page ?? null,
      filename: attachmentName(pick.title, page ?? null),
      url: await signedDocumentUrl(db, pick.storage_path),
    };
  },
});
