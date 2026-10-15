import { test } from "node:test";
import assert from "node:assert/strict";

import {
  auditDriveClient,
  auditOutcomeFor,
  CONNECT_CALLBACK_PATH,
  createDriveClient,
  downloadName,
  downloadPlan,
  DriveAccessDeniedError,
  type DriveAuditSink,
  DriveAuthError,
  driveError,
  driveLiteral,
  DriveNotFoundError,
  DriveSetupError,
  DriveTransientError,
  DriveUnreadableError,
  emailFromIdToken,
  exchangeCode,
  grantTokenSource,
  isConnectRedirectUri,
  parseDriveLink,
  parseScopes,
  refreshAccessToken,
  resourceKeyHeader,
  revokeToken,
  toDriveItem,
  TOKEN_URL,
} from "../supabase/functions/_shared/drive.ts";
import { TransientFetchError } from "../supabase/functions/_shared/safe-fetch.ts";
import { DRIVE_CALLBACK_PATH } from "../src/lib/google-drive-connect.ts";

const ID = "1W6ecDCIjI_1K5xw2xsi1cPr20NvhGiin";
const FOLDER = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n");
const CREDS = { clientId: "client-id", clientSecret: "client-secret" };

// --- links ------------------------------------------------------------------

test("parseDriveLink reads the Drive and Docs link shapes course sites use", () => {
  const cases: Array<[string, ReturnType<typeof parseDriveLink>]> = [
    [`https://drive.google.com/file/d/${ID}/view?usp=sharing`, { kind: "file", id: ID }],
    [`https://drive.google.com/file/d/${ID}/view?usp=drive_link`, { kind: "file", id: ID }],
    [`https://drive.google.com/file/u/1/d/${ID}/preview`, { kind: "file", id: ID }],
    [`https://drive.google.com/a/berkeley.edu/file/d/${ID}/view`, { kind: "file", id: ID }],
    [`https://drive.google.com/open?id=${ID}`, { kind: "file", id: ID }],
    [`https://drive.google.com/uc?export=download&id=${ID}`, { kind: "file", id: ID }],
    [`https://drive.usercontent.google.com/download?id=${ID}&export=download`, { kind: "file", id: ID }],
    [`https://drive.google.com/drive/folders/${FOLDER}?usp=sharing`, { kind: "folder", id: FOLDER }],
    [`https://drive.google.com/drive/u/0/folders/${FOLDER}`, { kind: "folder", id: FOLDER }],
    [`https://drive.google.com/drive/mobile/folders/${FOLDER}`, { kind: "folder", id: FOLDER }],
    [`https://drive.google.com/folderview?id=${FOLDER}`, { kind: "folder", id: FOLDER }],
    [`https://docs.google.com/presentation/d/${ID}/edit?usp=sharing`, { kind: "file", id: ID, docType: "presentation" }],
    [`https://docs.google.com/presentation/d/${ID}/edit#slide=id.p`, { kind: "file", id: ID, docType: "presentation" }],
    [`https://docs.google.com/document/u/1/d/${ID}/edit`, { kind: "file", id: ID, docType: "document" }],
    [`https://docs.google.com/a/berkeley.edu/document/d/${ID}/edit`, { kind: "file", id: ID, docType: "document" }],
    [`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`, { kind: "file", id: ID, docType: "spreadsheets" }],
    [`drive.google.com/file/d/${ID}/view`, { kind: "file", id: ID }],
    [`http://drive.google.com/file/d/${ID}/view`, { kind: "file", id: ID }],
  ];
  for (const [url, expected] of cases) assert.deepEqual(parseDriveLink(url), expected, url);
});

test("parseDriveLink keeps a resource key and decodes HTML-escaped ampersands", () => {
  assert.deepEqual(
    parseDriveLink(`https://drive.google.com/drive/folders/${FOLDER}?usp=sharing&amp;resourcekey=0-AbC_d-9`),
    { kind: "folder", id: FOLDER, resourceKey: "0-AbC_d-9" },
  );
  assert.equal(parseDriveLink(`https://drive.google.com/file/d/${ID}/view?resourcekey=bad key`)?.resourceKey, undefined);
});

