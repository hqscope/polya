"use server";

import { getAuthenticatedAppUser } from "@/lib/auth/session";
import { parseConnectForm, type ConnectState } from "@/lib/gradescope-connect";

import { sendGradescopeConnect } from "./agent";

// Reconnects the signed-in student's Gradescope account. Anyone can POST to a
// server action, so this checks the session itself: the student's id comes
// from the session, never from the form. The cookie or password goes to the
// agent and nowhere else; the state sent back holds only a code or the
// course list.
export async function connectGradescope(
  _previous: ConnectState,
  formData: FormData,
): Promise<ConnectState> {
  const { user, outage } = await getAuthenticatedAppUser();
  if (outage) return { step: "error", code: "unknown" };
  if (!user) return { step: "error", code: "signed_out" };

  const parsed = parseConnectForm({
    mode: formData.get("mode"),
    cookie: formData.get("cookie"),
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.ok) return { step: "error", code: parsed.code };

  const result = await sendGradescopeConnect(user.id, parsed.request);
  return result.ok
    ? { step: "connected", courses: result.courses, courseNames: result.courseNames }
    : { step: "error", code: result.code };
}
