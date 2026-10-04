// Canvas connection read/write with encryption at rest. The only modules that
// may touch Canvas tokens. Deno-only (reads env); the pure crypto lives in
// token-crypto.ts and the audit rows in token-audit.ts so Node tests can cover
// them.
//
// Connections are the platform's (platform-hardening Tasks 8.1 / 8.1b): the
// `canvas_connections` relation, shared with canvas-proxy (the Scope extension
// and Lectra). It holds only ciphertext; there is no plaintext token column.
// Every use of a stored token writes a row to canvas_connection_audit before
// the token is decrypted.
import { service } from "./service.ts";
import { CURRENT_KEY_VERSION, decryptToken, encryptToken } from "./token-crypto.ts";
import {
  AUDIT_TABLE,
  auditedDecrypt,
  type AuditSink,
  finishTokenUse as finishWithSink,
  startTokenUse as startWithSink,
  type TokenUse,
  type TokenUseEntry,
  type TokenUseOutcome,
} from "./token-audit.ts";

export const CONNECTIONS_TABLE = "canvas_connections";

const TOKEN_KEY = Deno.env.get("POLYA_TOKEN_KEY") ?? "";

function requireKey(): string {
  if (!TOKEN_KEY) {
    // Fail closed: without the key we neither store nor read tokens.
    console.error("[polya] POLYA_TOKEN_KEY is not set — refusing to handle Canvas tokens");
    throw new Error("Token key unavailable");
  }
  return TOKEN_KEY;
}

const auditSink: AuditSink = {
  async insert(row) {
    try {
      const { data, error } = await service.from(AUDIT_TABLE).insert(row).select("id").single();
      if (error || !data) {
        console.error("[polya] token audit insert failed", { source: row.source, error: error?.message });
        return null;
      }
      return (data as { id: number }).id;
    } catch (error) {
      console.error("[polya] token audit insert threw", { source: row.source, error: String(error) });
      return null;
    }
  },
  async update(id, patch) {
    try {
      const { error } = await service.from(AUDIT_TABLE).update(patch).eq("id", id);
      if (error) console.error("[polya] token audit finish failed", { id, error: error.message });
    } catch (error) {
      console.error("[polya] token audit finish threw", { id, error: String(error) });
    }
  },
};

/** Records a token use before it happens; throws TokenAuditError if it can't. */
export function startTokenUse(entry: TokenUseEntry): Promise<number> {
  return startWithSink(auditSink, entry);
}

/** Records how a token use ended. Never throws. */
export function finishTokenUse(
  auditId: number,
  outcome: TokenUseOutcome,
  detail?: { canvasStatus?: number | null; pages?: number | null },
): Promise<void> {
  return finishWithSink(auditSink, auditId, outcome, detail);
}

export interface ConnectionWithToken {
  id: string;
  base_url: string;
  status: string;
  access_token: string;
  /** The audit row for this use; already finished as "ok" (token released). */
  audit_id: number;
}

export interface CanvasSelf {
  id: string | null;
  name: string | null;
}

// Upsert the connection storing only ciphertext. The caller audits the
// connect (see polya-canvas handleConnect).
export async function saveConnection(
  userId: string,
  baseUrl: string,
  accessToken: string,
  self: CanvasSelf,
) {
  const ciphertext = await encryptToken(accessToken.trim(), requireKey());
  const stamp = new Date().toISOString();
  return await service
    .from(CONNECTIONS_TABLE)
    .upsert(
      {
        user_id: userId,
        base_url: baseUrl,
        access_token_ciphertext: ciphertext,
        key_version: CURRENT_KEY_VERSION,
        canvas_user_id: self.id,
        canvas_user_name: self.name,
        status: "active",
        last_validated_at: stamp,
        last_used_at: stamp,
      },
      { onConflict: "user_id,base_url" },
    )
    .select("id, base_url, canvas_user_name, status")
    .single();
}

// Used when a caller doesn't say what the token is for.
const UNSPECIFIED_USE: TokenUse = { source: "polya", action: "query", operation: null };

// Load a connection and return the decrypted token. Writes the audit row
// first (fails closed with TokenAuditError), then marks it "ok" once the token
// is released to the caller; callers that learn how the Canvas call went can
// overwrite that with finishTokenUse(audit_id, ...).
export async function loadConnectionWithToken(
  userId: string,
  connectionId?: string,
  use: TokenUse = UNSPECIFIED_USE,
): Promise<ConnectionWithToken | null> {
  let query = service
    .from(CONNECTIONS_TABLE)
    .select("id, base_url, status, access_token_ciphertext")
    .eq("user_id", userId);

  query = connectionId
    ? query.eq("id", connectionId)
    : query.order("created_at", { ascending: true }).limit(1);

  const { data, error } = await query.maybeSingle();
  if (error || !data) return null;

  const row = data as {
    id: string;
    base_url: string;
    status: string;
    access_token_ciphertext: string | null;
  };
  if (!row.access_token_ciphertext) return null; // no usable credential

  const key = requireKey();
  const ciphertext = row.access_token_ciphertext;
  const { token, auditId } = await auditedDecrypt(
    auditSink,
    { ...use, userId, connectionId: row.id, baseUrl: row.base_url },
    () => decryptToken(ciphertext, key),
  );

  return { id: row.id, base_url: row.base_url, status: row.status, access_token: token, audit_id: auditId };
}
