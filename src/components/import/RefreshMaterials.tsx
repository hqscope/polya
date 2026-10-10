"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import StorageFullNotice from "@/components/import/StorageFullNotice";
import { FunctionError, invokeFunction } from "@/lib/functions";
import type { StorageFull } from "@/lib/storage-full";
import { detectStorageFull } from "@/lib/storage-full-client";
import { AI_BUSY_POLYA_IMPORT_DETAIL } from "@/lib/ai-busy";
import { userMessage } from "@/lib/user-message";
import { announceImportStarted } from "@/lib/import-events";

interface Props {
  canvasCourseId: string;
  /** The Canvas connection this course came from, so a student with more than
   * one Canvas refreshes from the right one. Null for extension imports. */
  connectionId: string | null;
}

// `polya.refresh.found` / `polya.refresh.found.one`
function updatesFoundNote(count: number): string {
  return count === 1
    ? "Found 1 update in Canvas. It'll show up here when it's ready."
    : `Found ${count} updates in Canvas. They'll show up here as they're ready.`;
}

// "Check for updates": asks Canvas what changed (force re-enumeration) and
// hands the downloading to the background worker, the same way ConnectFlow
// starts an import. No client-side loop: leaving the page doesn't stop it, the
// imports indicator shows progress, and it refreshes this page when it's done.
export default function RefreshMaterials({ canvasCourseId, connectionId }: Props) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "checking" | "done">("idle");
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storageFull, setStorageFull] = useState<StorageFull | null>(null);

  const handleRefresh = useCallback(async () => {
    setState("checking");
    setError(null);
    setStorageFull(null);
    setSummary(null);
    try {
      const started = await invokeFunction<{
        course_id?: string;
        queued?: number;
        refreshed?: number;
      }>("polya-import", {
        action: "start",
        canvas_course_id: canvasCourseId,
        ...(connectionId ? { connection_id: connectionId } : {}),
        force: true,
      });

      const changed = (started.queued ?? 0) + (started.refreshed ?? 0);
      if (changed > 0) announceImportStarted();
      setSummary(changed === 0 ? "Everything is already up to date." : updatesFoundNote(changed)); // polya.refresh.upToDate
      setState("done");
      router.refresh();
    } catch (err) {
      const full = await detectStorageFull(err);
      if (full) {
        setStorageFull(full);
      } else if (err instanceof FunctionError && err.code === "no_connection") {
        setError("Connect your Canvas first to check for updates.");
      } else if (err instanceof FunctionError && err.code === "busy") {
        setError(AI_BUSY_POLYA_IMPORT_DETAIL);
      } else {
        console.error("[polya] check for updates failed:", err);
        setError(userMessage(err));
      }
      setState("idle");
    }
  }, [canvasCourseId, connectionId, router]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={handleRefresh}
          disabled={state === "checking"}
          className="shrink-0 self-start rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] font-semibold whitespace-nowrap text-ink hover:border-ink3 hover:bg-rail disabled:cursor-default disabled:opacity-60"
        >
          {state === "checking" ? "Checking Canvas…" : "Check for updates"}
        </button>
        {summary ? <span className="text-[12px] text-ink3">{summary}</span> : null}
      </div>
      {storageFull ? (
        <StorageFullNotice state={storageFull} />
      ) : error ? (
        <p className="m-0 rounded-lg bg-amber-soft px-3 py-2 text-[12px] text-amber">{error}</p>
      ) : null}
    </div>
  );
}
