import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyLink,
  crawlCourseSite,
  diffSiteSources,
  katexToTex,
  notebookRawUrl,
  notebookViewUrl,
  MAX_FILES_PER_PAGE,
  normalizeSiteUrl,
  pageMainText,
  planSiteSources,
  SiteUnreachableError,
  SiteUrlError,
  titleForLink,
  titleParts,
} from "../supabase/functions/_shared/course-site.ts";

// A small site shaped like ds100.org/fa26 (Berkeley Class Site template): the
// nav sits outside <main>, lecture pages link Google Slides, discussion pages
// link Drive worksheets/solutions, a past-exams table lists more PDFs than the
// per-page cap, and shared notes live on the same host outside /fa26/.
const START = "https://ds100.org/fa26/";

function page(title: string, h1: string, main: string): string {
  return `<!doctype html><html><head><title>${title} | Data 100</title></head><body>
<nav>
  <a href="/fa26/">Schedule</a> <a href="/fa26/syllabus/">Syllabus</a>
  <a href="/fa26/pastexams/">Past Exams</a> <a href="https://ds100.org/course-notes/">Course Notes</a>
  <a href="/">View all course offerings</a>
</nav>
<main><h1 class="title">${h1}</h1>${main}</main>
<footer><a href="https://github.com/just-the-docs/just-the-docs">Just the Docs</a></footer>
</body></html>`;
}

const exams = Array.from({ length: MAX_FILES_PER_PAGE + 5 }, (_, i) =>
  `<td><a href="/fa26/assets/exams/t${i}/t${i}_final.pdf">Exam</a> <a href="/fa26/assets/exams/t${i}/t${i}_final_sols.pdf">(Solutions)</a></td>`
).join("");

const SITE: Record<string, string> = {
  "https://ds100.org/fa26/": page(
    "Schedule",
    "Data 100: Principles and Techniques of Data Science",
    `<p>Week 7</p>
     <a href="/fa26/lectures/12/">Ordinary Least Squares Part I</a>
     <a href="https://ds100.org/course-notes/ols/">OLS Notes</a>
     <a href="/fa26/discussions/06/">Ordinary Least Squares</a>
     <a href="https://drive.google.com/file/d/1K-voW-utQJDzA2TPixJiHK5N33pBpQyx/view?usp=sharing">Prerequisite Math</a>
     <a href="https://data100.datahub.berkeley.edu/hub/user-redirect/git-pull?repo=x">Food Safety I</a>
     <a href="#week-8">Week 8</a> <a href="mailto:staff@berkeley.edu">Email</a>`,
  ),
  "https://ds100.org/fa26/lectures/12/": page(
    "Ordinary Least Squares Part I",
    "Lecture - Ordinary Least Squares Part I",
    `<p>Presented on October 6th, 2026</p>
     <a href="https://docs.google.com/presentation/d/1RdQ6GfThXsz4Pt6x05_eVIadIHld__5ArsSDLZn7E7A/edit?usp=sharing">Slides</a>
     <a href="https://youtu.be/IW1DjUDsrXw">YouTube Recording</a>`,
  ),
  "https://ds100.org/fa26/discussions/06/": page(
    "Ordinary Least Squares",
    "Discussion 6: Ordinary Least Squares",
    `<a href="https://drive.google.com/file/d/12_ezQIJ4qBywv2dC-Xn3tz5Uf9n973W3/view?usp=sharing">Worksheet</a>
     <a href="https://drive.google.com/file/d/1UaO7MAsaW8LGcFhB4ll-NL6ofb_wbvex/view?usp=sharing">Solutions</a>`,
  ),
  "https://ds100.org/fa26/syllabus/": page("Syllabus", "Syllabus", "<p>Grading: homework 20%.</p>"),
  "https://ds100.org/fa26/pastexams/": page("Past Exams", "Past Exams", `<table><tr>${exams}</tr></table>`),
};

async function fetchSite(url: string) {
  const html = SITE[url];
  return html ? { url, html } : null;
}

test("normalizeSiteUrl adds https and a trailing slash, drops hash and query", () => {
  assert.equal(normalizeSiteUrl("ds100.org/fa26"), "https://ds100.org/fa26/");
  assert.equal(normalizeSiteUrl("  https://DS100.org/fa26/#week-8 "), "https://ds100.org/fa26/");
  assert.equal(normalizeSiteUrl("http://ds100.org/fa26/index.html?x=1"), "https://ds100.org/fa26/");
  assert.equal(normalizeSiteUrl("https://example.edu/course/home.html"), "https://example.edu/course/home.html");
});

