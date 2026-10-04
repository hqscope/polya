import { createBrowserSupabaseClient } from "@/lib/supabase/browser";
import {
  isPossibleStorageFullError,
  parseStorageUsage,
  storageFullFromCheck,
  type StorageFull,
  type StorageUsage,
} from "@/lib/storage-full";

// After an import or upload fails: is the student's Lectra storage full?
// Asks `get_my_storage_usage()` only when the failure could be that (or always,
// for a direct storage upload, where any refusal might be). Never throws.
export async function detectStorageFull(
  err: unknown,
  options: { always?: boolean } = {},
): Promise<StorageFull | null> {
  if (!options.always && !isPossibleStorageFullError(err)) return null;

  let usage: StorageUsage | null = null;
  try {
    const supabase = createBrowserSupabaseClient();
    const { data, error } = await supabase.rpc("get_my_storage_usage");
    if (!error) usage = parseStorageUsage(data);
  } catch {
    usage = null;
  }
  return storageFullFromCheck(err, usage);
}
