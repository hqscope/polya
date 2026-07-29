// Canvas connection read/write with encryption at rest. The only modules that
// may touch polya_canvas_connections tokens. Deno-only (reads env); the pure
// crypto lives in token-crypto.ts so Node tests can cover it.
import { service } from "./service.ts";
import { CURRENT_KEY_VERSION, decryptToken, encryptToken } from "./token-crypto.ts";

const TOKEN_KEY = Deno.env.get("POLYA_TOKEN_KEY") ?? "";

function requireKey(): string {
  if (!TOKEN_KEY) {
    // Fail closed: without the key we neither store nor read tokens.
    console.error("[polya] POLYA_TOKEN_KEY is not set — refusing to handle Canvas tokens");
    throw new Error("Token key unavailable");
  }
  return TOKEN_KEY;
}

export interface ConnectionWithToken {
  id: string;
  base_url: string;
  status: string;
  access_token: string;
}

export interface CanvasSelf {
  id: string | null;
  name: string | null;
}

// Upsert the connection storing only ciphertext (access_token stays null).
export async function saveConnection(
  userId: string,
  baseUrl: string,
  accessToken: string,
  self: CanvasSelf,
) {
  const ciphertext = await encryptToken(accessToken.trim(), requireKey());
  return await service
    .from("polya_canvas_connections")
    .upsert(
      {
        user_id: userId,
        base_url: baseUrl,
        access_token: null,
        access_token_ciphertext: ciphertext,
        key_version: CURRENT_KEY_VERSION,
        canvas_user_id: self.id,
        canvas_user_name: self.name,
        status: "active",
        last_validated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,base_url" },
    )
    .select("id, base_url, canvas_user_name, status")
    .single();
}

// Load a connection and return the decrypted token. Legacy plaintext rows
// (pre-encryption) are re-encrypted in place on first read and their
// plaintext column nulled.
export async function loadConnectionWithToken(
  userId: string,
  connectionId?: string,
): Promise<ConnectionWithToken | null> {
  let query = service
    .from("polya_canvas_connections")
    .select("id, base_url, status, access_token, access_token_ciphertext")
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
    access_token: string | null;
    access_token_ciphertext: string | null;
  };

  let token: string;
  if (row.access_token_ciphertext) {
    token = await decryptToken(row.access_token_ciphertext, requireKey());
  } else if (row.access_token) {
    token = row.access_token;
    // Lazy migration: encrypt now, drop the plaintext.
    const ciphertext = await encryptToken(token, requireKey());
    await service
      .from("polya_canvas_connections")
      .update({
        access_token: null,
        access_token_ciphertext: ciphertext,
        key_version: CURRENT_KEY_VERSION,
      })
      .eq("id", row.id);
  } else {
    return null; // no usable credential
  }

  return { id: row.id, base_url: row.base_url, status: row.status, access_token: token };
}
