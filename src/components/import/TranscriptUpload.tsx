"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import StorageFullNotice from "@/components/import/StorageFullNotice";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";
import { FunctionError, invokeFunction } from "@/lib/functions";
import type { StorageFull } from "@/lib/storage-full";
import { detectStorageFull } from "@/lib/storage-full-client";
import { AI_BUSY_POLYA_IMPORT_DETAIL } from "@/lib/ai-busy";
import { POLYA_ERROR_SIGNED_OUT, userMessage } from "@/lib/user-message";
import { announceImportStarted } from "@/lib/import-events";

// `polya.transcript.processing`
function processingNote(title: string): string {
  return `Added “${title}”. It's being prepared and will appear in Materials shortly.`;
}

function readyNote(title: string): string {
  return `Added “${title}”. It's ready to study.`;
}

interface Props {
  courseId: string;
}

const KIND_BY_EXT: Record<string, string> = {
  txt: "transcript_txt",
  json: "transcript_json",
  vtt: "transcript_vtt",
  srt: "transcript_srt",
};

// Upload a lecture transcript (Kaltura .json/.txt/.vtt/.srt) straight to storage
// under the user's prefix, then register + process it through the import pump.
export default function TranscriptUpload({ courseId }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storageFull, setStorageFull] = useState<StorageFull | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    setStorageFull(null);
    setNote(null);
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const kind = KIND_BY_EXT[ext];
    if (!kind) {
      setError("Please upload a .txt, .json, .vtt, or .srt transcript.");
      return;
    }

    setBusy(true);
    // Any refusal of the direct upload might be full storage; later steps
    // only when the failure looks like it.
    let uploading = false;
    try {
      const supabase = createBrowserSupabaseClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new FunctionError(POLYA_ERROR_SIGNED_OUT, "signed_out", 401);

      const storagePath = `${user.id}/uploads/${crypto.randomUUID()}.${ext}`;
      uploading = true;
      const { error: uploadError } = await supabase.storage
        .from("polya_documents")
        .upload(storagePath, file, { contentType: file.type || "text/plain" });
      // Thrown as-is (not re-wrapped) so the storage-full check can read it.
      if (uploadError) throw uploadError;
      uploading = false;

      const title = file.name.replace(/\.[^.]+$/, "");
      await invokeFunction<{ source_id: string }>("polya-import", {
        action: "add_upload",
        course_id: courseId,
        storage_path: storagePath,
        title,
        kind,
      });

      // Registered: the background worker will finish it regardless. Pump a
      // few steps here so it's usually ready right away, and only say
      // "ready" when it is.
      let done = false;
      try {
        let guard = 20;
        while (!done && guard-- > 0) {
          const result = await invokeFunction<{ done: boolean }>("polya-import", {
            action: "process",
            course_id: courseId,
          });
          done = result.done;
        }
      } catch (pumpError) {
        console.warn("[polya] transcript processing continues in the background:", pumpError);
      }
      if (!done) announceImportStarted();
      setNote(done ? readyNote(title) : processingNote(title));
      router.refresh();
    } catch (err) {
      const full = await detectStorageFull(err, { always: uploading });
      if (full) {
        setStorageFull(full);
      } else if (err instanceof FunctionError && err.code === "busy") {
        setError(AI_BUSY_POLYA_IMPORT_DETAIL);
      } else {
        console.error("[polya] transcript upload failed:", err);
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
          Add a lecture
        </span>
        <h2 className="text-[15.5px] tracking-[-0.015em]">
          Upload a transcript
        </h2>
      </div>
      <p className="m-0 text-[13px] leading-[1.65] text-ink2">
        Have a lecture recording? Add its transcript (.txt, .json, .vtt, .srt)
        so Polya can answer from what was said in class — with the exact moment
        it was said.
      </p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {/* The input stays in the tab order (visually hidden, not display:none),
            so the picker opens from the keyboard too. */}
        <label className="button-secondary h-8 shrink-0 cursor-pointer self-start rounded-[7px] px-[13px] text-[12.5px] focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent">
          {busy ? "Adding…" : "Choose transcript file"}
          <input
            type="file"
            accept=".txt,.json,.vtt,.srt"
            disabled={busy}
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFile(file);
              event.target.value = "";
            }}
          />
        </label>
        {note ? (
          <span className="text-[12px] text-accent-ink">{note}</span>
        ) : null}
      </div>

      {storageFull ? (
        <StorageFullNotice state={storageFull} />
      ) : error ? (
        <p className="m-0 rounded-lg bg-amber-soft px-3 py-2.5 text-[12.5px] text-amber">
          {error}
        </p>
      ) : null}
    </section>
  );
}
