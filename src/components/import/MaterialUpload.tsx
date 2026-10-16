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
import { MAX_UPLOAD_BYTES } from "../../../supabase/functions/_shared/upload-checks.ts";

interface Props {
  courseId: string;
}

const KIND_BY_EXT: Record<string, string> = {
  pdf: "pdf",
  txt: "transcript_txt",
  json: "transcript_json",
  vtt: "transcript_vtt",
  srt: "transcript_srt",
};

const ACCEPT = ".pdf,.txt,.json,.vtt,.srt";

function addedNote(titles: string[], ready: boolean): string {
  const what = titles.length === 1 ? `“${titles[0]}”` : `${titles.length} files`;
  return ready
    ? `Added ${what}. It's ready to study.`
    : `Added ${what}. ${titles.length === 1 ? "It's" : "They're"} being prepared and will appear below shortly.`;
}

// Upload the student's own files (PDFs, lecture transcripts) straight to
// storage under their prefix, then register each through the import pump.
export default function MaterialUpload({ courseId }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [storageFull, setStorageFull] = useState<StorageFull | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function handleFiles(files: File[]) {
    setErrors([]);
    setStorageFull(null);
    setNote(null);
    if (files.length === 0) return;

    const failed: string[] = [];
    const accepted: { file: File; ext: string; kind: string }[] = [];
    for (const file of files) {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      const kind = KIND_BY_EXT[ext];
      if (!kind) failed.push(`“${file.name}” isn't a PDF or a transcript.`);
      else if (file.size > MAX_UPLOAD_BYTES) {
        failed.push(`“${file.name}” is over 30 MB. Try uploading just the chapters or pages you need.`);
      } else accepted.push({ file, ext, kind });
    }

    const added: { title: string; kind: string }[] = [];
    try {
      const supabase = createBrowserSupabaseClient();
      let userId = "";
      if (accepted.length > 0) {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) throw new FunctionError(POLYA_ERROR_SIGNED_OUT, "signed_out", 401);
        userId = user.id;
      }

      for (const [i, { file, ext, kind }] of accepted.entries()) {
        setBusy(accepted.length > 1 ? `Adding ${i + 1} of ${accepted.length}…` : "Adding…");
        // Any refusal of the direct upload might be full storage; the
        // registration step only when the failure looks like it.
        let uploading = true;
        try {
          const storagePath = `${userId}/uploads/${crypto.randomUUID()}.${ext}`;
          const { error: uploadError } = await supabase.storage
            .from("polya_documents")
            // An empty file.type would store a PDF as text and break the viewer.
            .upload(storagePath, file, {
              contentType: kind === "pdf" ? "application/pdf" : file.type || "text/plain",
            });
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
          added.push({ title, kind });
        } catch (err) {
          // Full storage or a busy service would stop every later file too.
          const full = await detectStorageFull(err, { always: uploading });
          if (full) {
            setStorageFull(full);
            break;
          }
          if (err instanceof FunctionError && err.code === "busy") {
            failed.push(AI_BUSY_POLYA_IMPORT_DETAIL);
            break;
          }
          console.error("[polya] upload failed:", err);
          failed.push(`Couldn't add “${file.name}”. ${userMessage(err)}`);
        }
      }

      if (added.length > 0) {
        // A lone transcript is quick: pump a few steps here so it's usually
        // ready right away, and only say "ready" when it is. PDFs take longer
        // and finish in the background.
        let done = false;
        if (added.length === 1 && added[0]!.kind !== "pdf") {
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
            console.warn("[polya] processing continues in the background:", pumpError);
          }
        }
        if (!done) announceImportStarted();
        setNote(addedNote(added.map((a) => a.title), done));
        router.refresh();
      }
    } catch (err) {
      console.error("[polya] upload failed:", err);
      failed.push(userMessage(err));
    } finally {
      setErrors(failed);
      setBusy(null);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink3">
          Add your own files
        </span>
        <h2 className="text-[15.5px] tracking-[-0.015em]">Upload PDFs or transcripts</h2>
      </div>
      <p className="m-0 text-[13px] leading-[1.65] text-ink2">
        Add what isn&apos;t in Canvas: textbook chapters, notes, practice exams,
        formula sheets (PDFs up to 30 MB). Lecture transcripts (.txt, .json,
        .vtt, .srt) work too, so Polya can point to the exact moment something
        was said.
      </p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {/* The input stays in the tab order (visually hidden, not display:none),
            so the picker opens from the keyboard too. */}
        <label className="button-secondary h-8 shrink-0 cursor-pointer self-start rounded-[7px] px-[13px] text-[12.5px] focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent">
          {busy ?? "Choose files"}
          <input
            type="file"
            accept={ACCEPT}
            multiple
            disabled={busy !== null}
            className="sr-only"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              void handleFiles(files);
            }}
          />
        </label>
        {note ? <span className="text-[12px] text-accent-ink">{note}</span> : null}
      </div>

      {storageFull ? <StorageFullNotice state={storageFull} /> : null}
      {errors.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-lg bg-amber-soft px-3 py-2.5 text-[12.5px] text-amber">
          {errors.map((message, i) => (
            <p key={i} className="m-0">
              {message}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}
