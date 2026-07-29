// AES-256-GCM envelope for Canvas access tokens. Pure WebCrypto
// (globalThis.crypto) so it runs identically in the Deno edge runtime and in
// Node 22's test runner. Payload layout: base64(iv[12] || ciphertext+tag).
// The key never leaves edge-function env (POLYA_TOKEN_KEY, 32 bytes base64).

export const CURRENT_KEY_VERSION = 1;

const IV_BYTES = 12;

function b64encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importKey(keyBase64: string): Promise<CryptoKey> {
  const raw = b64decode(keyBase64.trim());
  if (raw.length !== 32) throw new Error("Token key must be 32 bytes (base64)");
  return crypto.subtle.importKey("raw", raw.buffer as ArrayBuffer, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptToken(plaintext: string, keyBase64: string): Promise<string> {
  const key = await importKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const payload = new Uint8Array(IV_BYTES + ciphertext.length);
  payload.set(iv, 0);
  payload.set(ciphertext, IV_BYTES);
  return b64encode(payload);
}

export async function decryptToken(payloadBase64: string, keyBase64: string): Promise<string> {
  const key = await importKey(keyBase64);
  const payload = b64decode(payloadBase64);
  if (payload.length <= IV_BYTES) throw new Error("Token payload too short");
  const iv = payload.slice(0, IV_BYTES);
  const ciphertext = payload.slice(IV_BYTES);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext.buffer as ArrayBuffer,
  );
  return new TextDecoder().decode(plaintext);
}
