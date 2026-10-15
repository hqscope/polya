"use client";

import { useEffect, useRef, useState } from "react";

import { invokeFunction } from "@/lib/functions";
import { userMessage } from "@/lib/user-message";
import {
  type DriveConnectResult,
  type DriveStatus,
  driveStartHref,
  readDriveResult,
} from "@/lib/google-drive-connect";

// Connected / not connected, with Connect and Disconnect, for the student's
// Google Drive. Lets Polya bring in course files shared only with the
// student's school Google accounts. The flow itself is in
// src/lib/google-drive-connect.ts.

type View =
  | { kind: "checking" }
  | { kind: "unavailable" }
  | { kind: "failed" }
  | { kind: "disconnected" }
  | { kind: "connected"; email: string | null };

// Shown after Google sends the student back (?drive=<result>). A successful
// connect needs no banner: the card itself says "connected".
const RESULT_COPY: Record<Exclude<DriveConnectResult, "connected">, string> = {
  denied: "Polya didn't get permission to see your Drive files. Connect again and allow it.",
  unavailable: "Google Drive isn't available for your account yet.",
  error: "Connecting Google Drive didn't work. Try again.",
};

const COPY = {
  checking: "Checking Google Drive…",
  unavailable: "Google Drive isn't available for your account yet.",
  failed: "Couldn't check your Google Drive connection. Reload to try again.",
  title: "Google Drive",
  pitch:
    "Some course files are shared only with your school's Google accounts. Connect yours so Polya can bring them in. Polya only reads your files; it never changes them.",
  connect: "Connect Google Drive",
  connecting: "Opening Google…",
  connected: "Google Drive connected",
  connectedAs: (email: string) => `as ${email}`,
  disconnect: "Disconnect",
  disconnecting: "Disconnecting…",
  disconnectNote: "This also disconnects Google Drive in the Scope extension.",
  warningSummary: "Seeing a warning from Google?",
  warningBody:
    "Google may say it hasn't verified Polya yet. Choose Advanced, then continue to Polya. On the next screen, keep the box that lets Polya see your Google Drive files checked.",
} as const;

interface Props {
  /** Called once the connection is known, and after each connect or disconnect. */
  onChange?: (connected: boolean) => void;
}

export default function ConnectGoogleDrive({ onChange }: Props) {
  const [view, setView] = useState<View>({ kind: "checking" });
  const [result, setResult] = useState<DriveConnectResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const returned = readDriveResult(window.location.search);
      try {
        const status = await invokeFunction<DriveStatus>("polya-google", { action: "status" });
        if (cancelled) return;
        if (status.connected) setView({ kind: "connected", email: status.email });
        else if (status.access === "full" && status.configured) setView({ kind: "disconnected" });
        else setView({ kind: "unavailable" });
        setResult(returned);
        onChangeRef.current?.(status.connected);
      } catch (err) {
        if (cancelled) return;
        console.error("[polya] Google Drive status failed:", err);
        setView({ kind: "failed" });
        setResult(returned);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function connect() {
    setBusy(true);
    window.location.assign(driveStartHref(`${window.location.pathname}${window.location.search}`));
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      await invokeFunction("polya-google", { action: "disconnect" });
      setView({ kind: "disconnected" });
      setResult(null);
      onChangeRef.current?.(false);
    } catch (err) {
      console.error("[polya] Google Drive disconnect failed:", err);
      setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const banner = result && result !== "connected" ? RESULT_COPY[result] : null;

  if (view.kind === "checking") {
    return (
      <div className="flex items-center gap-2.5 py-2 text-[12.5px] text-ink3">
        <span className="h-[15px] w-[15px] shrink-0 animate-spin rounded-full border-[2px] border-accent-soft border-t-accent" />
        {COPY.checking}
      </div>
    );
  }

  if (view.kind === "unavailable" || view.kind === "failed") {
    return (
      <p className="m-0 text-[12.5px] leading-[1.6] text-ink3">
        {view.kind === "unavailable" ? COPY.unavailable : COPY.failed}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {banner || error ? (
        <p role="status" className="m-0 rounded-lg bg-amber-soft px-3 py-2.5 text-[12.5px] text-amber">
          {error ?? banner}
        </p>
      ) : null}

      {view.kind === "connected" ? (
        <div className="flex flex-col gap-2 rounded-[10px] border border-line bg-surface px-4 py-3.5 shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            <div className="flex min-w-0 flex-col">
              <span className="flex items-center gap-2 text-[13.5px] font-[650]">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                {COPY.connected}
              </span>
              {view.email ? (
                <span className="truncate text-[12.5px] text-ink2">{COPY.connectedAs(view.email)}</span>
              ) : null}
            </div>
            <button
              type="button"
              onClick={disconnect}
              disabled={busy}
              className="cursor-pointer text-[12px] text-ink3 underline hover:text-ink disabled:opacity-60"
            >
              {busy ? COPY.disconnecting : COPY.disconnect}
            </button>
          </div>
          <p className="m-0 text-[11.5px] leading-[1.6] text-ink3">{COPY.disconnectNote}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface px-4 py-3.5 shadow-card">
          <div className="flex flex-col gap-1">
            <span className="text-[13.5px] font-[650]">{COPY.title}</span>
            <span className="text-[12.5px] leading-[1.6] text-ink2">{COPY.pitch}</span>
          </div>
          <button
            type="button"
            onClick={connect}
            disabled={busy}
            className="button-secondary h-9 self-start text-[13px] disabled:opacity-60"
          >
            {busy ? COPY.connecting : COPY.connect}
          </button>
          <details className="rounded-lg border border-line-soft bg-rail px-3.5 py-2.5 text-[12.5px] text-ink2">
            <summary className="cursor-pointer font-semibold text-ink">{COPY.warningSummary}</summary>
            <p className="mt-2 mb-0.5 leading-[1.7]">{COPY.warningBody}</p>
          </details>
        </div>
      )}
    </div>
  );
}
