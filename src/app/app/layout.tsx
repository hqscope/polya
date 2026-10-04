import type { Metadata } from "next";

import { getAuthenticatedAppUser } from "@/lib/auth/session";
import { redirectToLogin } from "@/lib/auth/login-redirect";
import AppShell from "@/components/app/AppShell";
import OutageNotice from "@/components/app/OutageNotice";
import type { SidebarCourse } from "@/components/app/SidebarNav";

export const metadata: Metadata = {
  title: {
    default: "Study",
    template: "%s | Polya",
  },
  robots: {
    index: false,
    follow: false,
  },
};

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, supabase, outage } = await getAuthenticatedAppUser();

  // We couldn't confirm the session either way (an outage, not a sign-out).
  // Show the retry notice instead of bouncing to /login and losing the
  // session cookies for no reason. Rendered here rather than thrown: a
  // layout's own error skips `app/app/error.tsx`, so a throw showed the
  // framework's generic error page.
  if (outage) {
    return <OutageNotice fullScreen />;
  }

  // Back to the page they asked for after sign-in, not the course list (P-37).
  if (!user) {
    return redirectToLogin();
  }

  const { data: courses } = await supabase
    .from("polya_courses")
    .select("id, name, code")
    .order("created_at", { ascending: false });

  return (
    <AppShell
      displayName={user.displayName}
      email={user.email}
      courses={(courses ?? []) as SidebarCourse[]}
    >
      {children}
    </AppShell>
  );
}
