// Storage-full handling for imports and uploads (platform-hardening Task 4.4).
//
// Polya's files count toward the student's Lectra storage. Once enforcement is
// live, an upload into a full account is refused (a direct storage upload fails
// the storage policy with "new row violates row-level security policy"; the
// import function is expected to answer `{ code: "storage_full" }`). Neither
// signal is trusted alone: the client confirms with `get_my_storage_usage()`
// before it tells anyone their storage is full.
//
// Pure and dependency-free so `tests/` can import it under Node's test runner.
// The RPC call itself lives in the components (browser client).

export interface StorageUsage {
  usedBytes: number;
  quotaBytes: number;
  overQuota: boolean;
}

/** What the UI shows. `usage` is null when the numbers couldn't be read. */
export interface StorageFull {
  usage: StorageUsage | null;
}

// Codes the import function may use for a storage-full refusal. `storage_full`
// is the one Polya's client expects; the rest are tolerated aliases.
const STORAGE_FULL_CODES = new Set([
  "storage_full",
  "storage_quota_exceeded",
  "quota_exceeded",
  "over_quota",
]);

// Parses the `get_my_storage_usage()` payload. Only the three fields this
// needs are read, so changes to the rest of it can't break the message.
export function parseStorageUsage(data: unknown): StorageUsage | null {
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  const used = Number(row.used_bytes);
  const quota = Number(row.quota_bytes);
  if (!Number.isFinite(used) || !Number.isFinite(quota) || typeof row.over_quota !== "boolean") {
    return null;
  }
  return { usedBytes: used, quotaBytes: quota, overQuota: row.over_quota };
}

// The import function said so explicitly.
export function isDefinitiveStorageFullError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && STORAGE_FULL_CODES.has(code);
}

// Worth a usage check: an explicit code, or the storage policy's refusal,
// which is not specific to storage being full.
export function isPossibleStorageFullError(err: unknown): boolean {
  if (isDefinitiveStorageFullError(err)) return true;
  if (!err || typeof err !== "object") return false;
  const { statusCode, message } = err as { statusCode?: unknown; message?: unknown };
  if (String(statusCode ?? "") === "403") return true;
  const text = typeof message === "string" ? message.toLowerCase() : "";
  return (
    text.includes("row-level security") ||
    text.includes("row level security") ||
    text.includes("storage is full")
  );
}

// Combines the failure with the usage check's answer (null = couldn't read).
export function storageFullFromCheck(err: unknown, usage: StorageUsage | null): StorageFull | null {
  if (usage?.overQuota) return { usage };
  if (isDefinitiveStorageFullError(err)) return { usage: null };
  return null;
}

// Decimal units (1 GB = 1,000,000,000 bytes) so plan sizes read as sold:
// "500 MB", "25 GB". Never shows raw bytes.
export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1e6) return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  const units: Array<[number, string]> = [
    [1e12, "TB"],
    [1e9, "GB"],
    [1e6, "MB"],
  ];
  for (const [size, unit] of units) {
    if (bytes >= size) {
      const value = bytes / size;
      const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
      return `${rounded} ${unit}`;
    }
  }
  return `${Math.round(bytes / 1e6)} MB`;
}

export interface StorageFullCopy {
  title: string;
  body: string;
  action: string;
  hint: string;
}

// COPY.md §2 (`full.polya.importFailed.*`).
export function storageFullCopy(usage: StorageUsage | null): StorageFullCopy {
  const tail =
    "Free up space or get more storage in Lectra, then try again. Nothing you've already imported is affected.";
  const body = usage
    ? `Your Lectra storage is full (${formatStorageBytes(usage.usedBytes)} of ${formatStorageBytes(usage.quotaBytes)}). ${tail}`
    : // full.polya.importFailed.body.noNumbers (COPY.md §15.5)
      `Your Lectra storage is full. ${tail}`;
  return {
    title: "Couldn't import",
    body,
    action: "How to Get More Storage",
    // full.polya.importFailed.action.hint (COPY.md §15.5, reuses full.scope.sendFailed.action.hint)
    hint: "Open Lectra › Settings › Storage on your iPad.",
  };
}
