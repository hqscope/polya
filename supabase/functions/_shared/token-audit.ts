// Audit rows for server-side uses of a stored Canvas access token, in the same
// shape canvas-proxy writes (platform-hardening Tasks 8.1 / 8.1b): one row per
// use in public.canvas_connection_audit, inserted before the token is
// decrypted, so a use without a row can't happen. Pure module (no Deno
// globals) so Node's test runner covers it; connections.ts binds it to the
// service-role client.
import { CanvasAuthError, CanvasHttpError } from "./canvas.ts";

export const AUDIT_TABLE = "canvas_connection_audit";
// The audit table's `client` column: which product used the token.
export const AUDIT_CLIENT = "polya";

// Must stay within the audit table's check constraints
// (lectra-ios/backend/migrations/20260924034309_canvas_connections_platform.sql).
export type TokenUseAction = "connect" | "query" | "disconnect";
export type TokenUseOutcome =
  | "started"
  | "ok"
  | "canvas_auth"
  | "canvas_http"
  | "canvas_unreachable"
  | "error";

export interface TokenUse {
  /** The edge function using the token, e.g. "polya-import". */
  source: string;
  action: TokenUseAction;
  /** What the token is for, e.g. "list_courses"; null for connect / disconnect. */
  operation: string | null;
}

export interface TokenUseEntry extends TokenUse {
  userId: string;
  connectionId: string | null;
  baseUrl: string | null;
  outcome?: TokenUseOutcome;
}

export interface AuditRow {
  user_id: string;
  connection_id: string | null;
  host: string | null;
  source: string;
  client: string;
  action: TokenUseAction;
  operation: string | null;
  outcome: TokenUseOutcome;
  finished_at: string | null;
}

export interface AuditFinish {
  outcome: TokenUseOutcome;
  canvas_status: number | null;
  pages: number | null;
  finished_at: string;
}

/** Storage for audit rows. insert returns the new row's id, or null on failure. */
export interface AuditSink {
  insert(row: AuditRow): Promise<number | null>;
  update(id: number, patch: AuditFinish): Promise<void>;
}

/** The audit row couldn't be written, so the token must not be used. */
export class TokenAuditError extends Error {
  constructor(message = "Canvas token audit unavailable") {
    super(message);
    this.name = "TokenAuditError";
  }
}

export function hostOf(baseUrl: string | null): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return null;
  }
}

export function auditRow(entry: TokenUseEntry, now: Date): AuditRow {
  const outcome = entry.outcome ?? "started";
  return {
    user_id: entry.userId,
    connection_id: entry.connectionId,
    host: hostOf(entry.baseUrl),
    source: entry.source,
    client: AUDIT_CLIENT,
    action: entry.action,
    operation: entry.operation,
    outcome,
    finished_at: outcome === "started" ? null : now.toISOString(),
  };
}

/** Writes the row before the token is used. Fails closed: throws TokenAuditError. */
export async function startTokenUse(
  sink: AuditSink,
  entry: TokenUseEntry,
  now: () => Date = () => new Date(),
): Promise<number> {
  const id = await sink.insert(auditRow(entry, now()));
  if (id === null) throw new TokenAuditError();
  return id;
}

export async function finishTokenUse(
  sink: AuditSink,
  id: number,
  outcome: TokenUseOutcome,
  detail: { canvasStatus?: number | null; pages?: number | null } = {},
  now: () => Date = () => new Date(),
): Promise<void> {
  await sink.update(id, {
    outcome,
    canvas_status: detail.canvasStatus ?? null,
    pages: detail.pages ?? null,
    finished_at: now().toISOString(),
  });
}

/**
 * Releases a stored token for one use: writes the audit row, then decrypts.
 * If the row can't be written the token is never decrypted (TokenAuditError).
 * The row ends "ok" once the token is released, or "error" if decrypt fails;
 * a caller that learns how its Canvas call went may overwrite that.
 */
export async function auditedDecrypt(
  sink: AuditSink,
  entry: TokenUseEntry,
  decrypt: () => Promise<string>,
  now: () => Date = () => new Date(),
): Promise<{ token: string; auditId: number }> {
  const auditId = await startTokenUse(sink, entry, now);
  let token: string;
  try {
    token = await decrypt();
  } catch (error) {
    await finishTokenUse(sink, auditId, "error", {}, now);
    throw error;
  }
  await finishTokenUse(sink, auditId, "ok", {}, now);
  return { token, auditId };
}

/** Maps a failed Canvas call to an audit outcome. */
export function outcomeForError(error: unknown): { outcome: TokenUseOutcome; canvasStatus: number | null } {
  if (error instanceof CanvasAuthError) return { outcome: "canvas_auth", canvasStatus: 401 };
  if (error instanceof CanvasHttpError) return { outcome: "canvas_http", canvasStatus: error.status };
  return { outcome: "error", canvasStatus: null };
}
