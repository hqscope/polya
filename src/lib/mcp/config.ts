// Addresses the ChatGPT / Claude connector advertises. The resource URL must
// match, character for character, the URL a user pastes into Claude, so it is
// derived from the one canonical site origin.
//
// No `next` imports: Node tests load this file.
import { siteUrl } from "../seo.ts";
import { getSupabaseConfig } from "../supabase/config.ts";

export const MCP_PATH = "/mcp";

export function mcpResourceUrl(): string {
  return `${siteUrl}${MCP_PATH}`;
}

export function protectedResourceMetadataUrl(): string {
  return `${siteUrl}/.well-known/oauth-protected-resource${MCP_PATH}`;
}

/** Supabase Auth's OAuth 2.1 server is the authorization server. */
export function authorizationServerIssuer(): string {
  return `${getSupabaseConfig().url.replace(/\/$/, "")}/auth/v1`;
}

/** RFC 8414 metadata location for an issuer with a path component. */
export function authorizationServerMetadataUrl(): string {
  const issuer = new URL(authorizationServerIssuer());
  return `${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname}`;
}

/** Every place Supabase Auth may publish its metadata, most specific first. */
export function authorizationServerMetadataCandidates(): string[] {
  const issuer = authorizationServerIssuer();
  return [
    authorizationServerMetadataUrl(),
    `${issuer}/.well-known/oauth-authorization-server`,
    `${issuer}/.well-known/openid-configuration`,
  ];
}

export function protectedResourceMetadata() {
  return {
    resource: mcpResourceUrl(),
    authorization_servers: [authorizationServerIssuer()],
    bearer_methods_supported: ["header"],
    resource_name: "Polya",
    resource_documentation: `${siteUrl}/connect`,
  };
}

/** The 401 challenge both clients use to discover how to sign in. */
export function wwwAuthenticateHeader(): string {
  return `Bearer resource_metadata="${protectedResourceMetadataUrl()}"`;
}
