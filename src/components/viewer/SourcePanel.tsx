"use client";

import { useEffect, useState } from "react";

import { createBrowserSupabaseClient } from "@/lib/supabase/browser";
import { sourceLocation } from "@/lib/citations";
import type { TutorSource } from "@/lib/sse";

interface Props {
  source: TutorSource;
  onBack: () => void;
  /** The back button's text: the rail goes back to its list, the phone sheet closes. */
  backLabel?: string;
}

interface SourceMeta {
  source_kind: string;
  storage_path: string | null;
  canvas_url: string | null;
  title: string;
}

// Opens a cited source at its exact location: PDFs render at the cited page via
// the browser's native viewer (#page=N); pages/transcripts show the stored text
// scrolled to the cited passage.
export default function SourcePanel({ source, onBack, backLabel = "← All sources" }: Props) {
  const [meta, setMeta] = useState<SourceMeta | null>(null);
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [bodyText, setBodyText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError(null);
      setSignedUrl(null);
      setBodyText(null);
      const supabase = createBrowserSupabaseClient();

      const { data: row } = await supabase
        .from("polya_sources")
        .select("source_kind, storage_path, canvas_url, title")
        .eq("id", source.source_id)
        .maybeSingle();
      if (cancelled) return;
      if (!row) {
        setError("Couldn't open that source.");
        return;
      }
      setMeta(row as SourceMeta);

      if (row.source_kind === "pdf" && row.storage_path) {
        const { data: signed } = await supabase.storage
          .from("polya_documents")
          .createSignedUrl(row.storage_path, 300);
        if (cancelled) return;
        if (signed?.signedUrl) {
          const page = source.page_start ?? 1;
          setSignedUrl(`${signed.signedUrl}#page=${page}&view=FitH`);
        } else {
          setError("Couldn't load the document.");
        }
      } else {
        // page / assignment / syllabus / transcript — show the stored unit text.
        const { data: unit } = await supabase
          .from("polya_content_units")
          .select("content")
          .eq("id", source.unit_id)
          .maybeSingle();
        if (cancelled) return;
        setBodyText((unit?.content as string) ?? source.snippet);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center border-b border-line-soft px-3.5">
        <button
          type="button"
          onClick={onBack}
          className="cursor-pointer py-2.5 pr-3 text-[12px] font-medium text-ink3 hover:text-ink"
        >
          {backLabel}
        </button>
      </div>

      <div className="flex shrink-0 flex-col gap-1.5 border-b border-line-soft px-3.5 py-3">
        <div className="flex min-w-0 items-center gap-[7px]">
          <span className="inline-flex h-[15px] min-w-[15px] shrink-0 items-center justify-center rounded bg-accent px-1 text-[10px] font-bold text-on-accent">
            {source.n}
          </span>
          <span className="truncate text-[13px] font-semibold">
            {source.title}
          </span>
        </div>
        <span className="font-mono text-[10.5px] text-ink3">
          {sourceLocation(source)}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col p-3">
        {error ? (
          <p className="m-0 rounded-lg bg-amber-soft px-3 py-2.5 text-[12.5px] text-amber">
            {error}
          </p>
        ) : null}

        {signedUrl ? (
          <iframe
            title={source.title}
            src={signedUrl}
            className="min-h-0 w-full flex-1 rounded-lg border border-line bg-surface"
          />
        ) : null}

        {bodyText ? (
          <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-line bg-surface p-4 shadow-card">
            <p className="m-0 text-[12.5px] leading-[1.7] whitespace-pre-wrap text-ink2">
              {bodyText}
            </p>
          </div>
        ) : null}

        {!signedUrl && !bodyText && !error ? (
          <p className="m-0 px-1 text-[12.5px] text-ink3">Opening…</p>
        ) : null}
      </div>

      {/* Phone browsers don't show a PDF inside the page (or show only its
          first page), so the PDF can always open on its own too. */}
      {signedUrl || meta?.canvas_url ? (
        <div className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 border-t border-line-soft px-3.5 py-2.5">
          {signedUrl ? (
            <a
              href={signedUrl}
              target="_blank"
              rel="noreferrer"
              className="text-[12px] font-semibold"
            >
              Open the PDF ↗
            </a>
          ) : null}
          {meta?.canvas_url ? (
            <a
              href={meta.canvas_url}
              target="_blank"
              rel="noreferrer"
              className="text-[12px] font-semibold"
            >
              Open in Canvas ↗
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
