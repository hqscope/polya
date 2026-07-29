// Retrieval eval: runs the golden set through polya-search and reports
// recall@5 / recall@10 / MRR, keyed on the expected source title appearing in
// the ranked results. Gate: recall@5 >= RECALL_GATE, else non-zero exit.
//
// Env: POLYA_SUPABASE_URL, POLYA_ANON_KEY, POLYA_COURSE_ID, and either
// POLYA_ACCESS_TOKEN or POLYA_TEST_EMAIL + POLYA_TEST_PASSWORD.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SUPABASE_URL = process.env.POLYA_SUPABASE_URL ?? "http://127.0.0.1:54331";
const ANON_KEY = process.env.POLYA_ANON_KEY ?? "";
const COURSE_ID = process.env.POLYA_COURSE_ID ?? "";
const RECALL_GATE = 0.8;

interface GoldenItem {
  question: string;
  expect_source: string;
  expect_terms: string[];
}
interface SearchResult {
  title: string;
  snippet: string;
}

async function getToken(): Promise<string> {
  if (process.env.POLYA_ACCESS_TOKEN) return process.env.POLYA_ACCESS_TOKEN;
  const email = process.env.POLYA_TEST_EMAIL;
  const password = process.env.POLYA_TEST_PASSWORD;
  if (!email || !password) throw new Error("Set POLYA_ACCESS_TOKEN or POLYA_TEST_EMAIL/PASSWORD.");
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error("auth failed: " + JSON.stringify(data));
  return data.access_token;
}

async function search(token: string, query: string): Promise<SearchResult[]> {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/polya-search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ course_id: COURSE_ID, query }),
  });
  const data = await resp.json();
  return (data.results ?? []) as SearchResult[];
}

function rankOf(results: SearchResult[], expectedTitle: string): number {
  const idx = results.findIndex((r) => r.title === expectedTitle);
  return idx === -1 ? Infinity : idx + 1;
}

async function main() {
  if (!COURSE_ID) throw new Error("Set POLYA_COURSE_ID to the fixture course id.");
  const golden = JSON.parse(await readFile(join(here, "golden-set.json"), "utf8")) as GoldenItem[];
  const token = await getToken();

  let hit5 = 0;
  let hit10 = 0;
  let mrrSum = 0;

  for (const item of golden) {
    const results = await search(token, item.question);
    const rank = rankOf(results, item.expect_source);
    if (rank <= 5) hit5 += 1;
    if (rank <= 10) hit10 += 1;
    if (Number.isFinite(rank)) mrrSum += 1 / rank;
    const mark = rank <= 5 ? "✓" : rank === Infinity ? "✗" : "~";
    console.log(`  ${mark} rank ${rank === Infinity ? "-" : rank}  "${item.question}" → ${item.expect_source}`);
  }

  const n = golden.length;
  const recall5 = hit5 / n;
  const recall10 = hit10 / n;
  const mrr = mrrSum / n;
  console.log(`\nRecall@5: ${recall5.toFixed(2)} | Recall@10: ${recall10.toFixed(2)} | MRR: ${mrr.toFixed(3)} (${n} questions)`);

  if (recall5 < RECALL_GATE) {
    console.error(`\nFAIL: recall@5 ${recall5.toFixed(2)} < gate ${RECALL_GATE}`);
    process.exit(1);
  }
  console.log(`\nPASS: recall@5 >= ${RECALL_GATE}`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
