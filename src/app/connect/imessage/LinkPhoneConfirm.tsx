"use client";

import Link from "next/link";
import { useState } from "react";

import { loginPathFor } from "@/lib/auth/next-path";
import {
  CLAIM_RPC,
  claimFailureFrom,
  imessageLinkPathFor,
  phoneLastFour,
  type ClaimFailure,
} from "@/lib/imessage-link";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

type FinalFailure = Exclude<ClaimFailure, "signed_out" | "unknown">;

type State =
  | { step: "confirm"; pending: boolean; problem: "signed_out" | "unknown" | null }
  | { step: "linked"; lastFour: string | null }
  | { step: "failed"; failure: FinalFailure };

const MESSAGES: Record<FinalFailure, { title: string; body: string }> = {
  expired: {
    title: "This link has expired",
    body: "Links only work for a short time. Text Polya again and you'll get a new one.",
  },
  used: {
    title: "This link was already used",
    body: "If your phone isn't linked yet, text Polya again for a new link.",
  },
  invalid: {
    title: "This link doesn't work",
    body: "Open the whole link from your messages, or text Polya again for a new one.",
  },
};

/** A link that can't be used: expired, used, or not one of ours. */
export function LinkPhoneMessage({ failure }: { failure: FinalFailure }) {
  const { title, body } = MESSAGES[failure];
  return (
    <>
      <h1 className="text-[20px]">{title}</h1>
      <p className="m-0 text-[13px] leading-[1.65] text-ink2">{body}</p>
    </>
  );
}

// Confirm, then claim the code with the student's own session. `lastFour` is
// the phone the link is for (from the page's peek), or null for an Apple ID
// email.
export default function LinkPhoneConfirm({
  code,
  email,
  lastFour,
}: {
  code: string;
  email: string;
  lastFour: string | null;
}) {
  const [state, setState] = useState<State>({ step: "confirm", pending: false, problem: null });

  async function confirm() {
    setState({ step: "confirm", pending: true, problem: null });
    let result: { data: unknown; error: { hint?: string | null } | null };
    try {
      result = await createBrowserSupabaseClient().rpc(CLAIM_RPC, { code });
    } catch {
      result = { data: null, error: {} };
    }

    if (!result.error) {
      setState({ step: "linked", lastFour: phoneLastFour(result.data) ?? lastFour });
      return;
    }
    const failure = claimFailureFrom(result.error);
    if (failure === "signed_out" || failure === "unknown") {
      setState({ step: "confirm", pending: false, problem: failure });
    } else {
      setState({ step: "failed", failure });
    }
  }

  if (state.step === "failed") {
    return <LinkPhoneMessage failure={state.failure} />;
  }

  if (state.step === "linked") {
    return (
      <>
        <h1 className="text-[20px]">You&apos;re all set</h1>
        <p className="m-0 text-[13px] leading-[1.65] text-ink2">
          {state.lastFour
            ? `Your phone number ending in ${state.lastFour} is now linked to Polya.`
            : "Your Apple ID is now linked to Polya."}{" "}
          Go back to Messages and text Polya whenever you want help with your
          classwork.
        </p>
        <Link href="/app" className="button-secondary mt-2 self-start">
          Open Polya
        </Link>
      </>
    );
  }

  return (
    <>
      <h1 className="text-[20px]">
        {lastFour
          ? `Link the phone ending in ${lastFour} to your Polya account?`
          : "Link this Apple ID to your Polya account?"}
      </h1>
      <p className="m-0 text-[13px] leading-[1.65] text-ink2">Signed in as {email}.</p>
      <p className="m-0 text-[13px] leading-[1.65] text-ink2">
        You&apos;ll be able to text Polya for help with your courses and get
        short check-ins before assignments are due. You can turn check-ins off
        or unlink this phone any time by texting Polya.
      </p>
      <p className="m-0 text-[12.5px] leading-[1.6] text-ink3">
        Only continue if you opened this link from a text Polya just sent you.
      </p>

      {state.problem === "unknown" ? (
        <p className="m-0 rounded-lg bg-amber-soft px-3 py-2.5 text-[12.5px] text-amber">
          That didn&apos;t go through. Try again.
        </p>
      ) : null}
      {state.problem === "signed_out" ? (
        <p className="m-0 rounded-lg bg-amber-soft px-3 py-2.5 text-[12.5px] text-amber">
          You&apos;ve been signed out.{" "}
          <a
            href={loginPathFor(imessageLinkPathFor(code))}
            className="underline underline-offset-2"
          >
            Sign in again
          </a>{" "}
          to finish linking your phone.
        </p>
      ) : null}

      <div className="mt-2 flex gap-3">
        <button
          type="button"
          onClick={confirm}
          disabled={state.pending}
          className="button-primary h-9 px-5 text-[13px] disabled:opacity-60"
        >
          {state.pending ? "Linking…" : "Link this phone"}
        </button>
        <Link
          href="/app"
          className="flex h-9 items-center rounded-lg border border-line bg-surface px-4 text-[13px] font-semibold text-ink hover:border-ink3 hover:bg-rail hover:text-ink"
        >
          Not now
        </Link>
      </div>

      <form action="/auth/signout" method="post" className="mt-1">
        <p className="m-0 text-[12px] text-ink3">
          Not you?{" "}
          <button
            type="submit"
            className="cursor-pointer text-ink3 underline underline-offset-2 hover:text-ink"
          >
            Sign out
          </button>
          , then open the link again.
        </p>
      </form>
    </>
  );
}
