// Binds drive-grant.ts to the service-role client and edge env. Deno-only.
//
// Tables are the platform's (lectra-ios/backend migrations), read-only here
// except the audit log: google_tokens (20260924035718 / 20260924041908),
// feature_flags + feature_flag_allowlist, google_drive_audit (20260924052126).
// They don't exist in Polya's self-contained local stack; a missing table
// reads as "no grant", so school-only files fail with the plain message there.
import { service } from "./service.ts";
import { decryptToken } from "./token-crypto.ts";
import {
  createDriveReader,
  DRIVE_FLAG_KEY,
  DRIVE_GRANT_KIND,
  type DriveGrantStore,
  type DriveReader,
} from "./drive-grant.ts";

const TOKEN_KEY = Deno.env.get("POLYA_TOKEN_KEY") ?? "";
// The platform's Drive OAuth client (shared project env; never logged).
const CLIENT_ID = (Deno.env.get("GOOGLE_DRIVE_CLIENT_ID") ?? "").trim();
const CLIENT_SECRET = (Deno.env.get("GOOGLE_DRIVE_CLIENT_SECRET") ?? "").trim();
const AUDIT_SOURCE = "polya-import";

const store: DriveGrantStore = {
  async loadGrant(userId) {
    const { data, error } = await service
      .from("google_tokens")
      .select("refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at, key_version, scopes")
      .eq("user_id", userId)
      .eq("grant_kind", DRIVE_GRANT_KIND)
      .maybeSingle();
    if (error) {
      console.warn("[polya-import] drive grant lookup failed:", error.message);
      return null;
    }
    if (!data?.refresh_token_ciphertext || data.key_version == null) return null;
    return {
      refreshTokenCiphertext: data.refresh_token_ciphertext as string,
      accessTokenCiphertext: (data.access_token_ciphertext as string | null) ?? null,
      accessTokenExpiresAt: (data.access_token_expires_at as string | null) ?? null,
      keyVersion: data.key_version as number,
      scopes: (data.scopes as string[] | null) ?? null,
    };
  },

  async flagAllows(userId) {
    const { data: flag, error } = await service
      .from("feature_flags")
      .select("mode")
      .eq("key", DRIVE_FLAG_KEY)
      .maybeSingle();
    if (error || !flag) return false;
    if (flag.mode === "on") return true;
    if (flag.mode !== "allowlist") return false;
    const { data: listed } = await service
      .from("feature_flag_allowlist")
      .select("user_id")
      .eq("flag_key", DRIVE_FLAG_KEY)
      .eq("user_id", userId)
      .maybeSingle();
    return Boolean(listed);
  },

  async auditStart(userId, fileId) {
    const { data, error } = await service
      .from("google_drive_audit")
      .insert({ user_id: userId, source: AUDIT_SOURCE, client: "polya", action: "read", file_id: fileId, outcome: "started" })
      .select("id")
      .single();
    if (error || !data) {
      console.error("[polya-import] drive audit insert failed:", error?.message);
      return null;
    }
    return data.id as number;
  },

  async auditFinish(id, result) {
    const { error } = await service
      .from("google_drive_audit")
      .update({
        outcome: result.outcome,
        mime_type: result.mimeType ?? null,
        drive_status: result.driveStatus ?? null,
        bytes: result.bytes ?? null,
        finished_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (error) console.error("[polya-import] drive audit finish failed:", error.message);
  },
};

export function newDriveReader(): DriveReader {
  return createDriveReader({
    store,
    fetch: (input, init) => fetch(input, init),
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    decrypt: (ciphertext) => {
      if (!TOKEN_KEY) throw new Error("POLYA_TOKEN_KEY missing");
      return decryptToken(ciphertext, TOKEN_KEY);
    },
  });
}
