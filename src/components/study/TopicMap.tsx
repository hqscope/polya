"use client";

import { useState, type ReactNode } from "react";

import { MathSpan } from "@/components/MathText";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";
import { POLYA_ERROR_GENERIC } from "@/lib/user-message";
import { TOPIC_STATUS_CLASS, TOPIC_STATUS_LABEL, type TopicRow } from "@/lib/study";
import type { TopicProgress } from "../../../supabase/functions/_shared/study-progress.ts";

const SELECT = "id, position, title, summary, key_formulas, source_ids, origin, stage";

interface Props {
  examId: string;
  topics: TopicRow[];
  progress: Map<string, TopicProgress>;
  onChange: (topics: TopicRow[]) => void;
  onPractice: (topicId: string) => void;
  /** Replaces the status badge (the exam coach shows each topic's stage). */
  badge?: (topic: TopicRow) => ReactNode;
}

// The exam's topics in study order, each with how it's going and a way to
// practice just that topic. "Edit" lets the student rename, drop, reorder and
// add topics — the map is theirs, not Polya's.
export default function TopicMap({ examId, topics, progress, onChange, onPractice, badge }: Props) {
  const [editing, setEditing] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const supabase = createBrowserSupabaseClient();

  async function run(work: () => Promise<void>) {
    setError(null);
    try {
      await work();
    } catch (err) {
      console.error("[polya] topic edit failed:", err);
      setError(POLYA_ERROR_GENERIC);
    }
  }

  const rename = (topic: TopicRow, title: string) =>
    run(async () => {
      const clean = title.trim().slice(0, 160);
      if (!clean || clean === topic.title) return;
      const { error: e } = await supabase.from("polya_study_topics").update({ title: clean }).eq("id", topic.id);
      if (e) throw e;
      onChange(topics.map((t) => (t.id === topic.id ? { ...t, title: clean } : t)));
    });

  const remove = (topic: TopicRow) =>
    run(async () => {
      const { error: e } = await supabase.from("polya_study_topics").delete().eq("id", topic.id);
      if (e) throw e;
      onChange(topics.filter((t) => t.id !== topic.id));
    });

  const move = (index: number, delta: -1 | 1) =>
    run(async () => {
      const other = index + delta;
      if (other < 0 || other >= topics.length) return;
      const a = topics[index]!;
      const b = topics[other]!;
      const [r1, r2] = await Promise.all([
        supabase.from("polya_study_topics").update({ position: b.position }).eq("id", a.id),
        supabase.from("polya_study_topics").update({ position: a.position }).eq("id", b.id),
      ]);
      if (r1.error || r2.error) throw r1.error ?? r2.error;
      const next = [...topics];
      next[index] = { ...b, position: a.position };
      next[other] = { ...a, position: b.position };
      onChange(next);
    });

  const add = () =>
    run(async () => {
      const title = newTitle.trim().slice(0, 160);
      if (!title) return;
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("signed out");
      const position = Math.min(999, topics.reduce((max, t) => Math.max(max, t.position), -1) + 1);
      const { data, error: e } = await supabase
        .from("polya_study_topics")
        .insert({ user_id: user.id, exam_id: examId, title, position, origin: "student" })
        .select(SELECT)
        .single();
      if (e || !data) throw e;
      onChange([...topics, data as TopicRow]);
      setNewTitle("");
    });

  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2.5">
        <span className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink3">Topics</span>
        {topics.length > 0 ? (
            <button
              type="button"
              onClick={() => setEditing((on) => !on)}
              className="ml-auto cursor-pointer text-[12px] text-ink3 underline hover:text-ink"
            >
              {editing ? "Done" : "Edit"}
            </button>
        ) : null}
      </div>

      {topics.length > 0 ? (
      <ol className="m-0 flex list-none flex-col rounded-[9px] border border-line-soft bg-rail p-0">
        {topics.map((topic, index) => {
          const state = progress.get(topic.id);
          const status = state?.status ?? "not_started";
          return (
            <li key={topic.id} className="flex flex-col gap-1.5 border-b border-line-soft px-3.5 py-3 last:border-b-0">
              <div className="flex items-center gap-2.5">
                {editing ? (
                  <input
                    defaultValue={topic.title}
                    onBlur={(e) => void rename(topic, e.target.value)}
                    maxLength={160}
                    aria-label="Topic name"
                    className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-[13px] outline-none focus:border-accent"
                  />
                ) : (
                  <span className="min-w-0 flex-1 text-[13.5px] font-semibold">{topic.title}</span>
                )}
                {editing ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void move(index, -1)}
                      disabled={index === 0}
                      aria-label="Move up"
                      className="h-7 w-7 cursor-pointer rounded-md text-ink3 hover:text-ink disabled:opacity-30"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => void move(index, 1)}
                      disabled={index === topics.length - 1}
                      aria-label="Move down"
                      className="h-7 w-7 cursor-pointer rounded-md text-ink3 hover:text-ink disabled:opacity-30"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(topic)}
                      className="h-7 cursor-pointer rounded-md px-2 text-[12px] text-danger hover:underline"
                    >
                      Remove
                    </button>
                  </span>
                ) : (
                  <>
                    {badge ? (
                      badge(topic)
                    ) : (
                      <span
                        className={`shrink-0 rounded px-2 py-[3px] text-[10px] font-[650] uppercase tracking-[0.07em] ${TOPIC_STATUS_CLASS[status]}`}
                      >
                        {TOPIC_STATUS_LABEL[status]}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => onPractice(topic.id)}
                      className="button-secondary h-7 shrink-0 cursor-pointer rounded-md px-[11px] text-[12px]"
                    >
                      Practice
                    </button>
                  </>
                )}
              </div>
              {!editing && topic.summary ? <p className="m-0 text-[12.5px] leading-[1.6] text-ink2">{topic.summary}</p> : null}
              {!editing && topic.key_formulas.length > 0 ? (
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-ink2">
                  {topic.key_formulas.map((tex, i) => (
                    <MathSpan key={i} tex={tex} />
                  ))}
                </div>
              ) : null}
              {!editing && state && state.attempts > 0 ? (
                <span className="text-[11px] text-ink3">
                  {state.attempts} answered · {Math.round((state.accuracy ?? 0) * 100)}% recently
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      ) : null}

      <form
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
          className="flex gap-2"
        >
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            maxLength={160}
            placeholder="Add a topic, like “Poisson approximation”"
            className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-[7px] text-[13px] outline-none placeholder:text-ink3 focus:border-accent"
          />
          <button type="submit" className="button-secondary h-9 shrink-0 cursor-pointer text-[12.5px]">
            Add
          </button>
        </form>

      {error ? (
        <p role="alert" className="m-0 rounded-lg bg-amber-soft px-3 py-2.5 text-[12.5px] text-amber">
          {error}
        </p>
      ) : null}
    </section>
  );
}
