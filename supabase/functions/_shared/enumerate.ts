// Pure re-import diff: compare freshly enumerated Canvas sources against the
// rows already imported and decide what to insert, refresh, or patch. Pure
// module (no Deno globals, no DB) so Node's test runner covers it directly.

export interface EnumeratedSource {
  user_id: string;
  course_id: string;
  origin: string;
  source_kind: string;
  canvas_id: string | null;
  title: string;
  module_name: string | null;
  folder_path: string | null;
  canvas_url: string | null;
  content_role: string;
  size_bytes: number | null;
  canvas_updated_at: string | null;
  due_at: string | null;
  status: "queued";
}

export interface ExistingSourceRow {
  id: string;
  origin: string;
  canvas_id: string | null;
  canvas_updated_at: string | null;
  status: string;
  due_at: string | null;
  title: string;
  canvas_url: string | null;
}

export interface SourceDiff {
  toInsert: EnumeratedSource[];
  toRefresh: Array<{ id: string; patch: Record<string, unknown> }>;
  toPatch: Array<{ id: string; patch: Record<string, unknown> }>;
}

// Statuses where a source is already moving through the pump — never yank one
// of those into a refresh mid-flight.
const IN_FLIGHT = new Set(["queued", "fetching", "parsing", "embedding"]);

function newerThan(a: string | null, b: string | null): boolean {
  if (!a) return false;
  if (!b) return true; // stored row has no timestamp but Canvas now reports one
  return new Date(a).getTime() > new Date(b).getTime();
}

export function diffSources(
  enumerated: EnumeratedSource[],
  existing: ExistingSourceRow[],
  force: boolean,
): SourceDiff {
  const byKey = new Map<string, ExistingSourceRow>();
  for (const row of existing) {
    if (row.canvas_id === null) continue; // uploads/fixtures — never re-enumerated
    byKey.set(`${row.origin}:${row.canvas_id}`, row);
  }

  const diff: SourceDiff = { toInsert: [], toRefresh: [], toPatch: [] };

  for (const source of enumerated) {
    const key = `${source.origin}:${source.canvas_id ?? ""}`;
    const current = source.canvas_id === null ? undefined : byKey.get(key);
    if (!current) {
      diff.toInsert.push(source);
      continue;
    }
    if (IN_FLIGHT.has(current.status)) continue;

    const stale = force || newerThan(source.canvas_updated_at, current.canvas_updated_at);
    if (stale) {
      diff.toRefresh.push({
        id: current.id,
        patch: {
          needs_refresh: true,
          status: "queued",
          attempts: 0,
          error: null,
          claimed_at: null,
          next_attempt_at: null,
          pages_parsed: 0,
          title: source.title,
          // Canvas file download URLs carry expiring verifiers — always take
          // the fresh one so the re-fetch doesn't 401.
          canvas_url: source.canvas_url,
          canvas_updated_at: source.canvas_updated_at,
          due_at: source.due_at,
        },
      });
      continue;
    }

    // Content unchanged — keep cheap metadata current (canvas_url is only
    // refreshed on an actual refresh; a stale verifier doesn't matter until a
    // re-fetch happens).
    const patch: Record<string, unknown> = {};
    if (source.title !== current.title) patch.title = source.title;
    if ((source.due_at ?? null) !== (current.due_at ?? null)) patch.due_at = source.due_at;
    if (Object.keys(patch).length > 0) diff.toPatch.push({ id: current.id, patch });
  }

  return diff;
}
