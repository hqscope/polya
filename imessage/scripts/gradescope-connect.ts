// Connect a Polya student's Gradescope account (run locally by Noel):
//
//   node --env-file=.env.local scripts/gradescope-connect.ts <polya-user-email>
//   node --env-file=.env.local scripts/gradescope-connect.ts <polya-user-email> --cookie
//
// Password mode asks for the Gradescope email and password (hidden). --cookie is for school
// sign-in (SSO, e.g. CalNet) accounts with no Gradescope password: paste the Cookie header from
// a signed-in browser request to www.gradescope.com (signed_token, remember_me,
// _gradescope_session). Logs in, verifies, prints the course names it can see, and stores the
// sealed session. Never prints the password or cookie values.
//
// Needs POLYA_SUPABASE_URL, POLYA_SUPABASE_SERVICE_ROLE_KEY, GRADESCOPE_SECRET_KEY.
import { createInterface } from "node:readline/promises";

import { serviceDb } from "../agent/lib/db.ts";
import { GradescopeClient, GradescopeError } from "../agent/lib/gradescope/client.ts";
import { saveGradescopeConnection } from "../agent/lib/gradescope/store.ts";
import { secretKey } from "../agent/lib/secret-box.ts";

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Reads a line without echoing it. */
function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ask(question);
  process.stdout.write(question);
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (err?: Error): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("Cancelled"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function findUserId(email: string): Promise<string | null> {
  const db = serviceDb();
  const target = email.trim().toLowerCase();
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`Looking up the Polya user failed: ${error.message}`);
    const match = data.users.find((u) => u.email?.toLowerCase() === target);
    if (match) return match.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useCookie = args.includes("--cookie");
  const polyaEmail = args.find((a) => !a.startsWith("--"));
  if (!polyaEmail) {
    console.error("Usage: node --env-file=.env.local scripts/gradescope-connect.ts <polya-user-email> [--cookie]");
    process.exit(2);
  }

  secretKey(); // fail before asking for anything if the key is missing or malformed

  const userId = await findUserId(polyaEmail);
  if (!userId) {
    console.error(`No Polya account uses ${polyaEmail}.`);
    process.exit(1);
  }
  console.log(`Polya account found for ${polyaEmail}.`);

  let client: GradescopeClient;
  let gsEmail: string | null;
  let password: string | null = null;
  if (useCookie) {
    gsEmail = (await ask("Gradescope email (optional, for your reference): ")) || null;
    const header = await askHidden("Paste the Gradescope Cookie header (hidden): ");
    client = GradescopeClient.fromSessionCookies(header);
    if (!client.hasCookie("_gradescope_session") && !client.hasCookie("signed_token") && !client.hasCookie("remember_me")) {
      console.error("That doesn't contain signed_token, remember_me, or _gradescope_session.");
      process.exit(1);
    }
    if (!(await client.verify())) {
      console.error("Gradescope didn't accept those cookies. Sign in again in the browser and copy a fresh Cookie header.");
      process.exit(1);
    }
  } else {
    gsEmail = await ask("Gradescope email: ");
    password = await askHidden("Gradescope password (hidden): ");
    client = new GradescopeClient();
    await client.loginWithPassword(gsEmail, password);
  }

  const courses = await client.listCourses();
  const student = courses.filter((c) => c.role === "student");
  console.log(`Signed in. Courses visible (${courses.length}, ${student.length} as a student):`);
  for (const c of courses) {
    const label = c.name && c.name !== c.short_name ? `${c.short_name} — ${c.name}` : c.short_name;
    console.log(`  - ${label}${c.term ? ` (${c.term})` : ""}${c.role === "instructor" ? " [instructor]" : ""}`);
  }

  await saveGradescopeConnection(userId, { email: gsEmail, session: client.exportSession(), password });
  console.log("Saved the encrypted Gradescope connection.");
}

main().catch((error: unknown) => {
  if (error instanceof GradescopeError) console.error(`Gradescope: ${error.message} [${error.code}]`);
  else console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
