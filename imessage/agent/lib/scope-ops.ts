// Calls scope-ops' MCP server (/api/mcp) for the fix loop, the same way scope-ops' own iMessage
// agent does (scope-ops/imessage/agent/lib/scope-ops.ts). The token's HANDOFF_TOKENS entry carries
// "source":"polya", so scope-ops files these tasks as Polya's, offers ship_task on them, and posts
// their status back to channels/fixes.ts.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEFAULT_URL = "https://scope-ops-rose.vercel.app";
/** handoff_task files an issue and posts to Slack; ship_task checks and merges. Both are quick. */
const REQUEST_TIMEOUT_MS = 30_000;

/** The only scope-ops tools the fix loop calls. */
export type ScopeOpsTool = "handoff_task" | "ship_task";

export interface ScopeOpsResult {
  readonly ok: boolean;
  readonly text: string;
  readonly structured: unknown;
}

/** The text parts of an MCP tool result, joined. */
export function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part: unknown) => {
      const p = part as { type?: unknown; text?: unknown } | null;
      return p?.type === "text" && typeof p.text === "string" ? [p.text] : [];
    })
    .join("\n");
}

export async function callScopeOps(name: ScopeOpsTool, args: Record<string, unknown>): Promise<ScopeOpsResult> {
  const token = process.env.SCOPE_OPS_TOKEN?.trim();
  if (!token) return { ok: false, text: "Fixes can't be filed yet: Scope Ops isn't connected.", structured: null };
  const client = new Client({ name: "polya-imessage-fixes", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL("/api/mcp", process.env.SCOPE_OPS_URL?.trim() || DEFAULT_URL), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  try {
    await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS });
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: REQUEST_TIMEOUT_MS });
    return { ok: result.isError !== true, text: textOf(result.content), structured: result.structuredContent ?? null };
  } catch (error) {
    // Log the tool name only: arguments carry Noel's description of the mistake.
    console.error(`[polya fixes] scope-ops ${name} failed`, error instanceof Error ? error.name : "unknown");
    return { ok: false, text: "Scope Ops didn't answer. Try again in a minute.", structured: null };
  } finally {
    await client.close().catch(() => {});
  }
}
