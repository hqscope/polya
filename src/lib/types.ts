// Shared client-side view types for polya edge-function responses.

export interface ImportProgress {
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

export interface CanvasConnection {
  id: string;
  base_url: string;
  canvas_user_name: string | null;
  status: "active" | "invalid";
}

export interface CanvasCourseOption {
  canvas_course_id: string;
  name: string;
  code: string;
  term_name: string | null;
}

export interface SourceRow {
  id: string;
  title: string;
  origin: string;
  source_kind: string;
  module_name: string | null;
  status: string;
  error: string | null;
  page_count: number;
  chunks_embedded: number;
}

// One course started by an import (polya-import `start` response).
export interface StartedCourse {
  course_id: string;
  canvas_course_id: string;
  name: string;
  source_count: number;
  queued: number;
  refreshed: number;
}

// Progress for a single importing course (polya-import `status_all`).
export interface ImportCourseStatus {
  course_id: string;
  name: string;
  progress: ImportProgress;
}

export interface StatusAllResponse {
  courses: ImportCourseStatus[];
  worker_alive: boolean;
}

export const IMPORT_TERMINAL_STATUSES = new Set(["ready", "failed", "skipped", "needs_ocr"]);

export function importIsComplete(progress: ImportProgress): boolean {
  const pending = progress.queued + progress.fetching + progress.parsing + progress.embedding;
  return progress.total > 0 && pending === 0;
}

// Count of sources still moving through the pump (queued/fetching/parsing/embedding).
export function importPending(progress: ImportProgress): number {
  return progress.queued + progress.fetching + progress.parsing + progress.embedding;
}