test("parseDriveLink refuses published copies, Forms, short ids, other hosts, and junk", () => {
  for (const url of [
    `https://docs.google.com/presentation/d/e/2PACX-1vT${ID}/pub`,
    `https://docs.google.com/forms/d/${ID}/viewform`,
    "https://drive.google.com/file/d/short/view",
    "https://drive.google.com/drive/my-drive",
    `https://evil.example/file/d/${ID}/view`,
    `https://drive.google.com.evil.example/file/d/${ID}/view`,
    `javascript:alert('${ID}')`,
    "not a url",
    "",
  ]) {
    assert.equal(parseDriveLink(url), undefined, url);
  }
});

test("redirect URIs: Polya's callback path on https, or localhost http", () => {
  assert.equal(DRIVE_CALLBACK_PATH, CONNECT_CALLBACK_PATH, "web route and edge check agree");
  assert.ok(isConnectRedirectUri("https://askpolya.com/auth/google-drive/callback"));
  assert.ok(isConnectRedirectUri("http://localhost:3000/auth/google-drive/callback"));
  assert.ok(isConnectRedirectUri("http://127.0.0.1:3000/auth/google-drive/callback"));
  for (const bad of [
    "http://askpolya.com/auth/google-drive/callback",
    "https://askpolya.com/auth/callback",
    "https://askpolya.com/auth/google-drive/callback?x=1",
    "https://user@askpolya.com/auth/google-drive/callback",
    "https://intranet/auth/google-drive/callback",
    "chrome-extension://abc/auth/google-drive/callback",
    42,
  ]) {
    assert.equal(isConnectRedirectUri(bad), false, String(bad));
  }
});

// --- export mapping -------------------------------------------------------------

test("downloadPlan exports Google-native files and downloads the rest as-is", () => {
  const pdf = { action: "export", mimeType: "application/pdf", extension: ".pdf" };
  assert.deepEqual(downloadPlan("application/vnd.google-apps.document"), pdf);
  assert.deepEqual(downloadPlan("application/vnd.google-apps.presentation"), pdf);
  assert.deepEqual(downloadPlan("application/vnd.google-apps.drawing"), pdf);
  assert.deepEqual(downloadPlan("application/vnd.google-apps.spreadsheet"), {
    action: "export",
    mimeType: "text/csv",
    extension: ".csv",
  });
  assert.deepEqual(downloadPlan("application/vnd.google-apps.spreadsheet", "pdf"), pdf);
  assert.deepEqual(downloadPlan("application/pdf"), { action: "download" });
  assert.deepEqual(downloadPlan("application/x-ipynb+json"), { action: "download" });
  assert.deepEqual(downloadPlan("application/vnd.google-apps.folder"), { action: "folder" });
  assert.deepEqual(downloadPlan("application/vnd.google-apps.form"), { action: "unsupported" });
  assert.deepEqual(downloadPlan("application/vnd.google-apps.shortcut"), { action: "unsupported" });
});

test("downloadName adds the export's extension once", () => {
  const plan = downloadPlan("application/vnd.google-apps.presentation");
  assert.equal(downloadName("Lecture 5", plan), "Lecture 5.pdf");
  assert.equal(downloadName("Lecture 5.PDF", plan), "Lecture 5.PDF");
  assert.equal(downloadName("lab01.ipynb", { action: "download" }), "lab01.ipynb");
});

// --- errors -----------------------------------------------------------------

const reasons = (...list: string[]) => ({ error: { errors: list.map((reason) => ({ reason })) } });

test("driveError separates not found, no access, setup, and retryable failures", () => {
  assert.ok(driveError(401, null) instanceof DriveAuthError);
  assert.ok(driveError(404, reasons("notFound")) instanceof DriveNotFoundError);
  assert.ok(driveError(403, reasons("insufficientScopes")) instanceof DriveAuthError);
  assert.ok(driveError(403, reasons("appNotAuthorizedToFile")) instanceof DriveNotFoundError);
  assert.equal((driveError(403, reasons("insufficientFilePermissions")) as DriveAccessDeniedError).reason, "not_shared");
  assert.equal((driveError(403, reasons("domainPolicy")) as DriveAccessDeniedError).reason, "admin_policy");
  assert.equal((driveError(403, reasons("cannotDownloadFile")) as DriveUnreadableError).reason, "no_download");
  assert.equal((driveError(403, reasons("exportSizeLimitExceeded")) as DriveUnreadableError).reason, "too_large");
  assert.equal((driveError(403, reasons("accessNotConfigured")) as DriveSetupError).reason, "api_disabled");
  assert.equal(
    (driveError(403, { error: { details: [{ reason: "SERVICE_DISABLED" }] } }) as DriveSetupError).reason,
    "api_disabled",
  );
  const limited = driveError(403, reasons("userRateLimitExceeded"));
  assert.ok(limited instanceof TransientFetchError, "the pump retries it");
  assert.equal((driveError(503, null) as DriveTransientError).status, 503);
  assert.ok(driveError(429, null) instanceof DriveTransientError);
  assert.ok(driveError(403, "<html>") instanceof DriveAccessDeniedError, "unparseable 403 = no access");
  assert.ok(!driveError(400, null).message.includes("<"), "never echoes the body");
});

