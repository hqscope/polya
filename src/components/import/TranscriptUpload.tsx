"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { createBrowserSupabaseClient } from "@/lib/supabase/browser";
import { invokeFunction } from "@/lib/functions";

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
  const [note, setNote] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    setNote(null);
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const kind = KIND_BY_EXT[ext];
    if (!kind) {
      setError("Please upload a .txt, .json, .vtt, or .srt transcript.");
      return;
    }

    setBusy(true);
    try {
      const supabase = createBrowserSupabaseClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Please sign in again.");

      const storagePath = `${user.id}/uploads/${crypto.randomUUID()}.${ext}`;
      const { error: uploadError } = await supabase.storage
        .from("polya_documents")
        .upload(storagePath, file, { contentType: file.type || "text/plain" });
      if (uploadError) throw new Error(uploadError.message);

      const registered = await invokeFunction<{ source_id: string }>("polya-import", {
        action: "add_upload",
        course_id: courseId,
        storage_path: storagePath,
        title: file.name.replace(/\.[^.]+$/, ""),
        kind,
      });

      // Pump the single new source to ready.
      let done = false;
      let guard = 20;
      while (!done && guard-- > 0) {
        const result = await invokeFunction<{ done: boolean }>("polya-import", {
          action: "process",
          course_id: courseId,
        });
        done = result.done;
      }
      setNote(`Added "${file.name}". It's ready to study.`);
      void registered;
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
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

      <div className="flex items-center gap-3">
        <label className="button-secondary h-8 cursor-pointer self-start rounded-[7px] px-[13px] text-[12.5px]">
          {busy ? "Adding…" : "Choose transcript file"}
          <input
            type="file"
            accept=".txt,.json,.vtt,.srt"
            disabled={busy}
            className="hidden"
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

      {error ? (
        <p className="m-0 rounded-lg bg-amber-soft px-3 py-2.5 text-[12.5px] text-amber">
          {error}
        </p>
      ) : null}
    </section>
  );
}
