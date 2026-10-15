// Reads a school-only Google file as the student, for the import pump: the
// student's Drive grant (the platform's google_tokens 'drive' row, shared
// with the Scope extension), the google_drive_full_read gate, and one
// google_drive_audit row per read (client 'polya'), failing closed.
//
// Pure module: the store (rows), fetch and decrypt are injected, so Node's
// test runner covers it. drive-grant-store.ts binds it to the service-role
// client and edge env. The token and Drive calls are drive.ts.
//
// Errors the pump sees: TransientFetchError (retried later), or
// DriveAccessError whose message is shown to the student as-is.
import { CURRENT_KEY_VERSION } from "./token-crypto.ts";
import type { FetchLike } from "./safe-fetch.ts";
import {
  auditDriveClient,
  createDriveClient,
  DRIVE_READONLY_SCOPE,
  DriveAccessDeniedError,
  type DriveAuditOutcome,
  DriveAuthError,
  type DriveClient,
  DriveNotFoundError,
  DriveSetupError,
  DriveUnreadableError,
  grantTokenSource,
  MAX_GOOGLE_FILE_BYTES,
  TOKEN_URL,
} from "./drive.ts";

export type { DriveAuditOutcome } from "./drive.ts";

export const GOOGLE_TOKEN_URL = TOKEN_URL;
export const DRIVE_GRANT_KIND = "drive";
export const DRIVE_FLAG_KEY = "google_drive_full_read";

/** What the student sees when a school-only Google file can't be brought in. */
export const DRIVE_COPY = {
  needsSchoolAccount:
    "This file is shared only with your school's Google accounts. Connect your school Google account to bring it in.",
  noAccess: "Your connected Google account can't open this file. It may have been removed, or it isn't shared with you.",
  blockedBySchool: "Your school doesn't let Polya open files from its Google Drive.",
  noDownload: "The owner of this file turned off downloading, so it can't be brought in.",
  tooLarge: "This file is too large to bring in.",
  unsupported: "This file isn't a PDF, Slides deck, or Doc, so it can't be brought in.",
  unavailable: "Google Drive files can't be brought in right now. Try again later.",
} as const;

/** A school-only file that can't be read for a reason the student can act on; the message is user-facing. */
export class DriveAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriveAccessError";
  }
}

/** The google_tokens 'drive' row, still sealed. */
export interface StoredDriveGrant {
  refreshTokenCiphertext: string;
  accessTokenCiphertext: string | null;
  accessTokenExpiresAt: string | null;
  keyVersion: number;
  /** What Google granted; null = not recorded yet. */
  scopes: string[] | null;
}

export interface DriveGrantStore {
  loadGrant(userId: string): Promise<StoredDriveGrant | null>;
  /** The google_drive_full_read gate (on, or allowlist and listed). */
  flagAllows(userId: string): Promise<boolean>;
  /** Inserts a "started" read row; null when it couldn't be written. */
  auditStart(userId: string, fileId: string): Promise<number | null>;
  auditFinish(
    id: number,
    result: { outcome: DriveAuditOutcome; mimeType?: string | null; driveStatus?: number | null; bytes?: number | null },
  ): Promise<void>;
}

export interface DriveReader {
  /** The file as PDF bytes (Slides and Docs exported), read as the student. `ref` is google-drive.ts's GoogleFileRef. */
  readPdf(userId: string, ref: { id: string }): Promise<Uint8Array>;
}

export interface DriveReaderDeps {
  store: DriveGrantStore;
  fetch: FetchLike;
  clientId: string;
  clientSecret: string;
  decrypt(ciphertext: string): Promise<string>;
  /** Milliseconds since the epoch (tests pin it). */
  now?: () => number;
  maxBytes?: number;
}

/** A drive.ts error as what the student reads; transient errors pass through for a retry. */
export function driveAccessErrorFor(error: unknown): unknown {
  if (error instanceof DriveAuthError) return new DriveAccessError(DRIVE_COPY.needsSchoolAccount);
  if (error instanceof DriveNotFoundError) return new DriveAccessError(DRIVE_COPY.noAccess);
  if (error instanceof DriveAccessDeniedError) {
    return new DriveAccessError(error.reason === "admin_policy" ? DRIVE_COPY.blockedBySchool : DRIVE_COPY.noAccess);
  }
  if (error instanceof DriveUnreadableError) {
    if (error.reason === "no_download") return new DriveAccessError(DRIVE_COPY.noDownload);
    if (error.reason === "too_large") return new DriveAccessError(DRIVE_COPY.tooLarge);
    return new DriveAccessError(DRIVE_COPY.unsupported);
  }
  if (error instanceof DriveSetupError) {
    console.error("[polya] drive setup problem:", error.reason);
    return new DriveAccessError(DRIVE_COPY.unavailable);
  }
  return error;
}

/**
 * One reader per pump invocation: access tokens are refreshed at most once
 * per student and kept in memory only (the stored grant isn't rewritten).
 */
export function createDriveReader(deps: DriveReaderDeps): DriveReader {
  const now = deps.now ?? (() => Date.now());
  const clients = new Map<string, DriveClient>();

  async function clientFor(userId: string): Promise<DriveClient> {
    const existing = clients.get(userId);
    if (existing) return existing;

    // No grant, one sealed under a key this build doesn't hold, a narrower
    // grant (drive.file), or the gate closed: never reaches Google.
    const grant = await deps.store.loadGrant(userId);
    if (
      !grant ||
      grant.keyVersion !== CURRENT_KEY_VERSION ||
      (grant.scopes !== null && !grant.scopes.includes(DRIVE_READONLY_SCOPE)) ||
      !(await deps.store.flagAllows(userId))
    ) {
      throw new DriveAccessError(DRIVE_COPY.needsSchoolAccount);
    }
    if (!deps.clientId || !deps.clientSecret) {
      console.error("[polya] GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET not set");
      throw new DriveAccessError(DRIVE_COPY.unavailable);
    }

    const cachedCiphertext = grant.accessTokenCiphertext;
    const tokens = grantTokenSource({
      fetch: deps.fetch,
      credentials: { clientId: deps.clientId, clientSecret: deps.clientSecret },
      refreshToken: () => deps.decrypt(grant.refreshTokenCiphertext),
      cached: cachedCiphertext
        ? { expiresAt: grant.accessTokenExpiresAt, accessToken: () => deps.decrypt(cachedCiphertext) }
        : null,
      save: async () => {}, // kept in memory for this invocation only
      drop: async () => {}, // the student reconnects; the grant row is the connect flow's to replace
      now: () => new Date(now()),
    });
    const client = auditDriveClient(createDriveClient(deps.fetch, tokens), {
      start: ({ fileId }) => deps.store.auditStart(userId, fileId),
      finish: (id, result) => deps.store.auditFinish(id, result),
    });
    clients.set(userId, client);
    return client;
  }

  return {
    async readPdf(userId, ref) {
      const client = await clientFor(userId);
      try {
        const { bytes } = await client.fetchPdf(ref.id, { maxBytes: deps.maxBytes ?? MAX_GOOGLE_FILE_BYTES });
        return bytes;
      } catch (error) {
        throw driveAccessErrorFor(error);
      }
    },
  };
}
