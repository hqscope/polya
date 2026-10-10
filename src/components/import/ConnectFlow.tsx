"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { FunctionError, invokeFunction } from "@/lib/functions";
import type { StorageFull } from "@/lib/storage-full";
import { detectStorageFull } from "@/lib/storage-full-client";
import { AI_BUSY_POLYA_IMPORT_DETAIL } from "@/lib/ai-busy";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";
import { track } from "@/lib/track";
import { userMessage } from "@/lib/user-message";
import { announceImportStarted } from "@/lib/import-events";
import {
  chooseConnection,
  pickConnection,
  readConnectionChoice,
  setConnectionAside,
  writeConnectionChoice,
} from "@/lib/canvas-connection";
import type { CanvasConnection, CanvasCourseOption, StartedCourse } from "@/lib/types";
import TokenForm from "@/components/import/TokenForm";
import CoursePicker from "@/components/import/CoursePicker";
import StorageFullNotice from "@/components/import/StorageFullNotice";

type Stage = "checking" | "choose" | "extension" | "token" | "pick";

// How long to wait for a course from the extension before offering another way.
const EXTENSION_WAIT_HINT_MS = 3 * 60 * 1000;

// `polya.connect.stillWaiting`, split around the inline link to the token form.
const STILL_WAITING_BEFORE =
  "Nothing has arrived yet. Make sure Scope is signed in with this Google account, or ";
const STILL_WAITING_LINK = "paste a Canvas access token";
const STILL_WAITING_AFTER = " instead.";

const EXTENSION_STORE_URL =
  "https://chromewebstore.google.com/detail/scope/bamoelobnoepklagbcokjnlipfhcfdbb";

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
          // The named step keeps room for its label; the others give way.
          <div
            key={step.n}
            className={`flex flex-1 items-center gap-[9px] ${active ? "min-w-fit" : "min-w-0"}`}
          >
            <span
              className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-[11px] font-bold ${
                done || active
                  ? "border-btn bg-btn text-btn-text"
                  : "border-line bg-transparent text-ink3"
              }`}
            >
              {done ? "✓" : step.n}
            </span>
            {/* On a phone only the current step is named; three labels don't fit. */}
            <span
              className={`text-[12px] font-semibold whitespace-nowrap ${
                active ? "text-ink" : done ? "hidden text-ink2 sm:inline" : "hidden text-ink3 sm:inline"
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
  const [storageFull, setStorageFull] = useState<StorageFull | null>(null);
  const [starting, setStarting] = useState(false);
  // The extension wait has run long enough to suggest the token route.
  const [stillWaiting, setStillWaiting] = useState(false);
  // canvas_course_id -> import_status, for courses already in the library.
  const [importedStatus, setImportedStatus] = useState<Map<string, string>>(new Map());

  const handleConnected = useCallback(
    (id: string, courseList: CanvasCourseOption[]) => {
      // Use this Canvas from now on, even if it was set aside before.
      writeConnectionChoice(chooseConnection(readConnectionChoice(), id));
      setConnectionId(id);
      setCourses(courseList);
      setStage("pick");
    },
    [],
  );

  // On load, reuse a saved Canvas connection if there is one — connect once,
  // then jump straight to picking courses. Only re-prompt when there's no
  // connection, the saved token has stopped working, or the student set every
  // saved one aside with "Use a different Canvas" (see lib/canvas-connection).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { connections } = await invokeFunction<{ connections: CanvasConnection[] }>(
          "polya-canvas",
          { action: "status" },
        );
        const active = pickConnection(connections, readConnectionChoice());
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
      setStorageFull(null);
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
        announceImportStarted();
        const first = result.courses?.[0];
        if (canvasCourseIds.length === 1 && first) {
          router.push(`/app/courses/${first.course_id}`);
        } else {
          router.push("/app");
        }
      } catch (err) {
        setStarting(false);
        const full = await detectStorageFull(err);
        if (full) {
          setStorageFull(full);
        } else if (err instanceof FunctionError && err.code === "busy") {
          setError(AI_BUSY_POLYA_IMPORT_DETAIL);
        } else {
          console.error("[polya] import start failed:", err);
          setError(userMessage(err));
        }
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
    const hintTimer = setTimeout(() => setStillWaiting(true), EXTENSION_WAIT_HINT_MS);

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
      clearTimeout(hintTimer);
    };
  }, [stage, router]);

  const currentStep = stage === "pick" ? 2 : 1;

  return (
    <div className="flex flex-col gap-6">
      <StepIndicator current={currentStep} />

      {storageFull ? (
        <StorageFullNotice state={storageFull} />
      ) : error ? (
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
            onClick={() => {
              setStillWaiting(false);
              setStage("extension");
            }}
            className="flex cursor-pointer flex-col gap-1 rounded-[10px] border border-line bg-surface px-4 py-3.5 text-left shadow-card hover:border-accent"
          >
            <span className="text-[13.5px] font-[650]">
              Use the Scope extension{" "}
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
                Install the Scope extension
              </a>{" "}
              if you don&apos;t have it yet, and sign in with the same Google
              account you use here.
            </li>
            <li>Open your course on Canvas.</li>
            <li>
              In Scope, open the search bar and choose{" "}
              <strong>Study in Polya</strong>.
            </li>
          </ol>
          <div className="flex items-center gap-[9px] text-[12.5px] text-ink3">
            <span className="h-1.5 w-1.5 animate-dot-pulse rounded-full bg-accent" />
            Waiting for your course to arrive — this page updates by itself.
          </div>
          {stillWaiting ? (
            <p role="status" className="m-0 rounded-lg bg-rail px-3 py-2.5 text-[12.5px] leading-[1.6] text-ink2">
              {STILL_WAITING_BEFORE}
              <button
                type="button"
                onClick={() => setStage("token")}
                className="cursor-pointer font-semibold text-accent-ink underline hover:text-accent"
              >
                {STILL_WAITING_LINK}
              </button>
              {STILL_WAITING_AFTER}
            </p>
          ) : null}
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
              // Set this one aside so a reload doesn't pick it again. Nothing
              // is deleted: it's the same connection Scope and Lectra use.
              if (connectionId) {
                writeConnectionChoice(setConnectionAside(readConnectionChoice(), connectionId));
              }
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
