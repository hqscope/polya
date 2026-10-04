// Remote MCP endpoint for the Polya connector in ChatGPT and Claude
// (Streamable HTTP, stateless, JSON responses). Unauthenticated calls get the
// 401 challenge that points clients at Polya's sign-in.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { bearerToken, verifyAccessToken } from "@/lib/mcp/auth";
import { wwwAuthenticateHeader } from "@/lib/mcp/config";
import { buildServer } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized(): Response {
  return Response.json(
    { error: "unauthorized", error_description: "Sign in to Polya to use this connector." },
    { status: 401, headers: { "WWW-Authenticate": wwwAuthenticateHeader() } },
  );
}

async function handle(request: Request): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return unauthorized();

  const check = await verifyAccessToken(token);
  if (!check.ok) {
    return check.outage
      ? Response.json({ error: "temporarily_unavailable" }, { status: 503, headers: { "Retry-After": "30" } })
      : unauthorized();
  }

  const server = buildServer(token);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void server.close();
  }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
