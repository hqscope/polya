"use client";

import { useEffect } from "react";

import OutageNotice from "@/components/app/OutageNotice";

// Catches the outage signal thrown by the /app pages when we can't confirm a
// session (an outage, not a sign-out) — see src/lib/auth/session.ts. Deliberately
// shows fixed, neutral copy rather than the thrown error's message, and never
// redirects or touches cookies. (The /app layout can't reach this boundary; it
// renders the same notice itself.)
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return <OutageNotice onRetry={reset} />;
}
