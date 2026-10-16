import type { Metadata } from "next";
import { redirect } from "next/navigation";

import Logo from "@/components/Logo";
import OutageNotice from "@/components/app/OutageNotice";
import { loginPathFor } from "@/lib/auth/next-path";
import { getAuthenticatedAppUser } from "@/lib/auth/session";
import { GRADESCOPE_CONNECT_PATH } from "@/lib/gradescope-connect";

import { fetchGradescopeStatus, isGradescopeConnectConfigured } from "./agent";
import GradescopeConnectForm from "./GradescopeConnectForm";

export const metadata: Metadata = {
  title: "Reconnect Gradescope",
  robots: { index: false, follow: false },
};

// A student reconnects Gradescope here when Polya can't reach their account
// any more. They sign in (and come back here), see whether Gradescope is
// connected, and reconnect with a cookie copied from a signed-in browser
// (school sign-in) or a Gradescope email and password.
export default async function ReconnectGradescopePage() {
  const { user, outage } = await getAuthenticatedAppUser();
  // We couldn't confirm the session either way: show the retry notice
  // rather than bouncing a signed-in student to sign in again.
  if (outage) {
    return <OutageNotice fullScreen />;
  }
  if (!user) {
    redirect(loginPathFor(GRADESCOPE_CONNECT_PATH));
  }
  // Without the agent's secret nothing on this page can work.
  if (!isGradescopeConnectConfigured()) {
    return <OutageNotice fullScreen />;
  }

  const status = await fetchGradescopeStatus(user.id);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-10">
      <div className="flex w-full max-w-[440px] flex-col gap-5">
        <Logo />
        <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-7 shadow-[0_8px_24px_-16px_rgba(25,31,29,0.25)]">
          <GradescopeConnectForm email={user.email} status={status} />
        </div>
      </div>
    </main>
  );
}
