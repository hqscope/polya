// The iMessage agent's service-role retrieval functions must stay service-role only and must not
// depend on auth.uid() (null for service role). Checks the migration text, since it isn't run here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const sql = readFileSync(new URL("../supabase/migrations/20261015195047_polya_imessage.sql", import.meta.url), "utf8");

function body(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} is defined`);
  const end = sql.indexOf("$$;", sql.indexOf("as $$", start));
  return sql.slice(start, end);
}

for (const [name, args] of [
  ["polya_match_units_for_user", "uuid, uuid, extensions.vector, integer, text[]"],
  ["polya_search_units_fts_for_user", "uuid, uuid, text, integer, text[]"],
] as const) {
  test(`${name} filters by p_user_id and is service-role only`, () => {
    const fn = body(name);
    assert.match(fn, /where u\.user_id = p_user_id/);
    assert.doesNotMatch(fn, /auth\.uid\(\)/);
    assert.ok(sql.includes(`revoke all on function public.${name}(${args})\n  from public, anon, authenticated;`));
    assert.ok(sql.includes(`grant execute on function public.${name}(${args})\n  to service_role;`));
    assert.doesNotMatch(sql, new RegExp(`grant execute on function public\\.${name}\\([^)]*\\)\\s+to (authenticated|anon|public)`));
  });
}
