// Study eval: asks polya-study to write practice questions for an exam's
// topics and reports how many survive the key checks, why the rest were
// dropped (see the function logs), latency, and failures by code. Writes every
// kept question to data/ (gitignored: it quotes course material) for a person
// to check the keys by hand — the number that matters before telling anyone
// about the Study tab.
//
// Each topic costs one of the account's daily question batches (8/day), and
// two Claude calls against the shared budget. Use a test account or your own.
//
// Env: POLYA_SUPABASE_URL, POLYA_ANON_KEY, POLYA_EXAM_ID (an exam that already
// has topics), POLYA_ACCESS_TOKEN or POLYA_TEST_EMAIL + POLYA_TEST_PASSWORD.
// Optional: POLYA_EVAL_TOPICS (default 3, max 8); POLYA_SERVICE_ROLE_KEY to
// include the answer keys in the review file — local stack only. Against the
// shared project, export the keys read-only instead:
//   select q.id, q.stem, q.parts, k.answers, k.explanation
//   from polya_practice_questions q join polya_practice_keys k on k.question_id = q.id
//   where q.exam_id = '<exam id>' order by q.created_at desc;
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SUPABASE_URL = (process.env.POLYA_SUPABASE_URL ?? "http://127.0.0.1:54331").replace(/\/$/, "");
const ANON_KEY = process.env.POLYA_ANON_KEY ?? "";
const EXAM_ID = process.env.POLYA_EXAM_ID ?? "";
const SERVICE_KEY = process.env.POLYA_SERVICE_ROLE_KEY ?? "";
const TOPIC_LIMIT = Math.min(8, Math.max(1, Number(process.env.POLYA_EVAL_TOPICS ?? 3) || 3));

interface Topic {
  id: string;
  title: string;
}
interface Part {
  kind: string;
  prompt: string;
  options?: string[];
}
interface Question {
  id: string;
  topic_id: string;
  stem: string;
  parts: Part[];
  sources: { n: number; title: string }[];
}
interface Key {
  question_id: string;
  answers: unknown[];
  explanation: string;
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
  const data = (await resp.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("sign-in failed");
  return data.access_token;
}

async function rest<T>(path: string, key: string, bearer: string): Promise<T> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${bearer}` },
  });
  if (!resp.ok) throw new Error(`GET ${path.split("?")[0]} failed (${resp.status})`);
  return (await resp.json()) as T;
}

function renderQuestion(q: Question, topic: string, key: Key | undefined): string {
  const lines = [`## ${topic}`, "", `\`${q.id}\``, "", q.stem, ""];
  q.parts.forEach((part, i) => {
    lines.push(`**Part ${i + 1} (${part.kind})** ${part.prompt}`);
    (part.options ?? []).forEach((option, j) => lines.push(`- ${String.fromCharCode(65 + j)}. ${option}`));
    lines.push("");
  });
  if (key) {
    lines.push("**Key**", "", "```json", JSON.stringify(key.answers, null, 2), "```", "", "**Explanation**", "", key.explanation, "");
  } else {
    lines.push("_Key not included (no service key); export it with the SQL in the script header._", "");
  }
  lines.push(`Sources: ${q.sources.map((s) => `[${s.n}] ${s.title}`).join("; ") || "none"}`, "", "Key correct? ☐ yes ☐ no — note:", "", "---", "");
  return lines.join("\n");
}

async function main() {
  if (!EXAM_ID) throw new Error("Set POLYA_EXAM_ID to an exam that has topics.");
  const token = await getToken();
  const topics = await rest<Topic[]>(
    `polya_study_topics?exam_id=eq.${EXAM_ID}&select=id,title&order=position.asc`,
    ANON_KEY,
    token,
  );
  if (topics.length === 0) throw new Error("That exam has no topics yet. Suggest or add some first.");

  const kept: Question[] = [];
  const failures: Record<string, number> = {};
  let written = 0;
  let calls = 0;
  const latencies: number[] = [];

  for (const topic of topics.slice(0, TOPIC_LIMIT)) {
    const started = Date.now();
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/polya-study`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON_KEY, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "generate_questions", exam_id: EXAM_ID, topic_id: topic.id }),
    });
    calls += 1;
    latencies.push(Date.now() - started);
    const data = (await resp.json().catch(() => ({}))) as {
      code?: string;
      written?: number;
      questions?: Question[];
    };
    if (!resp.ok) {
      const code = data.code ?? String(resp.status);
      failures[code] = (failures[code] ?? 0) + 1;
      console.log(`  ✗ ${topic.title}: ${code}`);
      if (code === "rate_limited") break;
      continue;
    }
    written += data.written ?? 0;
    kept.push(...(data.questions ?? []));
    console.log(`  ✓ ${topic.title}: kept ${data.questions?.length ?? 0} of ${data.written ?? 0} (${latencies.at(-1)} ms)`);
  }

  let keys: Key[] = [];
  if (SERVICE_KEY && kept.length > 0) {
    keys = await rest<Key[]>(
      `polya_practice_keys?question_id=in.(${kept.map((q) => q.id).join(",")})&select=question_id,answers,explanation`,
      SERVICE_KEY,
      SERVICE_KEY,
    );
  }
  const keyFor = new Map(keys.map((k) => [k.question_id, k]));
  const titleFor = new Map(topics.map((t) => [t.id, t.title]));

  await mkdir(join(here, "..", "..", "data"), { recursive: true });
  const outPath = join(here, "..", "..", "data", `study-eval-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  await writeFile(
    outPath,
    [`# Study eval — exam ${EXAM_ID}`, "", ...kept.map((q) => renderQuestion(q, titleFor.get(q.topic_id) ?? "Topic", keyFor.get(q.id)))].join("\n"),
  );

  const mean = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  console.log(
    `\nCalls: ${calls} | written: ${written} | kept: ${kept.length} (${written ? Math.round((100 * kept.length) / written) : 0}%) | mean latency: ${mean} ms`,
  );
  if (Object.keys(failures).length > 0) console.log(`Failures: ${JSON.stringify(failures)}`);
  console.log(`Review file: ${outPath}`);
  if (calls > 0 && Object.values(failures).reduce((a, b) => a + b, 0) === calls) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
