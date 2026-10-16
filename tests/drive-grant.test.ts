import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createDriveReader,
  DRIVE_COPY,
  DriveAccessError,
  type DriveAuditOutcome,
  type DriveGrantStore,
  GOOGLE_TOKEN_URL,
  type StoredDriveGrant,
} from "../supabase/functions/_shared/drive-grant.ts";
import { CURRENT_KEY_VERSION } from "../supabase/functions/_shared/token-crypto.ts";
import { TransientFetchError } from "../supabase/functions/_shared/safe-fetch.ts";
import { fetchSitePageText, fetchWebPdf, WebSourceError } from "../supabase/functions/_shared/web-sources.ts";

const PDF = new TextEncoder().encode("%PDF-1.7\n");
const NOW = Date.parse("2026-10-15T12:00:00Z");
const FILE = { kind: "file" as const, id: "1W6ecDCIjI_1K5xw2xsi1cPr20NvhGiin" };
const READONLY = "https://www.googleapis.com/auth/drive.readonly";

function grant(overrides: Partial<StoredDriveGrant> = {}): StoredDriveGrant {
  return {
    refreshTokenCiphertext: "enc:refresh",
    accessTokenCiphertext: "enc:cached-access",
    accessTokenExpiresAt: new Date(NOW + 30 * 60_000).toISOString(),
    keyVersion: CURRENT_KEY_VERSION,
    scopes: ["openid", READONLY],
    ...overrides,
  };
}

function memoryStore(opts: { grant?: StoredDriveGrant | null; allowed?: boolean; auditWorks?: boolean } = {}) {
  const audits: Array<{ id: number; fileId: string; outcome: DriveAuditOutcome | "started"; bytes?: number | null }> = [];
  const store: DriveGrantStore = {
    loadGrant: async () => (opts.grant === undefined ? grant() : opts.grant),
    flagAllows: async () => opts.allowed ?? true,
    auditStart: async (_userId, fileId) => {
      if (opts.auditWorks === false) return null;
      audits.push({ id: audits.length + 1, fileId, outcome: "started" });
      return audits.length;
    },
    auditFinish: async (id, result) => {
      Object.assign(audits[id - 1]!, { outcome: result.outcome, bytes: result.bytes ?? null });
    },
  };
  return { store, audits };
}

// Google's token endpoint + Drive API. `accepted` is the one access token Drive takes.
function google(opts: { accepted: string; refreshTo?: string | null; meta?: Record<string, unknown> }) {
  const calls: string[] = [];
  const fn = async (input: string, init?: RequestInit) => {
    calls.push(input);
    if (input === GOOGLE_TOKEN_URL) {
      assert.equal(init?.method, "POST");
      if (opts.refreshTo === null) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: opts.refreshTo ?? "fresh-access", expires_in: 3599 });
    }
    const auth = new Headers(init?.headers).get("Authorization");
    if (auth !== `Bearer ${opts.accepted}`) return Response.json({}, { status: 401 });
    const url = new URL(input);
    if (url.searchParams.get("alt") === "media") return new Response(PDF);
    if (opts.meta === undefined) return Response.json({ error: { errors: [{ reason: "notFound" }] } }, { status: 404 });
    return Response.json(opts.meta);
  };
  return { fn, calls };
}

const PDF_META = { id: FILE.id, name: "Sampling, Modeling.pdf", mimeType: "application/pdf" };

function reader(store: DriveGrantStore, fetchFn: (input: string, init?: RequestInit) => Promise<Response>) {
  return createDriveReader({
    store,
    fetch: fetchFn,
    clientId: "client-id",
    clientSecret: "client-secret",
    decrypt: async (ciphertext) => ciphertext.replace(/^enc:/, ""),
    now: () => NOW,
  });
}

test("a cached access token reads the file without a refresh, and the read is audited", async () => {
  const { store, audits } = memoryStore();
  const api = google({ accepted: "cached-access", meta: PDF_META });
  const bytes = await reader(store, api.fn).readPdf("user-1", FILE);
  assert.deepEqual(bytes, PDF);
  assert.ok(!api.calls.includes(GOOGLE_TOKEN_URL));
  assert.deepEqual(audits, [{ id: 1, fileId: FILE.id, outcome: "ok", bytes: PDF.byteLength }]);
});

test("an expired cache refreshes; a token Drive refuses is refreshed once and retried", async () => {
  const expired = memoryStore({ grant: grant({ accessTokenExpiresAt: new Date(NOW - 1000).toISOString() }) });
  const api = google({ accepted: "fresh-access", meta: PDF_META });
  assert.deepEqual(await reader(expired.store, api.fn).readPdf("user-1", FILE), PDF);
  assert.equal(api.calls.filter((u) => u === GOOGLE_TOKEN_URL).length, 1);

  // Cache looks valid but Google revoked it: 401 → one refresh → success.
  const stale = memoryStore();
  const api2 = google({ accepted: "fresh-access", meta: PDF_META });
  assert.deepEqual(await reader(stale.store, api2.fn).readPdf("user-1", FILE), PDF);
  assert.equal(api2.calls.filter((u) => u === GOOGLE_TOKEN_URL).length, 1);
  assert.equal(stale.audits[0]!.outcome, "ok");
});