test("auditOutcomeFor maps errors onto google_drive_audit outcomes", () => {
  assert.deepEqual(auditOutcomeFor(new DriveNotFoundError()), { outcome: "not_found", driveStatus: 404 });
  assert.deepEqual(auditOutcomeFor(new DriveAuthError()), { outcome: "drive_auth", driveStatus: 401 });
  assert.deepEqual(auditOutcomeFor(new DriveUnreadableError("too_large")), { outcome: "too_large", driveStatus: null });
  assert.deepEqual(auditOutcomeFor(new DriveUnreadableError("no_download")), { outcome: "drive_http", driveStatus: 403 });
  assert.deepEqual(auditOutcomeFor(new DriveAccessDeniedError()), { outcome: "drive_http", driveStatus: 403 });
  assert.deepEqual(auditOutcomeFor(new DriveTransientError("x")), { outcome: "drive_unreachable", driveStatus: null });
  assert.deepEqual(auditOutcomeFor(new DriveTransientError("x", 503)), { outcome: "drive_http", driveStatus: 503 });
  assert.deepEqual(auditOutcomeFor(new Error("boom")), { outcome: "error", driveStatus: null });
});

// --- token endpoint -----------------------------------------------------------

function idToken(payload: Record<string, unknown>): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}

test("scopes and the ID token's email parse defensively", () => {
  assert.deepEqual(parseScopes("openid  https://www.googleapis.com/auth/drive.readonly"), [
    "openid",
    "https://www.googleapis.com/auth/drive.readonly",
  ]);
  assert.deepEqual(parseScopes(undefined), []);
  assert.equal(emailFromIdToken(idToken({ email: "oski@berkeley.edu" })), "oski@berkeley.edu");
  assert.equal(emailFromIdToken("not.a.jwt.at.all"), null);
  assert.equal(emailFromIdToken(idToken({})), null);
});

function tokenEndpoint(answer: () => Response) {
  const bodies: URLSearchParams[] = [];
  const fn = async (input: string, init?: RequestInit) => {
    assert.equal(input, TOKEN_URL);
    bodies.push(new URLSearchParams(String(init?.body)));
    return answer();
  };
  return { fn, bodies };
}

test("exchangeCode sends the PKCE verifier and returns the grant", async () => {
  const api = tokenEndpoint(() =>
    Response.json({
      access_token: "at",
      expires_in: 3599,
      refresh_token: "rt",
      scope: "openid email https://www.googleapis.com/auth/drive.readonly",
      id_token: idToken({ email: "oski@berkeley.edu" }),
    }));
  const grant = await exchangeCode(api.fn, CREDS, {
    code: "4/0Abc",
    codeVerifier: "v".repeat(43),
    redirectUri: "https://askpolya.com/auth/google-drive/callback",
  });
  assert.deepEqual(grant, {
    accessToken: "at",
    expiresIn: 3599,
    refreshToken: "rt",
    scopes: ["openid", "email", "https://www.googleapis.com/auth/drive.readonly"],
    email: "oski@berkeley.edu",
  });
  const sent = api.bodies[0]!;
  assert.equal(sent.get("grant_type"), "authorization_code");
  assert.equal(sent.get("code_verifier"), "v".repeat(43));
  assert.equal(sent.get("redirect_uri"), "https://askpolya.com/auth/google-drive/callback");
});

test("token endpoint failures: dead grant, bad client, retryable, and never the body", async () => {
  const answer = (status: number, body: unknown) => tokenEndpoint(() => Response.json(body, { status })).fn;
  await assert.rejects(refreshAccessToken(answer(400, { error: "invalid_grant" }), CREDS, "rt"), DriveAuthError);
  await assert.rejects(
    refreshAccessToken(answer(401, { error: "invalid_client" }), CREDS, "rt"),
    (e: unknown) => e instanceof DriveSetupError && e.reason === "client",
  );
  await assert.rejects(refreshAccessToken(answer(503, {}), CREDS, "rt"), DriveTransientError);
  await assert.rejects(
    refreshAccessToken(answer(400, { error: "invalid_request", error_description: "secret-ish rt" }), CREDS, "rt"),
    (e: unknown) => e instanceof Error && !e.message.includes("secret-ish"),
  );
  const offline = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(refreshAccessToken(offline, CREDS, "rt"), DriveTransientError);
  assert.equal(await revokeToken(offline, "rt"), false);
  assert.equal(await revokeToken(async () => new Response("", { status: 200 }), "rt"), true);
});

