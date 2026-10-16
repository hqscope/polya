// Bearer check for the agent's server-to-server routes: the manual check-in trigger
// (channels/check-ins.ts, POLYA_CHECKINS_SECRET) and the Gradescope connect route
// (channels/gradescope-connect.ts, POLYA_CONNECT_SECRET).
import { createHash, timingSafeEqual } from "node:crypto";

const MIN_SECRET_LENGTH = 32;

/**
 * True when `authorization` is `Bearer <secret>`. The secret must be set and at least 32
 * characters, or every request is refused. Comparing sha256 digests keeps the compare
 * constant-time without leaking the secret's length.
 */
export function isAuthorizedTrigger(authorization: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < MIN_SECRET_LENGTH) return false;
  const match = /^Bearer +(\S+) *$/i.exec(authorization ?? "");
  if (!match?.[1]) return false;
  const given = createHash("sha256").update(match[1]).digest();
  const expected = createHash("sha256").update(secret).digest();
  return timingSafeEqual(given, expected);
}
