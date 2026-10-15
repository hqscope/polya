"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import StorageFullNotice from "@/components/import/StorageFullNotice";
import { FunctionError, invokeFunction } from "@/lib/functions";
import type { StorageFull } from "@/lib/storage-full";
import { detectStorageFull } from "@/lib/storage-full-client";
import { AI_BUSY_POLYA_IMPORT_DETAIL } from "@/lib/ai-busy";
import { userMessage } from "@/lib/user-message";
import { announceImportStarted } from "@/lib/import-events";

interface Props {
  /** Add the website to this course. Omitted: the website becomes its own course. */
  courseId?: string;
  /** The website already added to this course, if any. */
  siteUrl?: string | null;
}

interface SiteStartResult {
  course_id: string;
  queued?: number;
  refreshed?: number;
}

// `polya.site.found` / `polya.site.found.one` / `polya.site.rechecking` / `polya.site.upToDate`
function resultNote(added: number, rechecking: number): string {
  if (added === 1) return "Found 1 new item on your course website. It'll show up here when it's ready.";
  if (added > 1) return `Found ${added} new items on your course website. They'll show up here as they're ready.`;
  if (rechecking > 0) return "Checking your course website for changes. Anything updated will show up here.";
  return "Everything is already up to date.";
}

/** "ds100.org/fa26" for display. */
function shortSite(url: string): string {
  return url.replace(/^https:\/\//, "").replace(/\/$/, "");
}

// Bring in a course whose materials live on its own website (pages, slides,
// worksheets, notes) rather than in Canvas. The crawl runs server-side and the
// background worker reads each item, so leaving the page doesn't stop it.
export default function CourseSiteImport({ courseId, siteUrl = null }: Props) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storageFull, setStorageFull] = useState<StorageFull | null>(null);

  async function run(address: string, force: boolean) {
    setBusy(true);
    setNote(null);
    setError(null);
    setStorageFull(null);
    try {
      const result = await invokeFunction<SiteStartResult>("polya-import", {
        action: "site_start",
        url: address,
        ...(courseId ? { course_id: courseId } : {}),
        ...(force ? { force: true } : {}),
      });
      const added = result.queued ?? 0;
      const rechecking = result.refreshed ?? 0;
      if (added + rechecking > 0) announceImportStarted();
      if (!courseId) {
        router.push(`/app/courses/${result.course_id}/materials`);
        return;
      }
      setNote(resultNote(added, rechecking));
      setUrl("");
      router.refresh();
    } catch (err) {
      const full = await detectStorageFull(err);
      if (full) {
        setStorageFull(full);
      } else if (err instanceof FunctionError && err.code === "busy") {
        setError(AI_BUSY_POLYA_IMPORT_DETAIL);
      } else {
        console.error("[polya] course website import failed:", err);
        setError(userMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink3">
          Course website
        </span>
        <h2 className="text-[15.5px] tracking-[-0.015em]">
          {siteUrl ? "Studying your course website" : courseId ? "Add your course website" : "Course not on Canvas?"}
        </h2>
      </div>

      {siteUrl ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <a
            href={siteUrl}
            target="_blank"
            rel="noreferrer"
            className="truncate text-[13px] text-ink2 underline-offset-2 hover:text-ink hover:underline"
          >
            {shortSite(siteUrl)} ↗
          </a>
          <button
            type="button"
            onClick={() => void run(siteUrl, true)}
            disabled={busy}
            className="shrink-0 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] font-semibold whitespace-nowrap text-ink hover:border-ink3 hover:bg-rail disabled:cursor-default disabled:opacity-60"
          >
            {busy ? "Checking the website…" : "Check for updates"}
          </button>
        </div>
      ) : (
        <>
          <p className="m-0 text-[13px] leading-[1.65] text-ink2">
            If your class keeps its schedule, slides, and worksheets on its own
            website, paste the address. Polya studies the pages and the files
            they link to, so its help matches what your class covers.
          </p>
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (url.trim()) void run(url.trim(), false);
            }}
          >
            <label htmlFor={`course-site-${courseId ?? "new"}`} className="sr-only">
              Course website address
            </label>
            <input
              id={`course-site-${courseId ?? "new"}`}
              type="text"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              placeholder="ds100.org/fa26"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              disabled={busy}
              className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-[9px] text-[13px] shadow-card outline-none placeholder:text-ink3 focus:border-accent"
            />
            <button
              type="submit"
              disabled={busy || !url.trim()}
              className="button-secondary h-[38px] shrink-0 rounded-lg px-[14px] text-[12.5px] disabled:opacity-60"
            >
              {busy ? "Reading the website…" : "Add website"}
            </button>
          </form>
        </>
      )}

      {note ? <span className="text-[12px] text-accent-ink">{note}</span> : null}
      {storageFull ? (
        <StorageFullNotice state={storageFull} />
      ) : error ? (
        <p className="m-0 rounded-lg bg-amber-soft px-3 py-2.5 text-[12.5px] text-amber">{error}</p>
      ) : null}
    </section>
  );
}
