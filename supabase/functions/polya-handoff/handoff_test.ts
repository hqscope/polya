// polya-handoff through the real handler against a fake backend
// (_shared/test-serve.ts): POST-only, signed-in only, the hourly window failing
// closed, and a token only for the caller's own account.
//
// Run: deno test --allow-env --allow-read --no-check supabase/functions/polya-handoff/
import { assertEquals } from "jsr:@std/assert@1";
import {
  authRoute,
  jsonResponse,
  loadHandler,
  rpcName,
  setBackend,
  TEST_USER_ID,
  TEST_USER_JWT,
} from "../_shared/test-serve.ts";
import { HANDOFF_HOURLY_BUCKET, HANDOFF_HOURLY_LIMIT } from "../_shared/polya-rate-limits.ts";

const handler = await loadHandler(new URL("./index.ts", import.meta.url).href);
const URL_ = "http://polya.test/functions/v1/polya-handoff";
const TOKEN_HASH = "4f2c9a0e8b7d6c5a4f2c9a0e8b7d6c5a4f2c9a0e8b7d6c5a4f2c9a0e";

type Calls = { rpc: { name: string; args: Record<string, unknown> }[]; links: Record<string, unknown>[] };

// Auth answers for TEST_USER_JWT; the limiter answers `withinLimit`; GoTrue's
// generate_link answers for `linkUserId` (GoTrue returns the user's fields and
// the link properties side by side).
function backend({ withinLimit = true, linkUserId = TEST_USER_ID } = {}): Calls {
  const calls: Calls = { rpc: [], links: [] };
  setBackend(async (url, request) => {
    const auth = authRoute(url, request);
    if (auth) return auth;
    const name = rpcName(url);
    if (name) {
      calls.rpc.push({ name, args: (await request.json()) as Record<string, unknown> });
      return jsonResponse(withinLimit);
    }
    if (url.pathname === "/auth/v1/admin/generate_link") {
      calls.links.push((await request.json()) as Record<string, unknown>);
      return jsonResponse({
        id: linkUserId,
        aud: "authenticated",
        email: "t@example.test",
        action_link: "http://backend.test/auth/v1/verify?token=x&type=magiclink",
        email_otp: "123456",
        hashed_token: TOKEN_HASH,
        redirect_to: "",
        verification_type: "magiclink",
      });
    }
    return null;
  });
  return calls;
}

function post(jwt: string | null = TEST_USER_JWT): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  return new Request(URL_, { method: "POST", headers, body: "{}" });
}

Deno.test("POST only", async () => {
  backend();
  const response = await handler(new Request(URL_, { method: "GET" }));
  assertEquals(response.status, 405);
  await response.body?.cancel();
});

Deno.test("signed out gets no token", async () => {
  const calls = backend();
  const anonymous = await handler(post(null));
  assertEquals(anonymous.status, 401);
  await anonymous.body?.cancel();
  const forged = await handler(post("not-a-real-jwt"));
  assertEquals(forged.status, 401);
  await forged.body?.cancel();
  assertEquals(calls.links.length, 0);
});

Deno.test("a signed-in student gets a magic-link token for their own email", async () => {
  const calls = backend();
  const response = await handler(post());
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { token_hash: TOKEN_HASH });
  assertEquals(calls.rpc, [{
    name: "claim_rate_limit",
    args: {
      p_subject: `user:${TEST_USER_ID}`,
      p_bucket: HANDOFF_HOURLY_BUCKET,
      p_limit: HANDOFF_HOURLY_LIMIT,
      p_window_seconds: 3600,
    },
  }]);
  assertEquals(calls.links.length, 1);
  assertEquals(calls.links[0].type, "magiclink");
  assertEquals(calls.links[0].email, "t@example.test");
});

Deno.test("over the hourly window: refused before any token is made", async () => {
  const calls = backend({ withinLimit: false });
  const response = await handler(post());
  assertEquals(response.status, 429);
  await response.body?.cancel();
  assertEquals(calls.links.length, 0);
});

Deno.test("a token for another account is never returned", async () => {
  backend({ linkUserId: "00000000-0000-4000-8000-000000000002" });
  const response = await handler(post());
  assertEquals(response.status, 502);
  const body = await response.json();
  assertEquals(body.token_hash, undefined);
  assertEquals(body.code, "handoff_failed");
});
