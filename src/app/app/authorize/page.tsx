import { redirect } from "next/navigation";

import { getAuthenticatedAppUser } from "@/lib/auth/session";
import { redirectToLogin } from "@/lib/auth/login-redirect";
import AuthorizeConsent from "@/components/connector/AuthorizeConsent";

export const metadata = { title: "Allow access" };

// Consent step for signing in to Polya from ChatGPT or Claude. Supabase Auth's
// OAuth server sends the browser here (its Authorization Path) with an
// authorization_id; the /app layout has already made sure someone is signed in.
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<{ authorization_id?: string }>;
}) {
  const { authorization_id: authorizationId } = await searchParams;
  const { user, supabase, outage } = await getAuthenticatedAppUser();
  if (outage) {
    throw new Error("auth-outage");
  }
  if (!user) {
    return redirectToLogin();
  }

  const { data, error } = authorizationId
    ? await supabase.auth.oauth.getAuthorizationDetails(authorizationId)
    : { data: null, error: null };

  // Already allowed once: straight back to the app that asked.
  if (data && "redirect_url" in data) {
    redirect(data.redirect_url);
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[480px] flex-col gap-6 px-5 pt-10 pb-14 sm:px-8">
        {error || !data || !authorizationId ? (
          <div className="flex flex-col gap-1.5">
            <h1 className="text-[21px]">This link has expired</h1>
            <p className="m-0 text-[13px] leading-[1.65] text-ink2">
              Go back to the app you came from and connect Polya again.
            </p>
          </div>
        ) : (
          <AuthorizeConsent
            authorizationId={authorizationId}
            clientName={data.client.name || "An app"}
            email={user.email}
          />
        )}
      </div>
    </div>
  );
}
