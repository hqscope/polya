// Pure ranking helpers used by retrieval fusion. No Deno/Supabase deps so Node's
// test runner can import them directly (retrieval.ts itself pulls in the
// Supabase client and is only checked under Deno).

// Mild role weighting applied during RRF fusion. Kept gentle so a genuine
// question about an assignment still surfaces it — this only tips
// otherwise-comparable matches toward teaching material.
const ROLE_WEIGHT: Record<string, number> = {
  material: 1.0,
  syllabus: 0.85,
  assignment: 0.8,
  solution_key: 0.8,
};

export function roleWeight(role: string): number {
  return ROLE_WEIGHT[role] ?? 1.0;
}

// Normalized signature (case/punctuation/whitespace-insensitive, first 160
// chars) used to detect near-identical chunks.
export function contentSignature(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

// Collapse near-identical chunks to their first (best-ranked) instance so
// boilerplate repeated across many assignments can't crowd out the evidence.
export function dedupeBySignature<T extends { content: string }>(hits: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const hit of hits) {
    const signature = contentSignature(hit.content);
    if (signature && seen.has(signature)) continue;
    if (signature) seen.add(signature);
    out.push(hit);
  }
  return out;
}
