"use client";

import { useState } from "react";

import { invokeFunction } from "@/lib/functions";
import type { CanvasCourseOption } from "@/lib/types";

interface Props {
  onConnected: (connectionId: string, courses: CanvasCourseOption[]) => void;
}

export default function TokenForm({ onConnected }: Props) {
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const connect = await invokeFunction<{ connection_id: string }>("polya-canvas", {
        action: "connect",
        base_url: baseUrl,
        access_token: token,
      });
      const courses = await invokeFunction<{ courses: CanvasCourseOption[] }>("polya-canvas", {
        action: "list_courses",
        connection_id: connect.connection_id,
      });
      onConnected(connect.connection_id, courses.courses);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't connect to Canvas.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label className="text-[12.5px] font-semibold">
          Your school&apos;s Canvas web address
        </label>
        <input
          type="url"
          required
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://canvas.youruniversity.edu"
          className="w-full rounded-lg border border-line bg-surface px-3 py-[9px] text-[13px] shadow-card outline-none placeholder:text-ink3 focus:border-accent"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[12.5px] font-semibold">Canvas access token</label>
        <input
          type="password"
          required
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="Paste your access token"
          className="w-full rounded-lg border border-line bg-surface px-3 py-[9px] font-mono text-[13px] shadow-card outline-none placeholder:font-body placeholder:text-ink3 focus:border-accent"
        />
      </div>

      <details className="rounded-lg border border-line-soft bg-rail px-3.5 py-2.5 text-[12.5px] text-ink2">
        <summary className="cursor-pointer font-semibold text-ink">
          Where do I find this?
        </summary>
        <ol className="mt-2 mb-0.5 list-decimal pl-[18px] leading-[1.9]">
          <li>In Canvas, open Account → Settings.</li>
          <li>
            Under Approved Integrations, choose <em>+ New Access Token</em>.
          </li>
          <li>Give it a purpose (e.g. &ldquo;Polya&rdquo;), generate it, and copy the token.</li>
          <li>Paste it above. Polya keeps it private and only reads your courses.</li>
        </ol>
      </details>

      {error ? (
        <p className="m-0 rounded-lg bg-amber-soft px-3 py-2.5 text-[12.5px] text-amber">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        className="button-primary h-9 w-full text-[13px] disabled:opacity-60"
      >
        {busy ? "Connecting…" : "Connect Canvas"}
      </button>
    </form>
  );
}
