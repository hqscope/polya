// Who the current session is helping. The Photon channel (channels/photon.ts) and the check-in
// sender (schedules/) put the linked Polya account's id on the session auth as the
// `polyaUserId` attribute after looking it up server-side. Tools read it from there.

export const STUDENT_ATTRIBUTE = "polyaUserId";

interface AuthLike {
  readonly current?: { readonly attributes?: Readonly<Record<string, unknown>> } | null;
}

/** The linked student's Polya user id, or undefined when the sender isn't linked. */
export function studentIdFrom(auth: AuthLike | null | undefined): string | undefined {
  const id = auth?.current?.attributes?.[STUDENT_ATTRIBUTE];
  return typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id) ? id : undefined;
}

export class NotLinkedError extends Error {
  constructor() {
    super("This conversation isn't linked to a Polya account yet.");
  }
}

export function requireStudentId(auth: AuthLike | null | undefined): string {
  const id = studentIdFrom(auth);
  if (!id) throw new NotLinkedError();
  return id;
}
