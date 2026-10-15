// Linking a phone to Polya from the link Polya texts (/connect/imessage?code=...).
// The page reads the code from the URL, asks `polya_imessage_peek_code` which
// phone it's for, the signed-in student confirms, and
// `polya_imessage_claim_code` (supabase/migrations/*_polya_imessage.sql) does
// the claim. These helpers are the page's pure parts.
//
// No imports on purpose: Node's test runner loads this file directly.

/** Where the texted link points. Also an allowed sign-in return path (next-path.ts). */
export const IMESSAGE_LINK_PATH = "/connect/imessage";

/**
 * The read-only peek RPC; it takes `{ code }` and returns the phone's last 4
 * digits, or EMAIL_HANDLE_MARKER for an Apple ID email.
 */
export const PEEK_RPC = "polya_imessage_peek_code";

/** What the peek RPC returns when the handle is an email, not a phone. */
export const EMAIL_HANDLE_MARKER = "email";

/** The claim RPC; it takes `{ code }` and returns the handle's last 4 characters. */
export const CLAIM_RPC = "polya_imessage_claim_code";

// Same shape the RPC accepts: URL-safe characters only.
const CODE_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;

/**
 * The link code from the page's `code` search param, or null when it's missing
 * or can't be one of ours. A repeated param (`?code=a&code=b`) is rejected
 * rather than guessed at.
 */
export function parseLinkCode(raw: string | string[] | undefined): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim();
  return CODE_PATTERN.test(code) ? code : null;
}

/** This page with its code, for returning here after sign-in. */
export function imessageLinkPathFor(code: string): string {
  return `${IMESSAGE_LINK_PATH}?code=${encodeURIComponent(code)}`;
}

export type ClaimFailure = "signed_out" | "invalid" | "used" | "expired" | "unknown";

const HINT_TO_FAILURE: Readonly<Record<string, ClaimFailure>> = {
  polya_imessage_signed_out: "signed_out",
  polya_imessage_code_invalid: "invalid",
  polya_imessage_code_used: "used",
  polya_imessage_code_expired: "expired",
};

/**
 * Which failure screen to show for an RPC error. The RPC puts a stable key in
 * the Postgres error's `hint`; anything else (network, an outage) is
 * "unknown", which keeps the confirm button so the student can try again.
 */
export function claimFailureFrom(
  error: { hint?: string | null } | null | undefined,
): ClaimFailure {
  const hint = error?.hint;
  if (typeof hint === "string" && Object.hasOwn(HINT_TO_FAILURE, hint)) {
    return HINT_TO_FAILURE[hint];
  }
  return "unknown";
}

/**
 * The last 4 digits to show on the success screen, or null when the linked
 * handle isn't a phone number (an Apple ID email ends in something like
 * ".com", which tells the student nothing).
 */
export function phoneLastFour(data: unknown): string | null {
  return typeof data === "string" && /^\d{4}$/.test(data) ? data : null;
}

/**
 * What the confirm screen names, from a successful peek: the phone's last 4
 * digits, or `lastFour: null` for an Apple ID email. Null when the answer is
 * neither, which the page treats like any other failure to check the link.
 */
export function linkTargetFromPeek(data: unknown): { lastFour: string | null } | null {
  if (data === EMAIL_HANDLE_MARKER) return { lastFour: null };
  const lastFour = phoneLastFour(data);
  return lastFour ? { lastFour } : null;
}
