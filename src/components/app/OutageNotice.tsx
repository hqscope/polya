"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

// Shown when we couldn't confirm the session (an outage, not a sign-out); see
// src/lib/auth/outage.ts. Fixed, neutral copy; never redirects or touches
// cookies. Try Again re-runs the server render, so the page comes back as
// soon as the service does.
//
// `fullScreen` is for `app/app/layout.tsx`, which renders this in place of the
// whole shell: an error thrown by a layout skips the `error.tsx` in its own
// segment, so throwing there showed the framework's generic error page.
export default function OutageNotice({
  onRetry,
  fullScreen = false,
}: {
  onRetry?: () => void;
  fullScreen?: boolean;
}) {
  const router = useRouter();
  const [retrying, startRetry] = useTransition();
  const Wrapper = fullScreen ? "main" : "div";

  return (
    <Wrapper
      className={`flex ${fullScreen ? "min-h-dvh" : "h-full"} flex-col items-center justify-center gap-3 px-8 text-center`}
    >
      <h1 className="m-0 text-[16px]">Can&apos;t reach Polya right now</h1>
      {/* COPY.md §14.4 polya.outage.title / .body / .retry */}
      <p className="m-0 max-w-sm text-[13px] leading-[1.65] text-ink2">
        You&apos;re still signed in, and your courses and progress are safe.
        Try again in a moment.
      </p>
      <button
        type="button"
        disabled={retrying}
        onClick={() =>
          startRetry(() => {
            router.refresh();
            onRetry?.();
          })
        }
        className="button-secondary mt-2 h-9 px-4 text-[13px]"
      >
        Try Again
      </button>
    </Wrapper>
  );
}
