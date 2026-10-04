// Test-only: run an edge function's real handler in-process against a fake
// backend. No function imports this file, so it is never deployed.
//
// - `loadHandler` imports a function's index.ts with `Deno.serve` swapped for a
//   stub that captures the handler (no port is bound), and caches it, so
//   several test files can share one import of the same module.
// - `setBackend` answers every outbound fetch (Supabase REST/RPC/auth) through
//   a route you supply; anything the route doesn't answer throws. The fetch
//   swap and the env below are installed before the first import, because the
//   shared clients read SUPABASE_URL and capture `fetch` at module load.

export type Handler = (request: Request) => Response | Promise<Response>;
export type BackendRoute = (url: URL, request: Request) => Response | null | Promise<Response | null>;

export const TEST_SERVICE_ROLE_KEY = "test-service-role-key";
export const TEST_PUMP_SECRET = "test-pump-secret";
export const TEST_USER_ID = "00000000-0000-4000-8000-000000000001";
export const TEST_USER_JWT = "test-user-jwt";

const BACKEND_ORIGIN = "http://backend.test";

let route: BackendRoute = () => null;
let installed = false;
const handlers = new Map<string, Handler>();

export function setBackend(next: BackendRoute): void {
  route = next;
}

function install(): void {
  if (installed) return;
  installed = true;
  Deno.env.set("SUPABASE_URL", BACKEND_ORIGIN);
  Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", TEST_SERVICE_ROLE_KEY);
  Deno.env.set("POLYA_PUMP_SECRET", TEST_PUMP_SECRET);
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const response = await route(url, request);
    if (!response) throw new Error(`unexpected fetch in test: ${request.method} ${url.pathname}`);
    return response;
  };
}

export async function loadHandler(moduleUrl: string): Promise<Handler> {
  install();
  const cached = handlers.get(moduleUrl);
  if (cached) return cached;

  let captured: Handler | undefined;
  const denoWithServe = Deno as unknown as { serve: (...args: unknown[]) => unknown };
  const realServe = denoWithServe.serve;
  denoWithServe.serve = (...args: unknown[]) => {
    captured = args.find((arg): arg is Handler => typeof arg === "function");
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve(), ref() {}, unref() {} };
  };
  try {
    await import(moduleUrl);
  } finally {
    denoWithServe.serve = realServe;
  }
  if (!captured) {
    throw new Error(`${moduleUrl} did not call Deno.serve (already imported elsewhere?)`);
  }
  handlers.set(moduleUrl, captured);
  return captured;
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Answers GoTrue's /auth/v1/user for TEST_USER_JWT, else null. */
export function authRoute(url: URL, request: Request): Response | null {
  if (url.pathname !== "/auth/v1/user") return null;
  const bearer = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (bearer !== TEST_USER_JWT) {
    return jsonResponse({ code: 401, error_code: "bad_jwt", msg: "invalid JWT" }, 401);
  }
  return jsonResponse({ id: TEST_USER_ID, aud: "authenticated", role: "authenticated", email: "t@example.test" });
}

/** The RPC name for a PostgREST /rest/v1/rpc/<name> call, else null. */
export function rpcName(url: URL): string | null {
  const match = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z0-9_]+)$/);
  return match ? match[1] : null;
}
