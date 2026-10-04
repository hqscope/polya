// RFC 9728 protected-resource metadata for the /mcp connector. Served at both
// /.well-known/oauth-protected-resource and .../oauth-protected-resource/mcp,
// since clients try the path-suffixed form first.
import { protectedResourceMetadata } from "@/lib/mcp/config";

export const dynamic = "force-static";

export function GET(): Response {
  return Response.json(protectedResourceMetadata(), {
    headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" },
  });
}