// --- Drive reads --------------------------------------------------------------

test("helpers: query literals and resource-key headers", () => {
  assert.equal(driveLiteral("a'b\\c"), "'a\\'b\\\\c'");
  assert.equal(resourceKeyHeader([["id1", "k1"], ["id2", undefined]]), "id1/k1");
  assert.equal(resourceKeyHeader([["id2", undefined]]), null);
});

test("toDriveItem resolves shortcuts and parses sizes", () => {
  const item = toDriveItem(
    { id: ID, name: "Lab 1/2", mimeType: "application/pdf", size: "2048", capabilities: { canDownload: false } },
    "Week 1",
    FOLDER,
  );
  assert.deepEqual(item, {
    id: ID,
    name: "Lab 1/2",
    path: "Week 1/Lab 1_2",
    parentId: FOLDER,
    mimeType: "application/pdf",
    isFolder: false,
    size: 2048,
    canDownload: false,
  });
  const shortcut = toDriveItem(
    {
      id: "shortcut0000001",
      name: "Notes",
      mimeType: "application/vnd.google-apps.shortcut",
      shortcutDetails: { targetId: FOLDER, targetMimeType: "application/vnd.google-apps.folder", targetResourceKey: "0-k" },
    },
    "",
  );
  assert.deepEqual(shortcut, {
    id: FOLDER,
    name: "Notes",
    path: "Notes",
    mimeType: "application/vnd.google-apps.folder",
    isFolder: true,
    shortcutId: "shortcut0000001",
    resourceKey: "0-k",
  });
  assert.equal(toDriveItem({ id: "bad id!", name: "x" }, ""), null);
});

type Handler = (url: URL, headers: Headers) => Response | undefined;

function drive(handler: Handler) {
  const calls: Array<{ url: string; auth: string | null; keys: string | null }> = [];
  const fn = async (input: string, init?: RequestInit) => {
    assert.equal(init?.method ?? "GET", "GET", "every Drive call is a read");
    const headers = new Headers(init?.headers);
    calls.push({ url: input, auth: headers.get("Authorization"), keys: headers.get("X-Goog-Drive-Resource-Keys") });
    return handler(new URL(input), headers) ??
      Response.json({ error: { errors: [{ reason: "notFound" }] } }, { status: 404 });
  };
  return { fn, calls };
}

const meta = (id: string, mimeType: string, extra: Record<string, unknown> = {}) =>
  Response.json({ id, name: `name-${id.slice(0, 4)}`, mimeType, modifiedTime: "2026-10-01T00:00:00Z", ...extra });

test("listFolder pages through results, recurses once per folder, and follows folder shortcuts", async () => {
  const SUB = "1SubFolderSubFolder0000000000000";
  const api = drive((url) => {
    const fileMatch = url.pathname.match(/\/files\/([^/]+)$/);
    if (fileMatch) return fileMatch[1] === FOLDER ? meta(FOLDER, "application/vnd.google-apps.folder") : undefined;
    const q = url.searchParams.get("q") ?? "";
    assert.equal(url.searchParams.get("supportsAllDrives"), "true");
    assert.equal(url.searchParams.get("includeItemsFromAllDrives"), "true");
    if (q.includes(FOLDER) && !url.searchParams.get("pageToken")) {
      return Response.json({
        nextPageToken: "p2",
        files: [{ id: SUB, name: "Week 1", mimeType: "application/vnd.google-apps.folder" }],
      });
    }
    if (q.includes(FOLDER)) {
      return Response.json({
        files: [
          { id: ID, name: "Syllabus", mimeType: "application/vnd.google-apps.document" },
          // A shortcut back to the root: listed, but not walked again.
          {
            id: "shortcutToRoot01",
            name: "Home",
            mimeType: "application/vnd.google-apps.shortcut",
            shortcutDetails: { targetId: FOLDER, targetMimeType: "application/vnd.google-apps.folder" },
          },
        ],
      });
    }
    if (q.includes(SUB)) {
      return Response.json({ files: [{ id: "1LabFileLabFile00000000000", name: "lab01.ipynb", mimeType: "application/x-ipynb+json", size: "512" }] });
    }
  });
  const client = createDriveClient(api.fn, "tok");

  const top = await client.listFolder(FOLDER);
  assert.deepEqual(top.map((i) => i.path), ["Week 1", "Syllabus", "Home"]);

  const all = await client.listFolder(FOLDER, { recursive: true });
  assert.deepEqual(all.map((i) => i.path), ["Week 1", "Syllabus", "Home", "Week 1/lab01.ipynb"]);
  assert.equal(all[3]!.parentId, SUB);
  await assert.rejects(client.listFolder(FOLDER, { recursive: true, maxItems: 2 }), DriveUnreadableError);
});

