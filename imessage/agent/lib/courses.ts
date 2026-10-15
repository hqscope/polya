// Course reads for the agent's tools. Service role, so every query filters by the linked
// student's user_id: a course id from the model only resolves if it is that student's course.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { normalizeMode, type PolicyMode } from "./study-rules.ts";

export interface StudentCourse {
  id: string;
  name: string;
  code: string | null;
  term_name: string | null;
  import_status: string;
}

/** Tool input for a course id, as list_courses returns it. */
export const courseIdInput = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Use a course id from list_courses.")
  .describe("The course id from list_courses.");

export class CourseNotFoundError extends Error {
  constructor() {
    super("That course isn't in the student's Polya account. Call list_courses for the right id.");
  }
}

export async function getStudentCourse(
  db: SupabaseClient,
  userId: string,
  courseId: string,
): Promise<StudentCourse> {
  const { data, error } = await db
    .from("polya_courses")
    .select("id, name, code, term_name, import_status")
    .eq("id", courseId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error("Couldn't load that course. Try again in a moment.");
  if (!data) throw new CourseNotFoundError();
  return data as StudentCourse;
}

/** The study mode the student chose for the course; guided when none is set. */
export async function getCourseMode(db: SupabaseClient, userId: string, courseId: string): Promise<PolicyMode> {
  const { data, error } = await db
    .from("polya_course_policies")
    .select("mode")
    .eq("course_id", courseId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error("Couldn't load the course's study mode. Try again in a moment.");
  return normalizeMode((data as { mode?: string } | null)?.mode);
}
