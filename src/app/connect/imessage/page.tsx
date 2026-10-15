import type { Metadata } from "next";
import { redirect } from "next/navigation";

import Logo from "@/components/Logo";
import OutageNotice from "@/components/app/OutageNotice";
import { loginPathFor } from "@/lib/auth/next-path";
import { getAuthenticatedAppUser } from "@/lib/auth/session";
import {
  PEEK_RPC,
  claimFailureFrom,
  imessageLinkPathFor,
  linkTargetFromPeek,
  parseLinkCode,
} from "@/lib/imessage-link";

import LinkPhoneConfirm, { LinkPhoneMessage } from "./LinkPhoneConfirm";

export const metadata: Metadata = {
  title: "Link your phone",
  robots: { index: false, follow: false },
};

// Polya texts a student who isn't linked yet a link to this page. They sign in
// (and come back here with the same code), see which phone the link is for,
// confirm, and from then on texting Polya reaches their account. Loading only
// peeks at the code; the claim happens on confirm, so a link preview or a
// prefetch can't use the code up.
export default async function LinkPhonePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const code = parseLinkCode((await searchParams).code);

  let body: React.ReactNode;
  if (!code) {
    body = <LinkPhoneMessage failure="invalid" />;
  } else {
    const { user, supabase, outage } = await getAuthenticatedAppUser();
    // We couldn't confirm the session either way: show the retry notice
    // rather than bouncing a signed-in student to sign in again.
    if (outage) {
      return <OutageNotice fullScreen />;
    }
    if (!user) {
      redirect(loginPathFor(imessageLinkPathFor(code)));
    }

    // Name the phone before asking, so a student sent someone else's link
    // sees a number that isn't theirs.
    const { data, error } = await supabase.rpc(PEEK_RPC, { code });
    const failure = error ? claimFailureFrom(error) : null;
    const target = error ? null : linkTargetFromPeek(data);

    if (failure === "signed_out") {
      redirect(loginPathFor(imessageLinkPathFor(code)));
    }
    if (failure === "invalid" || failure === "used" || failure === "expired") {
      body = <LinkPhoneMessage failure={failure} />;
    } else if (!target) {
      // Couldn't check the link right now. Never ask to confirm a link
      // without saying which phone it's for.
      return <OutageNotice fullScreen />;
    } else {
      body = <LinkPhoneConfirm code={code} email={user.email} lastFour={target.lastFour} />;
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-10">
      <div className="flex w-full max-w-[380px] flex-col gap-5">
        <Logo />
        <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-7 shadow-[0_8px_24px_-16px_rgba(25,31,29,0.25)]">
          {body}
        </div>
      </div>
    </main>
  );
}