test("fetchFile exports Slides to PDF, Sheets to CSV, downloads the rest, and caps size", async () => {
  const DECK = "1DeckDeckDeckDeckDeck000000000";
  const SHEET = "1SheetSheetSheetSheet000000000";
  const BIG = "1BigBigBigBigBigBigBig00000000";
  const api = drive((url) => {
    const m = url.pathname.match(/\/files\/([^/]+)(\/export)?$/);
    if (!m) return undefined;
    const [, id, exporting] = m;
    if (exporting) {
      return id === DECK && url.searchParams.get("mimeType") === "application/pdf"
        ? new Response(PDF)
        : id === SHEET && url.searchParams.get("mimeType") === "text/csv"
        ? new Response("a,b\n1,2\n")
        : undefined;
    }
    if (url.searchParams.get("alt") === "media") return id === ID ? new Response(PDF) : new Response("x".repeat(64));
    if (id === DECK) return meta(DECK, "application/vnd.google-apps.presentation");
    if (id === SHEET) return meta(SHEET, "application/vnd.google-apps.spreadsheet");
    if (id === ID) return meta(ID, "application/pdf", { size: String(PDF.byteLength) });
    if (id === BIG) return meta(BIG, "application/pdf", { size: "999999999" });
    if (id === FOLDER) return meta(FOLDER, "application/vnd.google-apps.folder");
  });
  const client = createDriveClient(api.fn, "tok");

  const deck = await client.fetchFile(DECK);
  assert.equal(deck.exportedAs, "application/pdf");
  assert.equal(deck.fileName, `name-${DECK.slice(0, 4)}.pdf`);
  assert.deepEqual(deck.data, PDF);

  const sheet = await client.fetchFile(SHEET);
  assert.equal(sheet.exportedAs, "text/csv");
  assert.equal(new TextDecoder().decode(sheet.data), "a,b\n1,2\n");

  const pdf = await client.fetchFile(ID);
  assert.equal(pdf.exportedAs, undefined);
  assert.equal(pdf.modifiedTime, "2026-10-01T00:00:00Z");

  const before = api.calls.length;
  await assert.rejects(
    client.fetchFile(BIG, { maxBytes: 1024 }),
    (e: unknown) => e instanceof DriveUnreadableError && e.reason === "too_large",
  );
  assert.equal(api.calls.length, before + 1, "declared size over the cap: no download");

  await assert.rejects(client.fetchFile("1MissingMissing000000000000"), DriveNotFoundError);
  await assert.rejects(client.fetchFile(FOLDER), DriveUnreadableError);
});

test("an oversized Slides export falls back to the Docs export link with the same token", async () => {
  const DECK = "1HugeDeckHugeDeck0000000000000";
  const exportLink = `https://docs.google.com/feeds/download/presentations/Export?id=${DECK}&exportFormat=pdf`;
  const api = drive((url) => {
    if (url.hostname === "docs.google.com") return new Response(PDF);
    if (url.pathname.endsWith("/export")) {
      return Response.json({ error: { errors: [{ reason: "exportSizeLimitExceeded" }] } }, { status: 403 });
    }
    return meta(DECK, "application/vnd.google-apps.presentation", { exportLinks: { "application/pdf": exportLink } });
  });
  const file = await createDriveClient(api.fn, "tok").fetchFile(DECK);
  assert.deepEqual(file.data, PDF);
  assert.equal(api.calls.at(-1)!.url, exportLink);
  assert.equal(api.calls.at(-1)!.auth, "Bearer tok");
});

