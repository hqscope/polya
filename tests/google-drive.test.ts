import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DriveNotFoundError,
  DriveUnreadableError,
  fetchDrivePdfWithToken,
  fetchPublicGooglePdf,
  googleSourceKey,
  googleViewUrl,
  parseGoogleFileLink,
  parseGoogleSourceKey,
  publicExportUrl,
} from "../supabase/functions/_shared/google-drive.ts";
import {
  fetchPublic,
  ResponseTooLargeError,
  TransientFetchError,
  UnsafeUrlError,
} from "../supabase/functions/_shared/safe-fetch.ts";

const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n");
const ID = "12_ezQIJ4qBywv2dC-Xn3tz5Uf9n973W3";

type Route = (url: URL, init?: RequestInit) => Response | undefined;

// A fetch that answers from `route`, recording each URL asked for.
function fakeFetch(route: Route) {
  const calls: string[] = [];
  const fn = async (input: string, init?: RequestInit) => {
    calls.push(input);
    return route(new URL(input), init) ?? new Response("not found", { status: 404 });
  };
  return { fn, calls };
}

function redirect(to: string): Response {
  return new Response(null, { status: 302, headers: { Location: to } });
}

test("parseGoogleFileLink recognizes Drive files, Slides, and Docs — not folders or published copies", () => {
  assert.deepEqual(parseGoogleFileLink(`https://drive.google.com/file/d/${ID}/view?usp=sharing`), { kind: "file", id: ID });
  assert.deepEqual(parseGoogleFileLink(`https://drive.google.com/open?id=${ID}`), { kind: "file", id: ID });
  assert.deepEqual(parseGoogleFileLink(`https://drive.google.com/uc?export=download&id=${ID}`), { kind: "file", id: ID });
  assert.deepEqual(parseGoogleFileLink(`https://docs.google.com/presentation/d/${ID}/edit#slide=id.p`), { kind: "slides", id: ID });
  assert.deepEqual(parseGoogleFileLink(`https://docs.google.com/document/u/1/d/${ID}/edit`), { kind: "doc", id: ID });
  assert.equal(parseGoogleFileLink(`https://docs.google.com/presentation/d/e/2PACX-1vT${ID}/pub`), null);
  assert.equal(parseGoogleFileLink(`https://drive.google.com/drive/folders/${ID}`), null);
  assert.equal(parseGoogleFileLink(`https://docs.google.com/spreadsheets/d/${ID}/edit`), null);
  assert.equal(parseGoogleFileLink("https://drive.google.com/file/d/short/view"), null);
  assert.equal(parseGoogleFileLink("not a url"), null);
});

test("source keys round-trip and view/export URLs match the file kind", () => {
  const ref = { kind: "slides" as const, id: ID };
  assert.equal(googleSourceKey(ref), `slides:${ID}`);
  assert.deepEqual(parseGoogleSourceKey(`slides:${ID}`), ref);
  assert.equal(parseGoogleSourceKey("sheet:abc"), null);
  assert.equal(parseGoogleSourceKey(null), null);
  assert.equal(googleViewUrl(ref), `https://docs.google.com/presentation/d/${ID}/edit`);
  assert.equal(publicExportUrl(ref), `https://docs.google.com/presentation/d/${ID}/export/pdf`);
  assert.match(publicExportUrl({ kind: "file", id: ID }), /drive\.usercontent\.google\.com\/download\?id=.*&confirm=t/);
});

test("fetchPublicGooglePdf returns bytes for a shared-with-anyone file", async () => {
  const { fn } = fakeFetch((url) => {
    if (url.hostname === "drive.usercontent.google.com") return new Response(PDF, { headers: { "Content-Type": "application/octet-stream" } });
  });
  const bytes = await fetchPublicGooglePdf(fn, { kind: "file", id: ID });
  assert.deepEqual(bytes, PDF);
});

test("fetchPublicGooglePdf returns null when Google wants a sign-in", async () => {
  // School-only file: the export redirects to the account chooser.
  const signIn = fakeFetch((url) => {
    if (url.hostname === "drive.usercontent.google.com") return redirect("https://accounts.google.com/v3/signin/identifier?continue=x");
  });
  assert.equal(await fetchPublicGooglePdf(signIn.fn, { kind: "file", id: ID }), null);
  assert.ok(!signIn.calls.some((u) => u.includes("accounts.google.com")), "never follows into the sign-in page");

  // Or it serves an HTML page with a 200.
  const html = fakeFetch(() => new Response("<!doctype html><html>", { headers: { "Content-Type": "text/html" } }));
  assert.equal(await fetchPublicGooglePdf(html.fn, { kind: "slides", id: ID }), null);
});