test("normalizeSiteUrl refuses private, IP, and odd-port addresses", () => {
  for (const bad of ["", "localhost/fa26", "https://10.0.0.1/x", "https://intranet/", "https://a.edu:8443/", "https://user:pw@a.edu/", "ftp://a.edu/"]) {
    assert.throws(() => normalizeSiteUrl(bad), SiteUrlError, bad);
  }
});

test("classifyLink sorts pages, hosted PDFs, Google files, and everything else", () => {
  assert.deepEqual(classifyLink("https://ds100.org/fa26/lectures/12/#top", START), {
    type: "page",
    url: "https://ds100.org/fa26/lectures/12/",
    inPrefix: true,
  });
  assert.deepEqual(classifyLink("https://ds100.org/course-notes/ols", START), {
    type: "page",
    url: "https://ds100.org/course-notes/ols/",
    inPrefix: false,
  });
  assert.deepEqual(classifyLink("http://ds100.org/fa26/assets/a.PDF", START), {
    type: "pdf",
    url: "https://ds100.org/fa26/assets/a.PDF",
  });
  assert.equal(classifyLink("https://ds100.org/", START).type, "skip"); // ancestor of the prefix
  assert.equal(classifyLink("https://ds100.org/fa26/assets/logo.png", START).type, "skip");
  assert.equal(classifyLink("https://youtu.be/IW1DjUDsrXw", START).type, "skip");
  // A PDF the course links counts wherever it's hosted; other hosts' pages don't.
  assert.deepEqual(classifyLink("http://inst.eecs.berkeley.edu/~ee16a/Note2A.pdf", START), {
    type: "pdf",
    url: "https://inst.eecs.berkeley.edu/~ee16a/Note2A.pdf",
  });
  assert.equal(classifyLink("https://inst.eecs.berkeley.edu/~ee16a/", START).type, "skip");
  const slides = classifyLink("https://docs.google.com/presentation/d/1RdQ6GfThXsz4Pt6x05_eVIadIHld__5ArsSDLZn7E7A/edit", START);
  assert.deepEqual(slides, { type: "google", ref: { kind: "slides", id: "1RdQ6GfThXsz4Pt6x05_eVIadIHld__5ArsSDLZn7E7A" } });
});

test("notebook links resolve to the raw file and back to a readable GitHub page", () => {
  const hub = "https://data100.datahub.berkeley.edu/hub/user-redirect/git-pull?repo=https%3A%2F%2Fgithub.com%2FDS-100%2Ffa26-student&branch=main&urlpath=lab%2Ftree%2Ffa26-student%2Fhw%2Fhw01%2Fhw01.ipynb";
  const raw = "https://raw.githubusercontent.com/DS-100/fa26-student/main/hw/hw01/hw01.ipynb";
  assert.equal(notebookRawUrl(hub), raw);
  assert.equal(notebookRawUrl("https://github.com/DS-100/fa26-student/blob/main/hw/hw01/hw01.ipynb"), raw);
  assert.equal(notebookRawUrl(raw), raw);
  assert.equal(notebookRawUrl("https://github.com/DS-100/fa26-student/tree/main/hw"), null);
  assert.equal(notebookRawUrl("https://example.edu/hw01.ipynb"), null);
  assert.equal(notebookViewUrl(raw), "https://github.com/DS-100/fa26-student/blob/main/hw/hw01/hw01.ipynb");
  assert.deepEqual(classifyLink(hub, START), { type: "notebook", rawUrl: raw });
});

test("titles: <title> splits into page and site parts; generic link text borrows the page title", () => {
  assert.deepEqual(titleParts("<title>Schedule | Data 100</title>"), { page: "Schedule", site: "Data 100" });
  assert.deepEqual(titleParts("<title>Home</title>"), { page: "Home", site: null });
  assert.equal(titleForLink("Slides", "Lecture 12", "x"), "Lecture 12 — Slides");
  assert.equal(titleForLink("SQL Review Slides", "Resources", "x"), "SQL Review Slides");
  assert.equal(titleForLink("", "Lecture 12", "x"), "Lecture 12");
});

