import type { Metadata } from "next";

import Logo from "@/components/Logo";
import EmailSignInForm from "@/components/auth/EmailSignInForm";
import { sanitizeNextPath } from "@/lib/auth/next-path";

export const metadata: Metadata = {
  title: "Sign in with email",
  robots: { index: false, follow: false },
};

// Password sign-in for accounts that have one (for example the review account
// app directories use to test the ChatGPT / Claude connector). There is no
// sign-up here: new students use Google.
export default async function EmailLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const nextPath = sanitizeNextPath(next);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-10">
      <div className="flex w-full max-w-[380px] flex-col gap-5">
        <Logo />
        <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-7 shadow-[0_8px_24px_-16px_rgba(25,31,29,0.25)]">
          <h1 className="text-[20px]">Sign in with email</h1>
          <EmailSignInForm nextPath={nextPath} />
          <a
            href={`/login?next=${encodeURIComponent(nextPath)}`}
            className="self-center text-[12.5px] text-ink3 underline-offset-2 hover:text-ink hover:underline"
          >
            Use Google instead
          </a>
        </div>
      </div>
    </main>
  );
}
