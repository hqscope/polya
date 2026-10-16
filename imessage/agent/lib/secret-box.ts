// AES-256-GCM sealing for secrets the agent stores at rest (Gradescope session cookies and
// passwords). The key is GRADESCOPE_SECRET_KEY: 32 random bytes, base64. The database only ever
// sees `v1.<iv>.<tag>.<ciphertext>` (base64url parts); losing the key makes every row unreadable,
// and students reconnect.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export const SECRET_KEY_VERSION = 1;

export class SecretBoxError extends Error {}

/** Reads and validates the 32-byte key from env (or the given base64 string). */
export function secretKey(base64 = process.env.GRADESCOPE_SECRET_KEY): Buffer {
  if (!base64) throw new SecretBoxError("GRADESCOPE_SECRET_KEY is not set");
  const key = Buffer.from(base64.trim(), "base64");
  if (key.length !== 32) throw new SecretBoxError("GRADESCOPE_SECRET_KEY must be 32 bytes, base64-encoded");
  return key;
}

export function seal(plaintext: string, key: Buffer = secretKey()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function open(sealed: string, key: Buffer = secretKey()): string {
  const [version, ivPart, tagPart, dataPart, ...rest] = sealed.split(".");
  if (version !== VERSION || ivPart === undefined || tagPart === undefined || dataPart === undefined || rest.length > 0) {
    throw new SecretBoxError("Unrecognized sealed value");
  }
  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new SecretBoxError("Unrecognized sealed value");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretBoxError("Sealed value failed authentication (wrong key or tampered data)");
  }
}
