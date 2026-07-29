// Seeds the committed synthetic demo course into a Polya backend and runs the
// import pump to completion. Verifies the full ingest path (seed -> parse ->
// chunk -> embed -> content_units) against whichever backend the env points at.
//
// Env:
//   POLYA_SUPABASE_URL   Supabase project URL (default: local stack :54331)
//   POLYA_ANON_KEY       anon/publishable key for that project
//   POLYA_ACCESS_TOKEN   a user JWT (skip email/password sign-in if provided)
//   POLYA_TEST_EMAIL     email+password to sign in / sign up (local dev)
//   POLYA_TEST_PASSWORD
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "fixtures", "demo-course");

const SUPABASE_URL = process.env.POLYA_SUPABASE_URL ?? "http://127.0.0.1:54331";
const ANON_KEY = process.env.POLYA_ANON_KEY ?? "";
const FUNCTIONS_URL = `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1`;

interface ManifestFile {
  title: string;
  origin: string;
  source_kind: string;
  content_role?: string;
  path: string;
  content_type: string;
  ext: string;
}
interface Manifest {
  course_name: string;
  files: ManifestFile[];
}

async function getAccessToken(): Promise<string> {
  if (process.env.POLYA_ACCESS_TOKEN) return process.env.POLYA_ACCESS_TOKEN;

  const email = process.env.POLYA_TEST_EMAIL;
  const password = process.env.POLYA_TEST_PASSWORD;
  if (!email || !password) {
    throw new Error("Provide POLYA_ACCESS_TOKEN, or POLYA_TEST_EMAIL + POLYA_TEST_PASSWORD.");
  }

  // Try sign-in, fall back to sign-up (local stack has confirmations disabled).
  for (const path of ["/auth/v1/token?grant_type=password", "/auth/v1/signup"]) {
    const resp = await fetch(`${SUPABASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON_KEY },
      body: JSON.stringify({ email, password }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.access_token) return data.access_token as string;
  }
  throw new Error("Couldn't obtain a user access token from the auth endpoint.");
}

async function invoke<T>(token: string, name: string, body: Record<string, unknown>): Promise<T> {
  const resp = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      apikey: ANON_KEY,
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`${name} ${resp.status}: ${JSON.stringify(data)}`);
  }
  return data as T;
}

async function main() {
  const manifest = JSON.parse(
    await readFile(join(fixtureRoot, "manifest.json"), "utf8"),
  ) as Manifest;

  const token = await getAccessToken();

  const files = await Promise.all(
    manifest.files.map(async (file) => ({
      title: file.title,
      origin: file.origin,
      source_kind: file.source_kind,
      content_role: file.content_role,
      content_type: file.content_type,
      ext: file.ext,
      content_base64: (await readFile(join(fixtureRoot, file.path))).toString("base64"),
    })),
  );

  console.log(`Seeding "${manifest.course_name}" (${files.length} files)…`);
  const seeded = await invoke<{ course_id: string; source_count: number }>(
    token,
    "polya-import",
    { action: "seed_fixture", course_name: manifest.course_name, files },
  );
  console.log(`  course_id=${seeded.course_id}, queued ${seeded.source_count} sources`);

  let done = false;
  let steps = 0;
  while (!done && steps++ < 500) {
    const result = await invoke<{
      done: boolean;
      status?: string;
      progress: Record<string, number>;
    }>(token, "polya-import", { action: "process", course_id: seeded.course_id });
    done = result.done;
    if (result.status) {
      process.stdout.write(`  step ${steps}: ${result.status} (ready ${result.progress.ready}/${result.progress.total})\n`);
    }
  }

  const status = await invoke<{ progress: Record<string, number>; sources: Array<Record<string, unknown>> }>(
    token,
    "polya-import",
    { action: "status", course_id: seeded.course_id },
  );
  console.log("\nFinal:", JSON.stringify(status.progress));
  for (const source of status.sources) {
    console.log(`  - ${source.title}: ${source.status} (${source.chunks_embedded} units)`);
  }
  console.log(`\nCOURSE_ID=${seeded.course_id}`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
