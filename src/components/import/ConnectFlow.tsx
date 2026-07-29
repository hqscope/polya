"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { invokeFunction } from "@/lib/functions";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";
import { track } from "@/lib/track";
import type { CanvasConnection, CanvasCourseOption, StartedCourse } from "@/lib/types";
import TokenForm from "@/components/import/TokenForm";
import CoursePicker from "@/components/import/CoursePicker";

type Stage = "checking" | "choose" | "extension" | "token" | "pick";

const EXTENSION_STORE_URL =
  "https://chromewebstore.google.com/detail/canvascope/bamoelobnoepklagbcokjnlipfhcfdbb";

const STEPS = [
  { n: 1, label: "Connect" },
  { n: 2, label: "Choose courses" },
  { n: 3, label: "Study" },
];

function StepIndicator({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-2.5">
      {STEPS.map((step, i) => {
        const done = step.n < current;
        const active = step.n === current;
        return (
          <div key={step.n} className="flex min-w-0 flex-1 items-center gap-[9px]">
            <span
              className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-[11px] font-bold ${
                done || active
                  ? "border-btn bg-btn text-btn-text"
                  : "border-line bg-transparent text-ink3"
              }`}
            >
              {done ? "✓" : step.n}
            </span>
            <span
              className={`text-[12px] font-semibold whitespace-nowrap ${
                active ? "text-ink" : done ? "text-ink2" : "text-ink3"
              }`}
            >
              {step.label}
            </span>
            {i < STEPS.length - 1 ? (
              <span className="h-px flex-1 bg-line-soft" />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export default function ConnectFlow() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("checking");
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [connectionName, setConnectionName] = useState<string | null>(null);
  const [courses, setCourses] = useState<CanvasCourseOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // canvas_course_id -> import_status, for courses already in the library.
  const [importedStatus, setImportedStatus] = useState<Map<string, string>>(new Map());

  const handleConnected = useCallback(
    (id: string, courseList: CanvasCourseOption[]) => {
      setConnectionId(id);
      setCourses(courseList);
      setStage("pick");
    },
    [],
  );

  // On load, reuse a saved Canvas connection if there is one — connect once,
  // then jump straight to picking courses. Only re-prompt when there's no
  // connection or the saved token has stopped working.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { connections } = await invokeFunction<{ connections: CanvasConnection[] }>(
          "polya-canvas",
          { action: "status" },
        );
        const active = connections.find((c) => c.status === "active");
        if (!active) {
          if (!cancelled) setStage("choose");
          return;
        }
        const { courses: courseList } = await invokeFunction<{ courses: CanvasCourseOption[] }>(
          "polya-canvas",
          { action: "list_courses", connection_id: active.id },
        );
        if (cancelled) return;
        setConnectionId(active.id);
        setConnectionName(active.canvas_user_name);
        setCourses(courseList);
        setStage("pick");
      } catch {
        // Saved token missing/rejected, or offline — fall back to connecting.
        if (!cancelled) setStage("choose");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Learn which of the student's Canvas courses are already in their library so
  // the picker can mark them ("Imported" / "Importing…") instead of offering to
  // bring them in again.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createBrowserSupabaseClient();
      const { data } = await supabase
        .from("polya_courses")
        .select("canvas_course_id, import_status");
      if (cancelled || !data) return;
      setImportedStatus(
        new Map(data.map((row) => [String(row.canvas_course_id), String(row.import_status)])),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Kick off the import for the chosen courses and hand off to the background
  // worker — no client pump loop. The student goes straight to studying; the
  // sidebar indicator tracks progress and imports keep running if they leave.
  const handleImport = useCallback(
    async (canvasCourseIds: string[]) => {
      if (canvasCourseIds.length === 0) return;
      setError(null);
      setStarting(true);
      try {
        const result = await invokeFunction<{ courses: StartedCourse[]; course_id?: string }>(
          "polya-import",
          {
            action: "start",
            connection_id: connectionId,
            canvas_course_ids: canvasCourseIds,
          },
        );
        for (const course of result.courses ?? []) {
          track("course_connected", course.course_id);
          track("import_started", course.course_id);
        }
        const first = result.courses?.[0];
        if (canvasCourseIds.length === 1 && first) {
          router.push(`/app/courses/${first.course_id}`);
        } else {
          router.push("/app");
        }
      } catch (err) {
        setStarting(false);
        setError(err instanceof Error ? err.message : "Couldn't start the import.");
      }
    },
    [connectionId, router],
  );

  // While waiting for the extension, watch for a course arriving (a new row, or
  // an existing one flipping to "importing") and jump into it — the extension
  // already kicks the background worker server-side.
  useEffect(() => {
    if (stage !== "extension") return;
    const supabase = createBrowserSupabaseClient();
    let cancelled = false;

    (async () => {
      const baseline = new Set<string>(
        ((await supabase.from("polya_courses").select("id")).data ?? []).map((c) => c.id as string),
      );
      while (!cancelled) {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        if (cancelled) return;
        const { data: rows } = await supabase
          .from("polya_courses")
          .select("id, import_status")
          .order("created_at", { ascending: false });
        const arrived = (rows ?? []).find(
          (row) => !baseline.has(row.id as string) || row.import_status === "importing",
        );
        if (arrived && !cancelled) {
          track("course_connected", arrived.id as string, { via: "extension" });
          router.push(`/app/courses/${arrived.id as string}`);
          return;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [stage, router]);

  const currentStep = stage === "pick" ? 2 : 1;

  return (
    <div className="flex flex-col gap-6">
      <StepIndicator current={currentStep} />

      {error ? (
        <p className="m-0 rounded-lg bg-amber-soft px-3 py-2.5 text-[12.5px] text-amber">
          {error}
        </p>
      ) : null}

      {stage === "checking" ? (
        <div className="flex items-center gap-2.5 py-2 text-[12.5px] text-ink3">
          <span className="h-[15px] w-[15px] shrink-0 animate-spin rounded-full border-[2px] border-accent-soft border-t-accent" />
          Checking your Canvas connection…
        </div>
      ) : null}

      {stage === "choose" ? (
        <div className="flex animate-fade-up flex-col gap-3">
          <button
            type="button"
            onClick={() => setStage("extension")}
            className="flex cursor-pointer flex-col gap-1 rounded-[10px] border border-line bg-surface px-4 py-3.5 text-left shadow-card hover:border-accent"
          >
            <span className="text-[13.5px] font-[650]">
              Use the Canvascope extension{" "}
              <span className="ml-1 rounded bg-accent-soft px-1.5 py-px text-[10px] font-bold uppercase tracking-[0.06em] text-accent-ink">
                Easiest
              </span>
            </span>
            <span className="text-[12.5px] leading-[1.6] text-ink2">
              Already signed in to Canvas in your browser? The extension brings
              your course straight in — nothing to copy or paste.
            </span>
          </button>
          <button
            type="button"
            onClick={() => setStage("token")}
            className="flex cursor-pointer flex-col gap-1 rounded-[10px] border border-line bg-surface px-4 py-3.5 text-left shadow-card hover:border-accent"
          >
            <span className="text-[13.5px] font-[650]">Paste a Canvas access token</span>
            <span className="text-[12.5px] leading-[1.6] text-ink2">
              Works everywhere, takes about a minute — we&apos;ll show you where
              to find the token in Canvas.
            </span>
          </button>
        </div>
      ) : null}

      {stage === "extension" ? (
        <div className="flex animate-fade-up flex-col gap-3.5 rounded-[10px] border border-line bg-surface px-4 py-4 shadow-card">
          <ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5 text-[13px] leading-[1.65] text-ink2">
            <li>
              <a
                href={EXTENSION_STORE_URL}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-accent-ink underline"
              >
                Install the Canvascope extension
              </a>{" "}
              if you don&apos;t have it yet, and sign in with the same Google
              account you use here.
            </li>
            <li>Open your course on Canvas.</li>
            <li>
              In the Canvascope side panel, choose{" "}
              <strong>Study in Polya</strong>.
            </li>
          </ol>
          <div className="flex items-center gap-[9px] text-[12.5px] text-ink3">
            <span className="h-1.5 w-1.5 animate-dot-pulse rounded-full bg-accent" />
            Waiting for your course to arrive — this page updates by itself.
          </div>
          <button
            type="button"
            onClick={() => setStage("choose")}
            className="self-start text-[12px] text-ink3 underline hover:text-ink"
          >
            ← Back
          </button>
        </div>
      ) : null}

      {stage === "token" ? (
        <div className="flex animate-fade-up flex-col gap-3">
          <TokenForm onConnected={handleConnected} />
          <button
            type="button"
            onClick={() => setStage("choose")}
            className="self-start text-[12px] text-ink3 underline hover:text-ink"
          >
            ← Back
          </button>
        </div>
      ) : null}

      {stage === "pick" ? (
        <div className="flex animate-fade-up flex-col gap-3">
          <CoursePicker
            courses={courses}
            onImport={handleImport}
            busy={starting}
            importedStatus={importedStatus}
          />
          <button
            type="button"
            onClick={() => {
              setConnectionId(null);
              setConnectionName(null);
              setCourses([]);
              setStage("choose");
            }}
            className="self-start text-[12px] text-ink3 underline hover:text-ink"
          >
            {connectionName ? `Not ${connectionName}? ` : ""}Use a different Canvas
          </button>
        </div>
      ) : null}
    </div>
  );
}
