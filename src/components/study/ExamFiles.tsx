"use client";

import { useState } from "react";

import { createBrowserSupabaseClient } from "@/lib/supabase/browser";
import { POLYA_ERROR_GENERIC } from "@/lib/user-message";
import { FILE_KIND_LABEL, type CourseFile, type ExamFileMark } from "@/lib/study";

interface Props {
  examId: string;
  files: CourseFile[];
  marks: ExamFileMark[];
  onChange: (marks: ExamFileMark[]) => void;
}

// Which course files are this exam's formula sheet and past exams. Practice
// questions follow the formula sheet's notation and the past exams' style.
export default function ExamFiles({ examId, files, marks, onChange }: Props) {
  const [adding, setAdding] = useState(false);
  const [fileId, setFileId] = useState("");
  const [kind, setKind] = useState<ExamFileMark["kind"]>("formula_sheet");
  const [error, setError] = useState<string | null>(null);
  const supabase = createBrowserSupabaseClient();
  const title = new Map(files.map((f) => [f.id, f.title]));
  const unmarked = files.filter((f) => f.status === "ready" && !marks.some((m) => m.source_id === f.id));

  async function remove(sourceId: string) {
    setError(null);
    const { error: e } = await supabase.from("polya_exam_sources").delete().eq("exam_id", examId).eq("source_id", sourceId);
    if (e) {
      setError(POLYA_ERROR_GENERIC);
      return;
    }
    onChange(marks.filter((m) => m.source_id !== sourceId));
  }

  async function add() {
    if (!fileId) return;
    setError(null);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setError(POLYA_ERROR_GENERIC);
      return;
    }
    const { error: e } = await supabase
      .from("polya_exam_sources")
      .insert({ exam_id: examId, source_id: fileId, user_id: user.id, kind });
    if (e) {
      setError(POLYA_ERROR_GENERIC);
      return;
    }
    onChange([...marks, { source_id: fileId, kind }]);
    setFileId("");
    setAdding(false);
  }

  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-baseline gap-2.5">
        <span className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink3">Formula sheet &amp; past exams</span>
      </div>
      <p className="m-0 text-[12.5px] leading-[1.6] text-ink2">
        Practice follows your formula sheet&apos;s notation and your past exams&apos; style.
      </p>
      {marks.length > 0 ? (
        <ul className="m-0 flex list-none flex-col rounded-[9px] border border-line-soft bg-rail p-0 px-3.5 py-0.5">
          {marks.map((mark) => (
            <li key={mark.source_id} className="flex items-center gap-3 border-b border-line-soft py-[9px] last:border-b-0">
              <span className="shrink-0 rounded border border-line bg-surface px-[5px] py-px text-[9.5px] font-semibold uppercase text-ink3">
                {FILE_KIND_LABEL[mark.kind]}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px]">{title.get(mark.source_id) ?? "A removed file"}</span>
              <button
                type="button"
                onClick={() => void remove(mark.source_id)}
                className="shrink-0 cursor-pointer text-[12px] text-ink3 hover:text-ink"
                aria-label={`Unmark ${title.get(mark.source_id) ?? "file"}`}
              >
                Unmark
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {adding ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <select
            value={fileId}
            onChange={(e) => setFileId(e.target.value)}
            aria-label="Course file"
            className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 py-[7px] text-[13px] outline-none focus:border-accent"
          >
            <option value="">Choose a file…</option>
            {unmarked.map((file) => (
              <option key={file.id} value={file.id}>
                {file.title}
              </option>
            ))}
          </select>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as ExamFileMark["kind"])}
            aria-label="What it is"
            className="rounded-lg border border-line bg-surface px-2.5 py-[7px] text-[13px] outline-none focus:border-accent"
          >
            <option value="formula_sheet">Formula sheet</option>
            <option value="past_exam">Past exam</option>
          </select>
          <button type="button" onClick={() => void add()} disabled={!fileId} className="button-secondary h-9 cursor-pointer text-[12.5px] disabled:opacity-50">
            Mark
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="cursor-pointer self-start text-[12.5px] font-semibold text-accent-ink hover:underline"
        >
          + Mark a file
        </button>
      )}
      {unmarked.length === 0 && adding ? (
        <span className="text-[12px] text-ink3">
          Every ready file is already marked. Add files on the Materials tab.
        </span>
      ) : null}
      {error ? (
        <p role="alert" className="m-0 rounded-lg bg-amber-soft px-3 py-2.5 text-[12.5px] text-amber">
          {error}
        </p>
      ) : null}
    </section>
  );
}
