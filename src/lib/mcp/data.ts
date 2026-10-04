// Course reads for the connector, always as the signed-in student: every
// query carries their access token, so row-level security limits it to their
// own courses exactly as in the web app. No service-role key is involved.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseConfig, getSupabaseFunctionsUrl } from "@/lib/supabase/config";
import {
  excludedRolesFor,
  normalizeMode,
} from "../../../supabase/functions/_shared/study-rules.ts";
import type { PolicyMode } from "../../../supabase/functions/_shared/prompts.ts";

export class ToolError extends Error {}

export interface CourseRow {
  id: string;
  name: string;
  code: string | null;
  term_name: string | null;
  import_status: string;
}

export interface SearchHit {
  n: number;
  unit_id: string;
  title: string;
  unit_type: string;
  page_start: number | null;
  page_end: number | null;
  t_start_ms: number | null;
  t_end_ms: number | null;
  snippet: string;
}

const PASSAGE_MAX_CHARS = 1200;
const PASSAGES_MAX = 8;

export function userClient(accessToken: string): SupabaseClient {
  const { url, anonKey } = getSupabaseConfig();
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function listCourses(db: SupabaseClient): Promise<CourseRow[]> {
  const { data, error } = await db
    .from("polya_courses")
    .select("id, name, code, term_name, import_status")
    .order("created_at", { ascending: false });
  if (error) throw new ToolError("Couldn't load your courses. Try again in a moment.");
  return (data ?? []) as CourseRow[];
}

export async function getCourse(db: SupabaseClient, courseId: string): Promise<CourseRow> {
  const { data, error } = await db
    .from("polya_courses")
    .select("id, name, code, term_name, import_status")
    .eq("id", courseId)
    .maybeSingle();
  if (error || !data) {
    throw new ToolError("That course isn't in your Polya account. Call list_my_courses for the right one.");
  }
  return data as CourseRow;
}

export async function getMode(db: SupabaseClient, courseId: string): Promise<PolicyMode> {
  const { data } = await db
    .from("polya_course_policies")
    .select("mode")
    .eq("course_id", courseId)
    .maybeSingle();
  return normalizeMode((data as { mode?: string } | null)?.mode);
}

// Retrieval stays in the polya-search function (it owns the embedding key,
// rate limits and budget). Roles to withhold are decided here from the course
// mode, never taken from the model.
export async function searchCourse(
  accessToken: string,
  courseId: string,
  query: string,
  mode: PolicyMode,
): Promise<SearchHit[]> {
  const response = await fetch(`${getSupabaseFunctionsUrl()}/polya-search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ course_id: courseId, query, exclude_roles: excludedRolesFor(mode) }),
  });
  if (response.status === 429) {
    throw new ToolError("Polya's search limit for now has been reached. Try again later.");
  }
  if (response.status === 503) {
    throw new ToolError("Polya is busy right now. Try again in a few minutes.");
  }
  if (response.status === 400) {
    throw new ToolError("That search couldn't run. Keep the question under 2,000 characters.");
  }
  if (!response.ok) {
    throw new ToolError("Search failed. Try again in a moment.");
  }
  const body = (await response.json()) as { results?: SearchHit[] };
  return body.results ?? [];
}

/** Longer passages than the search snippet, read under the student's RLS. */
export async function passagesFor(
  db: SupabaseClient,
  hits: SearchHit[],
): Promise<Map<string, string>> {
  const ids = hits.slice(0, PASSAGES_MAX).map((hit) => hit.unit_id);
  if (ids.length === 0) return new Map();
  const { data } = await db.from("polya_content_units").select("id, content").in("id", ids);
  const rows = (data ?? []) as Array<{ id: string; content: string }>;
  return new Map(rows.map((row) => [row.id, row.content.slice(0, PASSAGE_MAX_CHARS)]));
}
