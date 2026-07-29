// Pure types shared between retrieval (Deno, supabase-js) and prompt
// construction (pure, Node-testable). Lives apart from retrieval.ts so pure
// modules can import the shape without dragging in the URL-imported SDK.
export interface RetrievedUnit {
  unit_id: string;
  source_id: string;
  unit_type: string;
  content_role: string;
  ordinal: number;
  heading_path: string | null;
  page_start: number | null;
  page_end: number | null;
  t_start_ms: number | null;
  t_end_ms: number | null;
  procedure_id: string | null;
  step_number: number | null;
  title: string | null;
  content: string;
  score: number;
}
