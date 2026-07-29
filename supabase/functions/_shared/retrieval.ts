// Hybrid retrieval: vector (pgvector) + full-text, fused with RRF, then
// expanded (neighbor ordinals + procedure parent/siblings) into evidence.
import { rrfMerge, RRF_K } from "./rrf.ts";
import { dedupeBySignature, roleWeight } from "./rank.ts";
import { embedQuery, toVectorLiteral } from "./embeddings.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import type { RetrievedUnit } from "./retrieval-types.ts";

export type { RetrievedUnit } from "./retrieval-types.ts";

const VECTOR_CANDIDATES = 12;
const FTS_CANDIDATES = 12;
const EVIDENCE_MAX = 8;
const MIN_VECTOR_SIMILARITY = 0.25; // vector-only hits below this are dropped

// Runs the two RPCs (as the user, via their JWT client), fuses, filters, and
// expands. `excludeRoles` drops e.g. solution keys in practice mode.
export async function retrieve(
  userClient: SupabaseClient,
  courseId: string,
  query: string,
  excludeRoles: string[] = [],
): Promise<RetrievedUnit[]> {
  const queryEmbedding = await embedQuery(query);

  const [vectorRes, ftsRes] = await Promise.all([
    userClient.rpc("polya_match_units", {
      p_course_id: courseId,
      p_query_embedding: toVectorLiteral(queryEmbedding),
      p_limit: VECTOR_CANDIDATES,
      p_exclude_roles: excludeRoles,
    }),
    userClient.rpc("polya_search_units_fts", {
      p_course_id: courseId,
      p_query: query,
      p_limit: FTS_CANDIDATES,
      p_exclude_roles: excludeRoles,
    }),
  ]);

  const vectorHits = (vectorRes.data ?? []) as RetrievedUnit[];
  const ftsHits = (ftsRes.data ?? []) as RetrievedUnit[];
  const ftsIds = new Set(ftsHits.map((hit) => hit.unit_id));

  // Adapted lexical floor: drop weak vector-only hits unless they also matched
  // lexically (guards against a purely-semantic near-miss dominating).
  const vectorFiltered = vectorHits.filter(
    (hit) => hit.score >= MIN_VECTOR_SIMILARITY || ftsIds.has(hit.unit_id),
  );

  // Fuse with a mild role weight so lecture/reading material outranks repetitive
  // assignment/quiz logistics, then drop near-duplicate chunks (e.g. the many
  // identical "submit this quiz…" blurbs) before taking the top evidence.
  const fused = rrfMerge(
    vectorFiltered,
    ftsHits,
    (hit) => hit.unit_id,
    RRF_K,
    (hit) => roleWeight(hit.content_role),
  );
  const evidence = dedupeBySignature(fused).slice(0, EVIDENCE_MAX);

  return await expand(userClient, courseId, evidence);
}

// Expand the fused hits: pull ±1 ordinal neighbors (same source) and, for a
// procedure_step hit, its parent procedure + all sibling steps.
async function expand(
  userClient: SupabaseClient,
  courseId: string,
  hits: RetrievedUnit[],
): Promise<RetrievedUnit[]> {
  const byId = new Map<string, RetrievedUnit>();
  for (const hit of hits) byId.set(hit.unit_id, hit);

  const neighborKeys: Array<{ source_id: string; ordinal: number }> = [];
  const procedureIds = new Set<string>();

  for (const hit of hits) {
    neighborKeys.push({ source_id: hit.source_id, ordinal: hit.ordinal - 1 });
    neighborKeys.push({ source_id: hit.source_id, ordinal: hit.ordinal + 1 });
    if (hit.procedure_id) procedureIds.add(hit.procedure_id);
  }

  // Neighbor ordinals
  if (neighborKeys.length > 0) {
    const orFilter = neighborKeys
      .map((key) => `and(source_id.eq.${key.source_id},ordinal.eq.${key.ordinal})`)
      .join(",");
    const { data } = await userClient
      .from("polya_content_units")
      .select(unitSelect())
      .eq("course_id", courseId)
      .or(orFilter);
    for (const row of (data ?? []) as unknown as RetrievedUnit[]) {
      if (!byId.has(row.unit_id)) byId.set(row.unit_id, { ...row, score: 0 });
    }
  }

  // Procedure parent + sibling steps
  if (procedureIds.size > 0) {
    const { data } = await userClient
      .from("polya_content_units")
      .select(unitSelect())
      .eq("course_id", courseId)
      .in("procedure_id", Array.from(procedureIds));
    for (const row of (data ?? []) as unknown as RetrievedUnit[]) {
      if (!byId.has(row.unit_id)) byId.set(row.unit_id, { ...row, score: 0 });
    }
  }

  // Order: original fused hits first (by their fused rank), then expansions,
  // grouped by source and ordinal so evidence reads coherently.
  const originalOrder = new Map(hits.map((hit, i) => [hit.unit_id, i]));
  return Array.from(byId.values()).sort((a, b) => {
    const ra = originalOrder.get(a.unit_id) ?? 1000;
    const rb = originalOrder.get(b.unit_id) ?? 1000;
    if (ra !== rb) return ra - rb;
    if (a.source_id !== b.source_id) return a.source_id.localeCompare(b.source_id);
    return a.ordinal - b.ordinal;
  });
}

// The unit column projection matching RetrievedUnit (title comes via a join in
// the RPCs; for direct table reads we fill it from the sources table separately
// if needed — here heading_path already carries the source title).
function unitSelect(): string {
  return "unit_id:id, source_id, unit_type, content_role, ordinal, heading_path, page_start, page_end, t_start_ms, t_end_ms, procedure_id, step_number, content";
}