test("pageMainText reads <main> only, without nav or footer", () => {
  const text = pageMainText(SITE["https://ds100.org/fa26/syllabus/"]!);
  assert.match(text, /Grading: homework 20%/);
  assert.doesNotMatch(text, /View all course offerings|Just the Docs/);
});

test("katexToTex keeps each formula's TeX once and drops the visual copy", () => {
  const html = `<p>Parameters <span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>θ</mi></mrow><annotation encoding="application/x-tex">\\theta</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base"><span class="strut"></span><span class="mord">θ</span></span></span></span> fit.</p>`;
  assert.equal(pageMainText(`<main>${html}</main>`), "Parameters $\\theta$ fit.");
  assert.equal(katexToTex("<p>no math</p>"), "<p>no math</p>");
});

test("crawlCourseSite follows in-prefix pages (nav included) and collects files", async () => {
  const crawl = await crawlCourseSite(START, fetchSite);
  assert.equal(crawl.courseName, "Data 100: Principles and Techniques of Data Science");

  const crawled = crawl.pages.filter((p) => p.crawled).map((p) => [p.url, p.title]);
  assert.deepEqual(crawled, [
    ["https://ds100.org/fa26/", "Schedule"],
    ["https://ds100.org/fa26/syllabus/", "Syllabus"],
    ["https://ds100.org/fa26/pastexams/", "Past Exams"],
    ["https://ds100.org/fa26/lectures/12/", "Lecture - Ordinary Least Squares Part I"],
    ["https://ds100.org/fa26/discussions/06/", "Discussion 6: Ordinary Least Squares"],
  ]);
  const leaves = crawl.pages.filter((p) => !p.crawled).map((p) => p.url).sort();
  assert.deepEqual(leaves, ["https://ds100.org/course-notes/", "https://ds100.org/course-notes/ols/"]);

  const google = crawl.googleFiles.map((f) => [f.ref.kind, f.title]);
  assert.deepEqual(google, [
    ["file", "Prerequisite Math"],
    ["slides", "Lecture - Ordinary Least Squares Part I — Slides"],
    ["file", "Discussion 6: Ordinary Least Squares — Worksheet"],
    ["file", "Discussion 6: Ordinary Least Squares — Solutions"],
  ]);

  // Capped per page, in page order (newest first on a past-exams table),
  // titled by file name since "Exam" / "(Solutions)" alone say nothing.
  assert.equal(crawl.files.length, MAX_FILES_PER_PAGE);
  assert.equal(crawl.files[0]!.title, "t0 final");
  assert.equal(crawl.files[1]!.title, "t0 final sols");
  assert.equal(crawl.files[0]!.pageTitle, "Past Exams");
});

test("crawlCourseSite picks up embedded Google files and notebooks", async () => {
  const site: Record<string, string> = {
    [START]: page("Schedule", "Data 100", `
      <a href="https://data100.datahub.berkeley.edu/hub/user-redirect/git-pull?repo=https://github.com/DS-100/fa26-student&subpath=lec/lec12/lec12.ipynb">Jupyter Notebook</a>
      <a href="https://github.com/DS-100/fa26-student/blob/main/hw/hw01/hw01.ipynb">Food Safety I</a>
      <iframe src="https://docs.google.com/presentation/d/1RdQ6GfThXsz4Pt6x05_eVIadIHld__5ArsSDLZn7E7A/embed?start=false"></iframe>`),
  };
  const crawl = await crawlCourseSite(START, async (url) => (site[url] ? { url, html: site[url]! } : null));
  assert.deepEqual(crawl.googleFiles.map((f) => [f.ref.kind, f.title]), [["slides", "Schedule"]]);
  assert.deepEqual(crawl.notebooks.map((n) => [n.rawUrl.split("/").pop(), n.title]), [
    ["lec12.ipynb", "Schedule — Jupyter Notebook"],
    ["hw01.ipynb", "Food Safety I"],
  ]);
  const rows = planSiteSources(crawl, "u", "c");
  const hw = rows.find((r) => r.title === "Food Safety I")!;
  assert.equal(hw.origin, "site_page");
  assert.equal(hw.canvas_id, "https://raw.githubusercontent.com/DS-100/fa26-student/main/hw/hw01/hw01.ipynb");
  assert.equal(hw.canvas_url, "https://github.com/DS-100/fa26-student/blob/main/hw/hw01/hw01.ipynb");
  assert.equal(hw.content_role, "assignment");
  assert.equal(rows.find((r) => r.title === "Schedule — Jupyter Notebook")!.content_role, "material");
});

