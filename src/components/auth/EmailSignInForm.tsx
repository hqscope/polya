"use client";

import { useState } from "react";

import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

const SIGN_IN_FAILED = "That email and password didn't match. Try again.";

export default function EmailSignInForm({ nextPath }: { nextPath: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setFailed(false);
    const { error } = await createBrowserSupabaseClient().auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) {
      setPending(false);
      setFailed(true);
      return;
    }
    // Full navigation so the server sees the new session cookies.
    window.location.assign(nextPath);
  }

  const field =
    "h-10 rounded-lg border border-line bg-surface px-3 text-[13.5px] text-ink outline-none focus:border-ink3";

  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5">
      <label className="flex flex-col gap-1 text-[12.5px] text-ink2">
        Email
        <input
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className={field}
        />
      </label>
      <label className="flex flex-col gap-1 text-[12.5px] text-ink2">
        Password
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={field}
        />
      </label>
      {failed ? (
        <p className="m-0 rounded-lg bg-amber-soft px-3 py-2.5 text-[12.5px] text-amber">
          {SIGN_IN_FAILED}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="button-primary mt-1 h-10 text-[13.5px] disabled:opacity-60"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