test("fetchPublic follows public redirects, refuses private hops, and caps the body", async () => {
  const hop = fakeFetch((url) => {
    if (url.pathname === "/a") return redirect("/b");
    if (url.pathname === "/b") return new Response("ok", { headers: { "Content-Type": "text/plain" } });
  });
  const ok = await fetchPublic(hop.fn, "https://site.edu/a", { maxBytes: 10 });
  assert.equal(ok.url, "https://site.edu/b");
  assert.equal(new TextDecoder().decode(ok.bytes), "ok");

  const toPrivate = fakeFetch(() => redirect("https://169.254.169.254/latest/meta-data"));
  await assert.rejects(fetchPublic(toPrivate.fn, "https://site.edu/a", { maxBytes: 10 }), UnsafeUrlError);
  await assert.rejects(fetchPublic(hop.fn, "http://site.edu/a", { maxBytes: 10 }), UnsafeUrlError);

  const big = fakeFetch(() => new Response("x".repeat(100)));
  await assert.rejects(fetchPublic(big.fn, "https://site.edu/a", { maxBytes: 10 }), ResponseTooLargeError);

  const busy = fakeFetch(() => new Response("slow down", { status: 429 }));
  await assert.rejects(fetchPublic(busy.fn, "https://site.edu/a", { maxBytes: 10 }), TransientFetchError);

  const gone = await fetchPublic(fakeFetch(() => undefined).fn, "https://site.edu/a", { maxBytes: 10 });
  assert.equal(gone.status, 404);
});

function driveApi(meta: Record<string, Record<string, unknown>>, files: Record<string, Response | (() => Response)>) {
  return fakeFetch((url, init) => {
    assert.equal(init?.method ?? "GET", "GET", "every Drive call is a read");
    assert.match(String(new Headers(init?.headers).get("Authorization")), /^Bearer /);
    const match = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)(\/export)?$/);
    if (!match) return undefined;
    const id = decodeURIComponent(match[1]!);
    if (match[2] || url.searchParams.get("alt") === "media") {
      const body = files[`${id}${match[2] ? ":export" : ":media"}`];
      return typeof body === "function" ? body() : body;
    }
    const m = meta[id];
    return m ? Response.json(m) : Response.json({ error: { errors: [{ reason: "notFound" }] } }, { status: 404 });
  });
}

test("fetchDrivePdfWithToken downloads PDFs and exports Slides as PDF", async () => {
  const api = driveApi(
    {
      pdf1aaaaaaaa: { id: "pdf1aaaaaaaa", name: "Worksheet.pdf", mimeType: "application/pdf" },
      deck1aaaaaaa: { id: "deck1aaaaaaa", name: "Lecture 12", mimeType: "application/vnd.google-apps.presentation" },
    },
    { "pdf1aaaaaaaa:media": () => new Response(PDF), "deck1aaaaaaa:export": () => new Response(PDF) },
  );
  const pdf = await fetchDrivePdfWithToken(api.fn, "tok", { kind: "file", id: "pdf1aaaaaaaa" });
  assert.deepEqual(pdf.bytes, PDF);
  const deck = await fetchDrivePdfWithToken(api.fn, "tok", { kind: "slides", id: "deck1aaaaaaa" });
  assert.equal(deck.meta.name, "Lecture 12");
  assert.ok(api.calls.some((u) => u.includes("/deck1aaaaaaa/export?mimeType=application%2Fpdf")));
});

test("fetchDrivePdfWithToken follows a shortcut once and maps Drive refusals", async () => {
  const api = driveApi(
    {
      short1aaaaaa: { id: "short1aaaaaa", mimeType: "application/vnd.google-apps.shortcut", shortcutDetails: { targetId: "pdf1aaaaaaaa" } },
      pdf1aaaaaaaa: { id: "pdf1aaaaaaaa", name: "Real.pdf", mimeType: "application/pdf" },
      sheet1aaaaaa: { id: "sheet1aaaaaa", mimeType: "application/vnd.google-apps.spreadsheet" },
      locked1aaaaa: { id: "locked1aaaaa", mimeType: "application/pdf" },
    },
    {
      "pdf1aaaaaaaa:media": () => new Response(PDF),
      "locked1aaaaa:media": () => Response.json({ error: { errors: [{ reason: "cannotDownloadFile" }] } }, { status: 403 }),
    },
  );
  assert.equal((await fetchDrivePdfWithToken(api.fn, "tok", { kind: "file", id: "short1aaaaaa" })).meta.name, "Real.pdf");
  await assert.rejects(fetchDrivePdfWithToken(api.fn, "tok", { kind: "file", id: "missing1aaaa" }), DriveNotFoundError);
  await assert.rejects(
    fetchDrivePdfWithToken(api.fn, "tok", { kind: "file", id: "sheet1aaaaaa" }),
    (e: unknown) => e instanceof DriveUnreadableError && e.reason === "unsupported",
  );
  await assert.rejects(
    fetchDrivePdfWithToken(api.fn, "tok", { kind: "file", id: "locked1aaaaa" }),
    (e: unknown) => e instanceof DriveUnreadableError && e.reason === "no_download",
  );
});
