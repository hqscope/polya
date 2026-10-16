"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { createBrowserSupabaseClient } from "@/lib/supabase/browser";
import { POLYA_ERROR_GENERIC } from "@/lib/user-message";
import type { CourseFile, ExamRow } from "@/lib/study";
import { suggestExamFileKind } from "../../../supabase/functions/_shared/study-files.ts";

const FIELD =
  "w-full rounded-lg border border-line bg-surface px-3 py-[9px] text-[13px] leading-relaxed shadow-card outline-none placeholder:text-ink3 focus:border-accent";

interface Props {
  courseId: string;
  /** Files in the course; on a new exam, likely formula sheets and past exams get marked. */
  files: CourseFile[];
  /** Editing an existing exam instead of adding one. */
  exam?: ExamRow;
  onSaved?: (exam: ExamRow) => void;
  onCancel?: () => void;
}

// Add an exam to prepare for, or edit one: what it's called, when it is, what
// the instructor said it covers, and example questions in the course's style.
export default function ExamForm({ courseId, files, exam, onSaved, onCancel }: Props) {
  const router = useRouter();
  const [title, setTitle] = useState(exam?.title ?? "");
  const [examDate, setExamDate] = useState(exam?.exam_date ?? "");
  const [scopeNote, setScopeNote] = useState(exam?.scope_note ?? "");
  const [examplesNote, setExamplesNote] = useState(exam?.examples_note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) {
      setError("Give the exam a name, like “Final” or “Quiz 3”.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("signed out");
      const fields = {
        title: title.trim().slice(0, 120),
        exam_date: examDate || null,
        scope_note: scopeNote.trim() ? scopeNote.trim().slice(0, 20_000) : null,
        examples_note: examplesNote.trim() ? examplesNote.trim().slice(0, 40_000) : null,
      };

      if (exam) {
        const { data, error: updateError } = await supabase
          .from("polya_exams")
          .update(fields)
          .eq("id", exam.id)
          .select("id, course_id, title, exam_date, scope_note, examples_note")
          .single();
        if (updateError || !data) throw updateError ?? new Error("update failed");
        onSaved?.(data as ExamRow);
        return;
      }

      const { data, error: insertError } = await supabase
        .from("polya_exams")
        .insert({ ...fields, user_id: user.id, course_id: courseId })
        .select("id")
        .single();
      if (insertError || !data) throw insertError ?? new Error("insert failed");

      // A head start the student can change on the exam page.
      const marks = files
        .filter((file) => file.status === "ready")
        .flatMap((file) => {
          const kind = suggestExamFileKind(file.title);
          return kind ? [{ exam_id: data.id, source_id: file.id, user_id: user.id, kind }] : [];
        });
      if (marks.length > 0) {
        const { error: markError } = await supabase.from("polya_exam_sources").insert(marks);
        if (markError) console.warn("[polya] couldn't pre-mark exam files:", markError.message);
      }
      router.push(`/app/courses/${courseId}/study/${data.id}`);
    } catch (err) {
      console.error("[polya] saving exam failed:", err);
      setError(POLYA_ERROR_GENERIC);
      setSaving(false);
      return;
    }
    setSaving(false);
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3.5">
      <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
        <label className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-semibold">Exam</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            placeholder="Final, Quiz 3, Midterm 2…"
            className={FIELD}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-semibold">Date</span>
          <input type="date" value={examDate} onChange={(e) => setExamDate(e.target.value)} className={FIELD} />
        </label>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-semibold">What it covers</span>
        <span className="text-[12px] text-ink2">
          Paste your instructor&apos;s announcement or list the chapters. Optional, but it keeps practice on what
          matters.
        </span>
        <textarea
          value={scopeNote}
          onChange={(e) => setScopeNote(e.target.value)}
          rows={4}
          maxLength={20_000}
          placeholder="The final covers chapters 1–6: expectation, variance, indicators, Poisson…"
          className={`${FIELD} resize-y`}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-semibold">Example questions</span>
        <span className="text-[12px] text-ink2">
          Paste a few past quiz or homework questions so practice matches how your instructor asks. Optional.
        </span>
        <textarea
          value={examplesNote}
          onChange={(e) => setExamplesNote(e.target.value)}
          rows={4}
          maxLength={40_000}
          className={`${FIELD} resize-y`}
        />
      </label>

      {error ? (
        <p role="alert" className="m-0 rounded-lg bg-amber-soft px-3 py-2.5 text-[12.5px] text-amber">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2.5">
        <button type="submit" disabled={saving} className="button-primary h-9 cursor-pointer disabled:opacity-60">
          {saving ? "Saving…" : exam ? "Save changes" : "Add exam"}
        </button>
        {onCancel ? (
          <button type="button" onClick={onCancel} className="button-secondary h-9 cursor-pointer">
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
