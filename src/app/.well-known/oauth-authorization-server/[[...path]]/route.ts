// Older MCP clients look for authorization-server metadata on the resource's
// own origin instead of following protected-resource metadata. Relay Supabase
// Auth's metadata so they find the same sign-in.
import { authorizationServerMetadataCandidates } from "@/lib/mcp/config";

export const revalidate = 3600;

export async function GET(): Promise<Response> {
  for (const url of authorizationServerMetadataCandidates()) {
    const upstream = await fetch(url, { next: { revalidate: 3600 } }).catch(() => null);
    if (upstream?.ok) {
      return Response.json(await upstream.json(), {
        headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" },
      });
    }
  }
  return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
}
