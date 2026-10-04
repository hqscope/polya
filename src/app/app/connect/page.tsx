
import { getAuthenticatedAppUser } from "@/lib/auth/session";
import { redirectToLogin } from "@/lib/auth/login-redirect";
import ConnectFlow from "@/components/import/ConnectFlow";

export const metadata = { title: "Connect Canvas" };

export default async function ConnectPage() {
  const { user, outage } = await getAuthenticatedAppUser();
  if (outage) {
    throw new Error("auth-outage");
  }
  if (!user) {
    return redirectToLogin();
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[560px] flex-col gap-6 px-5 pt-10 pb-14 sm:px-8">
        <div className="flex flex-col gap-1.5 border-b border-line pb-[18px]">
          <h1 className="text-[21px]">Connect your Canvas</h1>
          <p className="m-0 text-[13px] leading-[1.65] text-ink2">
            Polya reads your course materials straight from Canvas so its help
            always comes from what your class actually covers. Takes about a
            minute.
          </p>
        </div>

        <ConnectFlow />
      </div>
    </div>
  );
}