test("crawlCourseSite skips what robots.txt disallows and stops at the time budget", async () => {
  const blocked = await crawlCourseSite(START, fetchSite, { allows: (url) => !url.includes("/pastexams/") });
  assert.ok(!blocked.pages.some((p) => p.url.includes("/pastexams/")));
  assert.equal(blocked.files.length, 0, "files on a disallowed page are never seen");

  let clock = 0;
  const timed = await crawlCourseSite(START, async (url) => {
    clock += 1000;
    return fetchSite(url);
  }, { deadline: 500, now: () => clock });
  assert.equal(timed.pages.filter((p) => p.crawled).length, 1, "the start page is always read");
  assert.equal(timed.truncated, true);
});

test("crawlCourseSite fails only when the start page can't be read", async () => {
  await assert.rejects(crawlCourseSite("https://nowhere.edu/c/", async () => null), SiteUnreachableError);
  const partial = await crawlCourseSite(START, async (url) => (url === START ? fetchSite(url) : null));
  assert.equal(partial.pages.filter((p) => p.crawled).length, 1);
});

test("planSiteSources orders by value, assigns roles, and keys sources stably", async () => {
  const rows = planSiteSources(await crawlCourseSite(START, fetchSite), "user-1", "course-1");
  // Crawled pages, then Google files, then same-host leaves, then hosted PDFs.
  const origins = rows.map((r) => r.origin);
  const lastGoogle = origins.lastIndexOf("drive_file");
  const firstHosted = origins.indexOf("site_file");
  const notes = rows.findIndex((r) => r.canvas_id === "https://ds100.org/course-notes/ols/");
  assert.equal(origins[0], "site_page");
  assert.ok(origins.indexOf("drive_file") > 0);
  assert.ok(lastGoogle < notes && notes < firstHosted);

  const syllabus = rows.find((r) => r.title === "Syllabus")!;
  assert.equal(syllabus.content_role, "syllabus");
  const solutions = rows.find((r) => r.title.endsWith("— Solutions"))!;
  assert.equal(solutions.content_role, "solution_key");
  assert.equal(solutions.canvas_id, "file:1UaO7MAsaW8LGcFhB4ll-NL6ofb_wbvex");
  assert.equal(solutions.canvas_url, "https://drive.google.com/file/d/1UaO7MAsaW8LGcFhB4ll-NL6ofb_wbvex/view");
  assert.equal(rows.find((r) => r.title === "t0 final sols")!.content_role, "solution_key");
  assert.equal(rows.find((r) => r.title === "t0 final")!.content_role, "material");

  for (const row of rows) {
    assert.equal(row.user_id, "user-1");
    assert.equal(row.course_id, "course-1");
    assert.equal(row.status, "queued");
    assert.ok(row.canvas_id, "every web source has a stable identity");
  }
  assert.equal(new Set(rows.map((r) => `${r.origin}:${r.canvas_id}`)).size, rows.length);
});

test("diffSiteSources: the scheduled check re-reads the site's own pages, adds new items, leaves files alone", async () => {
  const planned = planSiteSources(await crawlCourseSite(START, fetchSite), "u", "c");
  const existing = planned
    .filter((row) => row.title !== "Discussion 6: Ordinary Least Squares — Solutions") // posted since the last check
    .map((row, i) => ({
      id: `row-${i}`,
      origin: row.origin,
      canvas_id: row.canvas_id,
      canvas_updated_at: null,
      status: "ready",
      due_at: null,
      title: row.title,
      canvas_url: row.canvas_url,
    }));

  const auto = diffSiteSources(planned, existing, "auto", START);
  assert.deepEqual(auto.toInsert.map((row) => row.title), ["Discussion 6: Ordinary Least Squares — Solutions"]);
  const refreshed = new Set(auto.toRefresh.map((r) => existing.find((e) => e.id === r.id)!));
  assert.ok([...refreshed].every((row) => row.origin === "site_page" && row.canvas_id!.startsWith(START)));
  assert.equal(refreshed.size, planned.filter((r) => r.origin === "site_page" && r.canvas_id!.startsWith(START)).length);

  assert.equal(diffSiteSources(planned, existing, "new", START).toRefresh.length, 0);
  assert.equal(diffSiteSources(planned, existing, "force", START).toRefresh.length, existing.length);
});
