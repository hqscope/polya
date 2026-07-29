// Mock Canvas REST routing over the recorded payloads in fixtures/canvas-api.
// Used two ways: stubbed into globalThis.fetch by the contract test, and served
// from a real Node http server by scripts/integration/run-import-integration.ts.
// `state` lets a test mutate a page (body + updated_at) to exercise re-import.
import { readFileSync } from "node:fs";

const FIXTURES = new URL("../../fixtures/canvas-api/", import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), "utf8");
}

export interface MockCanvasState {
  /** HTML body served for the week-6-overview page. */
  pageBody: string;
  /** updated_at reported for week-6-overview in the pages listing. */
  pageUpdatedAt: string;
  /** Bytes served for PDF downloads (integration server only). */
  pdfBytes: Uint8Array | null;
}

export function defaultState(): MockCanvasState {
  return {
    pageBody:
      "<h2>Week 6 — Cellular Respiration</h2><p>This week covers glycolysis, the Krebs cycle, and the electron transport chain. Focus on where each stage happens and what each stage produces.</p>",
    pageUpdatedAt: "2026-07-03T08:00:00Z",
    pdfBytes: null,
  };
}

export interface MockResponse {
  status: number;
  body: string | Uint8Array;
  contentType: string;
  headers?: Record<string, string>;
}

const COURSE = "1549777";

// Route a request path (with query) to a canned response. `base` is the mock
// server's own origin, used to build absolute Link headers.
export function routeCanvas(
  pathWithQuery: string,
  base: string,
  state: MockCanvasState,
): MockResponse | null {
  const url = new URL(pathWithQuery, "http://mock.invalid");
  const path = url.pathname;
  const json = (body: string, headers?: Record<string, string>): MockResponse => ({
    status: 200,
    body,
    contentType: "application/json",
    headers,
  });

  if (path === "/api/v1/users/self") return json(fixture("self.json"));
  if (path === "/api/v1/courses") return json(fixture("courses.json"));
  if (path === `/api/v1/courses/${COURSE}`) return json(fixture("course-detail.json"));
  if (path === `/api/v1/courses/${COURSE}/folders`) return json(fixture("folders.json"));

  if (path === `/api/v1/courses/${COURSE}/files`) {
    if (url.searchParams.get("page") === "2") return json(fixture("files-page2.json"));
    return json(fixture("files-page1.json"), {
      Link: `<${base}/api/v1/courses/${COURSE}/files?per_page=100&page=2>; rel="next"`,
    });
  }

  if (path === `/api/v1/courses/${COURSE}/pages`) {
    const pages = JSON.parse(fixture("pages.json")) as Array<{ url: string; updated_at?: string }>;
    for (const page of pages) {
      if (page.url === "week-6-overview") page.updated_at = state.pageUpdatedAt;
    }
    return json(JSON.stringify(pages));
  }
  if (path === `/api/v1/courses/${COURSE}/pages/week-6-overview`) {
    return json(JSON.stringify({ body: state.pageBody }));
  }
  if (path === `/api/v1/courses/${COURSE}/pages/module-only-page`) {
    return json(
      JSON.stringify({
        body: "<p>This page only appears in the module navigation. It reviews fermentation pathways and when cells fall back to them.</p>",
      }),
    );
  }

  if (path === `/api/v1/courses/${COURSE}/assignments`) return json(fixture("assignments.json"));
  if (path === `/api/v1/courses/${COURSE}/modules`) return json(fixture("modules.json"));

  const fileMeta = path.match(/^\/api\/v1\/(?:courses\/\d+\/)?files\/(\d+)$/);
  if (fileMeta) {
    const files = [
      ...(JSON.parse(fixture("files-page1.json")) as Array<Record<string, unknown>>),
      ...(JSON.parse(fixture("files-page2.json")) as Array<Record<string, unknown>>),
    ];
    const match = files.find((file) => String(file.id) === fileMeta[1]);
    return match ? json(JSON.stringify(match)) : { status: 404, body: "{}", contentType: "application/json" };
  }

  if (/^\/files\/\d+\/download$/.test(path)) {
    if (!state.pdfBytes) return { status: 404, body: "no pdf bytes configured", contentType: "text/plain" };
    return { status: 200, body: state.pdfBytes, contentType: "application/pdf" };
  }

  return null;
}
