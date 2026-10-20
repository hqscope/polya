// Calls Noel's personal hub from code (the digest loop, hub-digest.ts), the same way scope-ops'
// iMessage agent calls its MCP server (scope-ops/imessage/agent/lib/scope-ops.ts). Only the
// DIGEST_HUB_TOOLS read tools can be called; anything else throws before a request is made.
//
// Results stay in memory. Nothing a tool returns is logged: errors log the tool name and the hub's
// error code ("TOKEN_EXPIRED"), never the message text, which can carry account names or content.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { DIGEST_HUB_TOOLS, type DigestHubTool, type HubConfig } from "./noel-hub.ts";

/** A hub read: its structured result, or ok false with the hub's error code when it has one. */
export interface HubCallResult {
  readonly ok: boolean;
  readonly structured: unknown;
  readonly errorCode: string | null;
}

export interface HubReader {
  call(name: DigestHubTool, args: Record<string, unknown>): Promise<HubCallResult>;
}

/** Per request; the whole check-in run shares one function invocation. */
const REQUEST_TIMEOUT_MS = 20_000;

/** Throws for any tool outside DIGEST_HUB_TOOLS, so a write tool can never be called from code. */
export function assertDigestTool(name: string): asserts name is DigestHubTool {
  if (!(DIGEST_HUB_TOOLS as readonly string[]).includes(name)) throw new Error(`${name} isn't a digest read tool`);
}

/** "Error (TOKEN_EXPIRED): ..." -> "TOKEN_EXPIRED" (the hub's errorResult format). */
export function hubErrorCode(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    const text = (part as { type?: unknown; text?: unknown } | null)?.text;
    const match = typeof text === "string" ? /^Error \(([A-Z_]{2,40})\)/.exec(text) : null;
    if (match?.[1]) return match[1];
  }
  return null;
}

/** Opens one MCP session to the hub, runs `fn` with a read-only caller, and always closes it. */
export async function withHubReader<T>(hub: HubConfig, fn: (reader: HubReader) => Promise<T>): Promise<T> {
  const client = new Client({ name: "polya-imessage-digest", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(hub.url), {
    requestInit: { headers: { authorization: `Bearer ${hub.token}` } },
  });
  try {
    await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS });
    const reader: HubReader = {
      async call(name, args) {
        assertDigestTool(name);
        try {
          const result = await client.callTool({ name, arguments: args }, undefined, { timeout: REQUEST_TIMEOUT_MS });
          if (result.isError === true) {
            const errorCode = hubErrorCode(result.content);
            console.error("[polya digest] hub tool returned an error", { tool: name, code: errorCode ?? "unknown" });
            return { ok: false, structured: null, errorCode };
          }
          return { ok: true, structured: result.structuredContent ?? null, errorCode: null };
        } catch (error) {
          console.error("[polya digest] hub tool call failed", { tool: name, error: error instanceof Error ? error.name : "unknown" });
          return { ok: false, structured: null, errorCode: null };
        }
      },
    };
    return await fn(reader);
  } finally {
    await client.close().catch(() => {});
  }
}
