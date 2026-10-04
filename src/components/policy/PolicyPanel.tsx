"use client";

import { useState } from "react";

import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

// `polya.policy.saveFailed`
const SAVE_FAILED = "Couldn't save. Try again.";

type Mode = "open" | "guided" | "practice" | "review";

const MODES: Array<{ mode: Mode; label: string; blurb: string }> = [
  { mode: "open", label: "Open", blurb: "Full answers when you ask — best for reading up." },
  {
    mode: "guided",
    label: "Guided",
    blurb: "Hints and steps first; the full solution waits until you've had a go.",
  },
  {
    mode: "practice",
    label: "Practice",
    blurb: "Quiz stance — you commit to an answer before Polya reveals anything.",
  },
  {
    mode: "review",
    label: "Review",
    blurb: "After a deadline — full worked solutions plus a suggested next practice.",
  },
];

interface Props {
  courseId: string;
  initialMode: Mode;
  initialNote: string | null;
}

// The student's own per-course study mode. Writes polya_course_policies under
// the student's RLS (own rows). Instructor-enforced policies are a later,
// separate layer — this panel makes no such claim.
export default function PolicyPanel({ courseId, initialMode, initialNote }: Props) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [note, setNote] = useState(initialNote ?? "");
  const [savedMode, setSavedMode] = useState<Mode>(initialMode);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  // A failed save puts the mode back to the last one that stuck (the note keeps
  // what was typed, so it isn't lost) and says so.
  async function save(nextMode: Mode, nextNote: string) {
    const previousMode = savedMode;
    setSaving(true);
    setSaveFailed(false);
    let saved = false;
    try {
      const supabase = createBrowserSupabaseClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        const { error } = await supabase.from("polya_course_policies").upsert(
          {
            course_id: courseId,
            user_id: user.id,
            mode: nextMode,
            instructor_note: nextNote.trim() || null,
          },
          { onConflict: "course_id" },
        );
        if (error) console.error("[polya] study mode save failed:", error);
        saved = !error;
      }
    } catch (err) {
      console.error("[polya] study mode save failed:", err);
    }
    if (saved) {
      setSavedMode(nextMode);
    } else {
      setMode(previousMode);
      setSaveFailed(true);
    }
    setSaving(false);
  }

  return (
    <section className="flex flex-col gap-3.5">
      <div className="flex items-start gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink3">
            Study mode
          </span>
          <h2 className="text-[15.5px] tracking-[-0.015em]">
            How much help do you want?
          </h2>
        </div>
        {saving ? (
          <span className="ml-auto text-[11.5px] font-semibold text-ink3">
            Saving…
          </span>
        ) : saveFailed ? (
          <span role="status" className="ml-auto text-[11.5px] font-semibold text-amber">
            {SAVE_FAILED}
          </span>
        ) : savedMode === mode ? (
          <span className="ml-auto text-[11.5px] font-semibold text-accent-ink">
            ✓ Saved
          </span>
        ) : null}
      </div>
      <p className="m-0 text-[13px] leading-[1.65] text-ink2">
        Choose how much Polya helps you in this course. It takes effect
        immediately, and you can change it any time.
      </p>

      <div className="grid gap-2 sm:grid-cols-2">
        {MODES.map((option) => {
          const selected = mode === option.mode;
          return (
            <button
              key={option.mode}
              type="button"
              onClick={() => {
                setMode(option.mode);
                void save(option.mode, note);
              }}
              className={`flex cursor-pointer flex-col gap-1 rounded-[9px] border px-[13px] py-3 text-left ${
                selected
                  ? "border-accent bg-accent-soft"
                  : "border-line bg-surface hover:border-ink3"
              }`}
            >
              <span className="flex items-center gap-[7px]">
                <span
                  className={`h-[11px] w-[11px] rounded-full ${
                    selected
                      ? "border-[3.5px] border-accent"
                      : "border-[1.5px] border-line"
                  }`}
                />
                <span className="text-[13px] font-[650]">{option.label}</span>
              </span>
              <span className="text-[11.5px] leading-[1.55] text-ink2">
                {option.blurb}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="policy-tutor-note" className="text-[12.5px] font-semibold">
          Note to the tutor (optional)
        </label>
        <textarea
          id="policy-tutor-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          onBlur={() => void save(mode, note)}
          rows={2}
          placeholder="e.g. On this unit, use the substitution method from Lecture 8."
          className="w-full resize-none rounded-lg border border-line bg-surface px-3 py-[9px] text-[12.5px] leading-relaxed shadow-card outline-none placeholder:text-ink3 focus:border-accent"
        />
      </div>
    </section>
  );
}
