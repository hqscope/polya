// Lectra storage quota for service-role writes (platform-hardening Task 4.3).
// Signed-in uploads to polya_documents are held to the quota by the storage
// policies; the service role bypasses those, so every service-role write asks
// public.storage_upload_check() first. It allows the write while the account
// is under its quota, or when the write overwrites an object that already
// exists at that path (the same rule the policies apply).
// Pure module (no Deno globals) so Node's test runner covers it directly.
import type { RpcClient } from "./rate-limit.ts";

// The `code` clients match on. HTTP responses use 403 with
// { error, code: "storage_full", used_bytes, quota_bytes }.
export const STORAGE_FULL_CODE = "storage_full";
export const STORAGE_FULL_STATUS = 403;

// User-facing text, from COPY.md `full.polya.importFailed.body` minus the
// numbers. Also stored as polya_sources.error on a source that couldn't be
// saved, so the client can recognise it by exact match.
export const STORAGE_FULL_MESSAGE =
  "Your Lectra storage is full. Free up space or get more storage in Lectra, then try again.";

export class StorageFullError extends Error {
  readonly code = STORAGE_FULL_CODE;
  readonly usedBytes: number | null;
  readonly quotaBytes: number | null;
  constructor(usedBytes: number | null, quotaBytes: number | null) {
    super(STORAGE_FULL_MESSAGE);
    this.name = "StorageFullError";
    this.usedBytes = usedBytes;
    this.quotaBytes = quotaBytes;
  }
}

// The check couldn't run. Fail closed (nothing is written unchecked), as an
// ordinary retry: process.ts's isTransient() retries anything `transient`.
export class StorageCheckUnavailableError extends Error {
  readonly transient = true;
  constructor() {
    super("Storage check temporarily unavailable.");
    this.name = "StorageCheckUnavailableError";
  }
}

export interface StorageCheck {
  allowed: boolean;
  usedBytes: number | null;
  quotaBytes: number | null;
}

function toBytes(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Asks whether `userId` may write `path` into `bucket`. Pass `path = null` to
 * ask only "is the account under its quota?" (e.g. before queueing an import).
 * Throws StorageCheckUnavailableError when the check itself fails.
 */
export async function checkStorageRoom(
  client: RpcClient,
  userId: string,
  bucket: string,
  path: string | null,
): Promise<StorageCheck> {
  let result: { data: unknown; error: unknown };
  try {
    result = await client.rpc("storage_upload_check", {
      p_user_id: userId,
      p_bucket: bucket,
      p_name: path,
    });
  } catch {
    throw new StorageCheckUnavailableError();
  }
  const data = result.data as Record<string, unknown> | null;
  if (result.error || !data || typeof data !== "object" || typeof data.allowed !== "boolean") {
    throw new StorageCheckUnavailableError();
  }
  return {
    allowed: data.allowed,
    usedBytes: toBytes(data.used_bytes),
    quotaBytes: toBytes(data.quota_bytes),
  };
}

/** Throws StorageFullError unless the write is allowed. Call it BEFORE writing. */
export async function assertStorageRoom(
  client: RpcClient,
  userId: string,
  bucket: string,
  path: string | null,
): Promise<void> {
  const check = await checkStorageRoom(client, userId, bucket, path);
  if (!check.allowed) throw new StorageFullError(check.usedBytes, check.quotaBytes);
}

/** JSON body for a STORAGE_FULL_STATUS response. */
export function storageFullBody(err: StorageFullError): {
  error: string;
  code: string;
  used_bytes: number | null;
  quota_bytes: number | null;
} {
  return {
    error: STORAGE_FULL_MESSAGE,
    code: STORAGE_FULL_CODE,
    used_bytes: err.usedBytes,
    quota_bytes: err.quotaBytes,
  };
}
