// Shapes shared by the Gradescope client, its parser, and the reminder engine. Keep GsAssignment
// stable: the check-in engine reads it through listGradescopeAssignments (store.ts).

export type GsAssignmentStatus = "submitted" | "graded" | "not_submitted" | "unknown";

export type GsCourseRole = "student" | "instructor";

export interface GsCourse {
  course_id: string;
  /** Short name from the course card, e.g. "CS 61B". */
  short_name: string;
  /** Full name from the course card, e.g. "Data Structures". Falls back to short_name. */
  name: string;
  /** Term heading above the card, e.g. "Fall 2026", when the page shows one. */
  term: string | null;
  role: GsCourseRole;
}

export interface GsAssignment {
  course_id: string;
  course_name: string;
  assignment_id: string;
  title: string;
  /** ISO 8601 UTC instant, or null when the page shows no due date. */
  due_at: string | null;
  /** ISO 8601 UTC instant of the late due date, or null when there is none. */
  late_due_at: string | null;
  status: GsAssignmentStatus;
  /** Score as shown, e.g. "8.0 / 10.0", or null when no score is shown. */
  score: string | null;
  url: string;
}

/** One cookie in the client's jar. Persisted (encrypted) as part of GsSession. */
export interface GsCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Epoch milliseconds; null for a session cookie. */
  expires_at: number | null;
  secure: boolean;
  http_only: boolean;
}

/** What exportSession() returns and fromSession() restores. */
export interface GsSession {
  cookies: GsCookie[];
  csrf_token: string | null;
  saved_at: string;
}
