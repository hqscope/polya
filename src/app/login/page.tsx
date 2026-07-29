import type { Metadata } from "next";

import Logo from "@/components/Logo";
import { defaultOpenGraph } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Sign in",
  description:
    "Sign in to Polya with Google to connect your Canvas courses and study with an AI tutor that shows its sources.",
  alternates: { canonical: "/login" },
  openGraph: { ...defaultOpenGraph, url: "/login" },
};

function GoogleG() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M45.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.8-2.1 5.1-4.4 6.7v5.5h7.1c4.2-3.8 6.6-9.5 6.6-16.2z"
      />
      <path
        fill="#34A853"
        d="M24 46c6 0 10.9-2 14.6-5.3l-7.1-5.5c-2 1.3-4.5 2.1-7.5 2.1-5.7 0-10.6-3.9-12.3-9.1H4.3v5.7C7.9 41.2 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.7 28.2c-.4-1.3-.7-2.7-.7-4.2s.2-2.9.7-4.2v-5.7H4.3C2.9 17 2 20.4 2 24s.9 7 2.3 9.9l7.4-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.8c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.2 30 2 24 2 15.4 2 7.9 6.8 4.3 14.1l7.4 5.7c1.7-5.2 6.6-9 12.3-9z"
      />
    </svg>
  );
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const nextPath = params.next ?? "/app";
  const hadError = Boolean(params.error);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 py-10">
      <div className="flex w-full max-w-[380px] flex-col gap-5">
        <Logo />

        <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-7 shadow-[0_8px_24px_-16px_rgba(25,31,29,0.25)]">
          <h1 className="text-[20px]">Sign in</h1>
          <p className="m-0 text-[13px] leading-[1.65] text-ink2">
            Use the Google account you&apos;d like your courses and study
            sessions saved under.
          </p>

          {hadError ? (
            <p className="m-0 rounded-lg bg-amber-soft px-3 py-2.5 text-[12.5px] text-amber">
              Sign-in didn&apos;t go through. Please try again.
            </p>
          ) : null}

          <a
            href={`/auth/login?next=${encodeURIComponent(nextPath)}`}
            className="mt-2 flex h-10 items-center justify-center gap-[9px] rounded-lg border border-line bg-surface text-[13.5px] font-semibold text-ink shadow-card hover:border-ink3 hover:bg-rail hover:text-ink"
          >
            <GoogleG />
            Continue with Google
          </a>
        </div>

        <p className="m-0 text-center text-[11.5px] leading-relaxed text-ink3">
          Your course materials stay yours — Polya only uses them to help you
          study.
        </p>
      </div>
    </div>
  );
}