test("no grant, the flag off, an old key, or a narrower scope never reaches Google", async () => {
  const cases = [
    memoryStore({ grant: null }),
    memoryStore({ allowed: false }),
    memoryStore({ grant: grant({ keyVersion: CURRENT_KEY_VERSION + 1 }) }),
    memoryStore({ grant: grant({ scopes: ["https://www.googleapis.com/auth/drive.file"] }) }),
  ];
  for (const { store, audits } of cases) {
    const api = google({ accepted: "cached-access", meta: PDF_META });
    await assert.rejects(
      reader(store, api.fn).readPdf("user-1", FILE),
      (e: unknown) => e instanceof DriveAccessError && e.message === DRIVE_COPY.needsSchoolAccount,
    );
    assert.equal(api.calls.length, 0);
    assert.equal(audits.length, 0);
  }
});

test("without an audit row there is no read (retried later)", async () => {
  const { store } = memoryStore({ auditWorks: false });
  const api = google({ accepted: "cached-access", meta: PDF_META });
  await assert.rejects(reader(store, api.fn).readPdf("user-1", FILE), TransientFetchError);
  assert.equal(api.calls.length, 0);
});

test("a revoked grant and a file the student can't see fail with plain messages", async () => {
  const revoked = memoryStore({ grant: grant({ accessTokenCiphertext: null }) });
  await assert.rejects(
    reader(revoked.store, google({ accepted: "x", refreshTo: null }).fn).readPdf("user-1", FILE),
    (e: unknown) => e instanceof DriveAccessError && e.message === DRIVE_COPY.needsSchoolAccount,
  );
  assert.equal(revoked.audits[0]!.outcome, "drive_auth");

  const hidden = memoryStore();
  await assert.rejects(
    reader(hidden.store, google({ accepted: "cached-access" }).fn).readPdf("user-1", FILE),
    (e: unknown) => e instanceof DriveAccessError && e.message === DRIVE_COPY.noAccess,
  );
  assert.equal(hidden.audits[0]!.outcome, "not_found");
});

// --- web-sources: the pump's fetch step ------------------------------------

test("fetchWebPdf tries the public export before the student's account", async () => {
  const open = async (input: string) =>
    new URL(input).hostname === "drive.usercontent.google.com" ? new Response(PDF) : new Response("", { status: 404 });
  let readerUsed = false;
  const neverReader = () => {
    readerUsed = true;
    throw new Error("should not need the student's account");
  };
  const source = { origin: "drive_file", canvas_id: `file:${FILE.id}`, canvas_url: null, user_id: "user-1" };
  assert.deepEqual(await fetchWebPdf(source, neverReader, open), PDF);
  assert.equal(readerUsed, false);

  const signIn = async () => new Response(null, { status: 302, headers: { Location: "https://accounts.google.com/signin" } });
  const asked: string[] = [];
  const studentReader = () => ({
    readPdf: async (userId: string, ref: { id: string }) => {
      asked.push(`${userId}:${ref.id}`);
      return PDF;
    },
  });
  assert.deepEqual(await fetchWebPdf(source, studentReader, signIn), PDF);
  assert.deepEqual(asked, [`user-1:${FILE.id}`]);
});

test("fetchWebPdf and fetchSitePageText turn dead links into plain messages", async () => {
  const site = async (input: string) => {
    const path = new URL(input).pathname;
    if (path === "/fa26/exam.pdf") return new Response("<html>moved</html>", { headers: { "Content-Type": "text/html" } });
    if (path === "/fa26/page/") {
      return new Response("<html><nav>Menu</nav><main><h1>Discussion 6</h1><p>Least squares.</p></main></html>", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return new Response("", { status: 404 });
  };
  const hosted = (url: string) => ({ origin: "site_file", canvas_id: url, canvas_url: url, user_id: "user-1" });
  const noReader = () => {
    throw new Error("unused");
  };
  await assert.rejects(fetchWebPdf(hosted("https://ds100.org/fa26/gone.pdf"), noReader, site), (e: unknown) =>
    e instanceof WebSourceError && /no longer on the course website/.test(e.message));
  await assert.rejects(fetchWebPdf(hosted("https://ds100.org/fa26/exam.pdf"), noReader, site), (e: unknown) =>
    e instanceof WebSourceError && /didn't lead to a PDF/.test(e.message));
  await assert.rejects(fetchWebPdf({ origin: "drive_file", canvas_id: "bogus", canvas_url: null, user_id: "u" }, noReader, site), WebSourceError);

  const notebook = JSON.stringify({
    cells: [
      { cell_type: "markdown", source: ["# Homework 1\n", "Find the mean of `x`."] },
      { cell_type: "code", source: "x.mean()", outputs: [{ data: { "image/png": "iVBORw0KGgo" } }] },
    ],
  });
  const nbFetch = async () => new Response(notebook, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const nbText = await fetchSitePageText("https://raw.githubusercontent.com/o/r/main/hw/hw01.ipynb", nbFetch);
  assert.match(nbText!, /Homework 1/);
  assert.match(nbText!, /x\.mean\(\)/);
  assert.doesNotMatch(nbText!, /iVBORw0KGgo/);

  const text = await fetchSitePageText("https://ds100.org/fa26/page/", site);
  assert.match(text!, /Discussion 6/);
  assert.doesNotMatch(text!, /Menu/);
  await assert.rejects(fetchSitePageText("https://ds100.org/fa26/missing/", site), WebSourceError);
});