test("resource keys travel in the header, and a 401 refreshes once", async () => {
  let refreshes = 0;
  const api = drive((url, headers) => {
    if (headers.get("Authorization") !== "Bearer fresh") return new Response("", { status: 401 });
    return meta(ID, "application/pdf");
  });
  const client = createDriveClient(api.fn, async ({ forceRefresh }) => {
    if (forceRefresh) refreshes++;
    return forceRefresh ? "fresh" : "stale";
  });
  const item = await client.stat(ID, { resourceKey: "0-key" });
  assert.equal(item.id, ID);
  assert.equal(refreshes, 1);
  assert.equal(api.calls[0]!.keys, `${ID}/0-key`);

  // A fixed token gets no second chance.
  await assert.rejects(createDriveClient(api.fn, "stale").stat(ID), DriveAuthError);
});

// --- grant token source + audit -------------------------------------------------

test("grantTokenSource uses the cache, refreshes once at a time, and drops a dead grant", async () => {
  const now = new Date("2026-10-15T12:00:00Z");
  let refreshCalls = 0;
  const saved: string[] = [];
  let dropped = 0;
  const fetchFn = async () => {
    refreshCalls++;
    return Response.json({ access_token: `fresh-${refreshCalls}`, expires_in: 3600 });
  };
  const deps = {
    fetch: fetchFn,
    credentials: CREDS,
    refreshToken: async () => "rt",
    save: async (_grant: unknown, expiresAt: string) => {
      saved.push(expiresAt);
    },
    drop: async () => {
      dropped++;
    },
    now: () => now,
  };

  const cached = grantTokenSource({
    ...deps,
    cached: { expiresAt: "2026-10-15T12:30:00Z", accessToken: async () => "cached" },
  });
  assert.equal(await cached({ forceRefresh: false }), "cached");
  assert.equal(refreshCalls, 0);
  // Two callers at once after a 401 share one refresh.
  const [a, b] = await Promise.all([cached({ forceRefresh: true }), cached({ forceRefresh: true })]);
  assert.equal(a, "fresh-1");
  assert.equal(b, "fresh-1");
  assert.equal(refreshCalls, 1);
  assert.deepEqual(saved, ["2026-10-15T13:00:00.000Z"]);
  assert.equal(await cached({ forceRefresh: false }), "fresh-1", "the refreshed token is reused");

  const nearlyExpired = grantTokenSource({
    ...deps,
    cached: { expiresAt: "2026-10-15T12:00:30Z", accessToken: async () => "cached" },
  });
  assert.equal(await nearlyExpired({ forceRefresh: false }), "fresh-2", "under a minute left: refresh");

  const dead = grantTokenSource({
    ...deps,
    fetch: async () => Response.json({ error: "invalid_grant" }, { status: 400 }),
  });
  await assert.rejects(dead({ forceRefresh: false }), DriveAuthError);
  assert.equal(dropped, 1);
});

function memorySink(opts: { works?: boolean } = {}) {
  const rows: Array<{ action: string; fileId: string; outcome: string; bytes: number | null }> = [];
  const sink: DriveAuditSink = {
    start: async ({ action, fileId }) => {
      if (opts.works === false) return null;
      rows.push({ action, fileId, outcome: "started", bytes: null });
      return rows.length;
    },
    finish: async (id, result) => {
      Object.assign(rows[id - 1]!, { outcome: result.outcome, bytes: result.bytes });
    },
  };
  return { sink, rows };
}

test("auditDriveClient writes a row before each read and fails closed without one", async () => {
  const api = drive((url) => {
    if (url.searchParams.get("alt") === "media") return new Response(PDF);
    return url.pathname.endsWith(ID) ? meta(ID, "application/pdf") : undefined;
  });
  const { sink, rows } = memorySink();
  const client = auditDriveClient(createDriveClient(api.fn, "tok"), sink);
  await client.fetchFile(ID);
  await assert.rejects(client.fetchPdf("1MissingMissing000000000000"), DriveNotFoundError);
  await client.stat(ID);
  assert.deepEqual(rows, [
    { action: "read", fileId: ID, outcome: "ok", bytes: PDF.byteLength },
    { action: "read", fileId: "1MissingMissing000000000000", outcome: "not_found", bytes: null },
  ]);

  const closed = memorySink({ works: false });
  const calls = api.calls.length;
  await assert.rejects(auditDriveClient(createDriveClient(api.fn, "tok"), closed.sink).fetchFile(ID), TransientFetchError);
  assert.equal(api.calls.length, calls, "no audit row, no read");
  await assert.rejects(client.fetchFile("not a drive id"), DriveNotFoundError);
});
