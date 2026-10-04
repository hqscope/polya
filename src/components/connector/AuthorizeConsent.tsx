"use client";

import { useState } from "react";

import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

interface Props {
  authorizationId: string;
  clientName: string;
  email: string;
}

const DECISION_FAILED = "That didn't go through. Try again.";

// Allow / don't allow. On either choice Supabase sends the browser back to the
// app that asked, with its sign-in result.
export default function AuthorizeConsent({ authorizationId, clientName, email }: Props) {
  const [pending, setPending] = useState<"allow" | "deny" | null>(null);
  const [failed, setFailed] = useState(false);

  async function decide(choice: "allow" | "deny") {
    setPending(choice);
    setFailed(false);
    const oauth = createBrowserSupabaseClient().auth.oauth;
    const { error } =
      choice === "allow"
        ? await oauth.approveAuthorization(authorizationId)
        : await oauth.denyAuthorization(authorizationId);
    if (error) {
      setPending(null);
      setFailed(true);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5 border-b border-line pb-[18px]">
        <h1 className="text-[21px]">Connect {clientName} to Polya?</h1>
        <p className="m-0 text-[13px] leading-[1.65] text-ink2">
          Signed in as {email}.
        </p>
      </div>

      <div className="flex flex-col gap-2 text-[13px] leading-[1.65] text-ink2">
        <p className="m-0">{clientName} will be able to:</p>
        <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
          <li>See the names of the courses you&apos;ve added to Polya</li>
          <li>Read each course&apos;s study rules</li>
          <li>Search your course materials when you ask about a course</li>
        </ul>
        <p className="m-0">
          It can&apos;t change anything in Polya or Canvas. You can disconnect it at
          any time from {clientName}&apos;s settings.
        </p>
      </div>

      {failed ? (
        <p className="m-0 rounded-lg bg-amber-soft px-3 py-2.5 text-[12.5px] text-amber">
          {DECISION_FAILED}
        </p>
      ) : null}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => decide("allow")}
          disabled={pending !== null}
          className="button-primary h-9 px-5 text-[13px] disabled:opacity-60"
        >
          {pending === "allow" ? "Connecting…" : "Allow"}
        </button>
        <button
          type="button"
          onClick={() => decide("deny")}
          disabled={pending !== null}
          className="h-9 rounded-lg border border-line bg-surface px-4 text-[13px] font-semibold text-ink hover:border-ink3 hover:bg-rail disabled:cursor-default disabled:opacity-60"
        >
          Don&apos;t allow
        </button>
      </div>
    </div>
  );
}
