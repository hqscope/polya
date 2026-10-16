import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { CookieJar, GradescopeClient, GradescopeError } from "../agent/lib/gradescope/client.ts";
import {
  classifyFlashError,
  isLoginPage,
  normalizeStatus,
  parseAccountCourses,
  parseCourseAssignments,
  parseCsrfToken,
  parseFlashError,
  parseGradescopeDate,
  parseLoginAuthenticityToken,
} from "../agent/lib/gradescope/parse.ts";
import { selectRelevantAssignments } from "../agent/lib/gradescope/store.ts";
import type { GsAssignment } from "../agent/lib/gradescope/types.ts";
import { open, seal, secretKey } from "../agent/lib/secret-box.ts";

// Fixtures follow the selectors Lectra (GradescopeHTMLParser.swift) and nyuoss/gradescope-api
// read. They are minimal, not captured pages: real-page drift is not covered here.

const HOME_HTML = `<!DOCTYPE html><html><head>
<meta name="csrf-param" content="authenticity_token" />
<meta name="csrf-token" content="csrf-home-123" />
</head><body>
<form class="search" action="/search"><input type="hidden" name="authenticity_token" value="not-this-one"></form>
<form id="login-form" action="/login" accept-charset="UTF-8" method="post">
  <input name="utf8" type="hidden" value="&#x2713;" />
  <input type="hidden" name="authenticity_token" value="login+token/abc==" />
  <input type="email" name="session[email]" id="session_email" />
  <input type="password" name="session[password]" id="session_password" />
  <input type="submit" name="commit" value="Log In" />
</form></body></html>`;

const LOGIN_FAILED_HTML = `<html><body>
<div class="alert alert-flashMessage alert-error"><button class="alert--close">&times;</button><span>Invalid email/password combination.</span></div>
<form action="/login" method="post"><input type="password" name="session[password]" /></form>
</body></html>`;

const ACCOUNT_HTML = `<html><head><meta name="csrf-token" content="csrf-account-456" /></head><body>
<a href="/logout">Log Out</a>
<div id="account-show">
  <h1 class="pageHeading">Your Courses</h1>
  <button class="js-createNewCourse">Create Course</button>
  <h2 class="pageHeading">Instructor Courses</h2>
  <div class="courseList">
    <div class="courseList--term pageSubheading">Fall 2026</div>
    <div class="courseList--coursesForTerm">
      <a class="courseBox" href="/courses/900001">
        <h3 class="courseBox--shortname">DATA C88C</h3>
        <div class="courseBox--name">Computational Structures in Data Science</div>
        <div class="courseBox--assignments">4 assignments</div>
      </a>
    </div>
  </div>
  <h2 class="pageHeading">Student Courses</h2>
  <div class="courseList">
    <div class="courseList--term pageSubheading">Fall 2026</div>
    <div class="courseList--coursesForTerm">
      <a class="courseBox" href="/courses/123456">
        <h3 class="courseBox--shortname">CS 61B</h3>
        <div class="courseBox--name">Data Structures &amp; Algorithms</div>
        <div class="courseBox--assignments">12 assignments</div>
      </a>
      <a class="courseBox" href="/courses/234567">
        <h3 class="courseBox--shortname">MCB 104</h3>
        <div class="courseBox--name">Genetics, Genomics, and Cell Biology</div>
      </a>
    </div>
    <div class="courseList--term pageSubheading">Spring 2026</div>
    <div class="courseList--coursesForTerm">
      <a class="courseBox" href="/courses/111111">
        <h3 class="courseBox--shortname">STAT 134</h3>
        <div class="courseBox--name">Concepts of Probability</div>
      </a>
    </div>
  </div>
</div></body></html>`;

const STUDENT_ONLY_ACCOUNT_HTML = `<div id="account-show">
  <div class="courseList"><div class="courseList--term">Fall 2026</div>
  <a class="courseBox" href="/courses/555"><h3 class="courseBox--shortname">MATH 53</h3><div class="courseBox--name"></div></a>
  </div></div>`;

const STUDENT_COURSE_HTML = `<html><head><title>CS 61B Course Dashboard | Gradescope</title></head><body>
<h1 class="courseHeader--title">CS 61B</h1>
<table id="assignments-student-table" class="table">
<thead><tr role="row"><th>Name</th><th>Status</th><th>Released</th><th>Due (PDT)</th></tr></thead>
<tbody>
<tr role="row" class="odd">
  <th class="table--primaryLink" role="rowheader" scope="row"><a aria-label="View Homework 1" href="/courses/123456/assignments/7000001/submissions/8000001">Homework 1</a></th>
  <td class="submissionStatus"><div class="submissionStatus--score">8.5 / 10.0</div></td>
  <td class="hidden-column"><div class="submissionTimeChart">
    <time class="submissionTimeChart--releaseDate" datetime="2026-09-01 00:00:00 -0700">Sep 01</time>
    <time class="submissionTimeChart--dueDate" datetime="2026-09-08 23:59:00 -0700">Sep 08 at 11:59PM</time>
  </div></td>
</tr>
<tr role="row" class="even">
  <th class="table--primaryLink" role="rowheader" scope="row"><a href="/courses/123456/assignments/7000002/submissions/8000002">Project 1: Deques</a></th>
  <td class="submissionStatus"><div class="submissionStatus--text">Submitted</div></td>
  <td class="hidden-column"><time class="submissionTimeChart--releaseDate" datetime="2026-10-01 00:00:00 -0700">Oct 01</time>
  <time class="submissionTimeChart--dueDate" datetime="2026-10-14 23:59:00 -0700">Due</time></td>
</tr>
<tr role="row" class="odd">
  <th class="table--primaryLink" role="rowheader" scope="row"><button class="js-submitAssignment" data-assignment-id="7000003" data-post-url="/courses/123456/assignments/7000003/submissions" type="button">Lab 7 &amp; Quiz</button></th>
  <td class="submissionStatus submissionStatus-warning"><div class="submissionStatus--text">No Submission</div></td>
  <td class="hidden-column"><div class="submissionTimeChart"><div class="progressBar--caption">
    <time class="submissionTimeChart--releaseDate" datetime="2026-10-10 00:00:00 -0700">Oct 10</time>
    <time class="submissionTimeChart--dueDate" datetime="2026-10-17 23:59:00 -0700">Due Date: Oct 17 at 11:59PM</time><br>
    <time class="submissionTimeChart--dueDate" datetime="2026-10-19 23:59:00 -0700">Late Due Date: Oct 19 at 11:59PM</time>
  </div></div></td>
</tr>
<tr role="row" class="even">
  <th class="table--primaryLink" role="rowheader" scope="row">Closed Worksheet</th>
  <td class="submissionStatus"><div class="submissionStatus--text">No Submission</div></td>
  <td class="hidden-column"><time class="submissionTimeChart--dueDate" datetime="2026-09-01 23:59:00 -0700">Sep 01</time></td>
</tr>
</tbody></table></body></html>`;

const INSTRUCTOR_PROPS = {
  table_data: [
    { type: "section", title: "Week 1" },
    {
      type: "assignment",
      title: "Midterm 1",
      url: "/courses/900001/assignments/6000001",
      total_points: "50.0",
      submission_window: {
        release_date: "2026-10-01T09:00:00.000000-07:00",
        due_date: "2026-10-20T23:59:00.000000-07:00",
        hard_due_date: null,
      },
    },
  ],
};
const INSTRUCTOR_COURSE_HTML = `<div data-react-class="AssignmentsTable" data-react-props="${JSON.stringify(INSTRUCTOR_PROPS)
  .replace(/&/g, "&amp;")
  .replace(/"/g, "&quot;")}"></div>`;

describe("gradescope parse: login and tokens", () => {
  it("reads the login form's authenticity token, not another form's", () => {
    assert.equal(parseLoginAuthenticityToken(HOME_HTML), "login+token/abc==");
  });

  it("reads the csrf meta tag", () => {
    assert.equal(parseCsrfToken(HOME_HTML), "csrf-home-123");
    assert.equal(parseCsrfToken("<html></html>"), null);
  });

  it("reads and classifies flash errors", () => {
    const flash = parseFlashError(LOGIN_FAILED_HTML);
    assert.equal(flash, "Invalid email/password combination.");
    assert.equal(classifyFlashError(flash ?? ""), "invalid_credentials");
    assert.equal(classifyFlashError("Your school requires single sign-on. Please log in with your school credentials."), "sso_required");
    assert.equal(classifyFlashError("Something else went wrong"), "other");
    assert.equal(parseFlashError(ACCOUNT_HTML), null);
  });

  it("tells login pages from signed-in pages", () => {
    assert.equal(isLoginPage(HOME_HTML), true);
    assert.equal(isLoginPage(ACCOUNT_HTML), false);
  });
});

describe("gradescope parse: account courses", () => {
  it("splits instructor and student courses and keeps the term", () => {
    const courses = parseAccountCourses(ACCOUNT_HTML);
    assert.deepEqual(
      courses.map((c) => [c.course_id, c.short_name, c.role, c.term]),
      [
        ["900001", "DATA C88C", "instructor", "Fall 2026"],
        ["123456", "CS 61B", "student", "Fall 2026"],
        ["234567", "MCB 104", "student", "Fall 2026"],
        ["111111", "STAT 134", "student", "Spring 2026"],
      ],
    );
    assert.equal(courses[1]?.name, "Data Structures & Algorithms");
  });

  it("treats an account without headings or Create Course as all-student", () => {
    assert.deepEqual(parseAccountCourses(STUDENT_ONLY_ACCOUNT_HTML), [
      { course_id: "555", short_name: "MATH 53", name: "MATH 53", term: "Fall 2026", role: "student" },
    ]);
  });
});

describe("gradescope parse: course assignments", () => {
  it("parses the student table: score, submitted, open with late due date", () => {
    const rows = parseCourseAssignments(STUDENT_COURSE_HTML, { courseId: "123456" });
    assert.equal(rows.length, 3, "header row and the closed row without an id are skipped");
    assert.deepEqual(rows[0], {
      course_id: "123456",
      course_name: "CS 61B",
      assignment_id: "7000001",
      title: "Homework 1",
      due_at: "2026-09-09T06:59:00.000Z",
      late_due_at: null,
      status: "graded",
      score: "8.5 / 10.0",
      url: "https://www.gradescope.com/courses/123456/assignments/7000001/submissions/8000001",
    });
    assert.equal(rows[1]?.status, "submitted");
    assert.equal(rows[1]?.title, "Project 1: Deques");
    assert.deepEqual(rows[2], {
      course_id: "123456",
      course_name: "CS 61B",
      assignment_id: "7000003",
      title: "Lab 7 & Quiz",
      due_at: "2026-10-18T06:59:00.000Z",
      late_due_at: "2026-10-20T06:59:00.000Z",
      status: "not_submitted",
      score: null,
      url: "https://www.gradescope.com/courses/123456/assignments/7000003",
    });
  });

  it("uses the caller's course name when given", () => {
    const rows = parseCourseAssignments(STUDENT_COURSE_HTML, { courseId: "123456", courseName: "CS 61B (Fall)" });
    assert.equal(rows[0]?.course_name, "CS 61B (Fall)");
  });

  it("parses the instructor React table and skips non-assignment rows", () => {
    const rows = parseCourseAssignments(INSTRUCTOR_COURSE_HTML, { courseId: "900001", courseName: "DATA C88C" });
    assert.deepEqual(rows, [
      {
        course_id: "900001",
        course_name: "DATA C88C",
        assignment_id: "6000001",
        title: "Midterm 1",
        due_at: "2026-10-21T06:59:00.000Z",
        late_due_at: null,
        status: "unknown",
        score: null,
        url: "https://www.gradescope.com/courses/900001/assignments/6000001",
      },
    ]);
  });

  it("returns an empty list for a course with no assignments", () => {
    assert.deepEqual(parseCourseAssignments("<table><tr role=\"row\"><th>Name</th></tr></table>", { courseId: "1" }), []);
  });
});

describe("gradescope parse: dates and statuses", () => {
  it("converts Gradescope date formats to UTC", () => {
    assert.equal(parseGradescopeDate("2026-10-17 23:59:00 -0700"), "2026-10-18T06:59:00.000Z");
    assert.equal(parseGradescopeDate("2026-10-17T23:59:00-07:00"), "2026-10-18T06:59:00.000Z");
    assert.equal(parseGradescopeDate("2026-12-01 09:00:00 +0000"), "2026-12-01T09:00:00.000Z");
    assert.equal(parseGradescopeDate(null), null);
    assert.equal(parseGradescopeDate("not a date"), null);
  });

  it("reads offset-less dates in the given zone, across DST", () => {
    assert.equal(parseGradescopeDate("2026-10-17 23:59", "America/Los_Angeles"), "2026-10-18T06:59:00.000Z");
    assert.equal(parseGradescopeDate("2026-12-17 23:59", "America/Los_Angeles"), "2026-12-18T07:59:00.000Z");
    assert.equal(parseGradescopeDate("2026-12-17 23:59"), "2026-12-17T23:59:00.000Z");
  });

  it("normalizes status text", () => {
    assert.deepEqual(normalizeStatus("10.0 / 10.0"), { status: "graded", score: "10.0 / 10.0" });
    assert.deepEqual(normalizeStatus("Submitted"), { status: "submitted", score: null });
    assert.deepEqual(normalizeStatus("Submitted Late"), { status: "submitted", score: null });
    assert.deepEqual(normalizeStatus("No Submission"), { status: "not_submitted", score: null });
    assert.deepEqual(normalizeStatus("Graded"), { status: "graded", score: null });
    assert.deepEqual(normalizeStatus(""), { status: "unknown", score: null });
  });
});

describe("selectRelevantAssignments", () => {
  const base: Omit<GsAssignment, "assignment_id" | "due_at" | "late_due_at"> = {
    course_id: "1",
    course_name: "CS 61B",
    title: "x",
    status: "not_submitted",
    score: null,
    url: "https://www.gradescope.com/courses/1",
  };
  const a = (id: string, due: string | null, late: string | null = null): GsAssignment => ({
    ...base,
    assignment_id: id,
    due_at: due,
    late_due_at: late,
  });

  it("keeps recent and upcoming items, soonest first, and drops undated or far ones", () => {
    const now = new Date("2026-10-15T12:00:00Z");
    const picked = selectRelevantAssignments(
      [
        a("far-future", "2027-03-01T00:00:00Z"),
        a("next-week", "2026-10-22T00:00:00Z"),
        a("old", "2026-08-01T00:00:00Z"),
        a("old-but-late-open", "2026-09-20T00:00:00Z", "2026-10-05T00:00:00Z"),
        a("undated", null),
        a("tomorrow", "2026-10-16T00:00:00Z"),
      ],
      now,
    );
    assert.deepEqual(
      picked.map((x) => x.assignment_id),
      ["old-but-late-open", "tomorrow", "next-week"],
    );
  });
});

describe("secret-box", () => {
  const key = randomBytes(32);

  it("round-trips and uses a fresh IV each time", () => {
    const a = seal("signed_token=abc; remember_me=def", key);
    const b = seal("signed_token=abc; remember_me=def", key);
    assert.notEqual(a, b);
    assert.ok(a.startsWith("v1."));
    assert.ok(!a.includes("signed_token"));
    assert.equal(open(a, key), "signed_token=abc; remember_me=def");
  });

  it("rejects a wrong key and tampered data", () => {
    const sealed = seal("hunter2", key);
    assert.throws(() => open(sealed, randomBytes(32)), /failed authentication/);
    const parts = sealed.split(".");
    const data = Buffer.from(parts[3] ?? "", "base64url");
    data[0] = (data[0] ?? 0) ^ 1;
    parts[3] = data.toString("base64url");
    assert.throws(() => open(parts.join("."), key), /failed authentication/);
    assert.throws(() => open("garbage", key), /Unrecognized/);
  });

  it("validates the env key", () => {
    assert.equal(secretKey(randomBytes(32).toString("base64")).length, 32);
    assert.throws(() => secretKey(randomBytes(16).toString("base64")), /32 bytes/);
    assert.throws(() => secretKey(""), /not set/);
  });
});

describe("CookieJar", () => {
  const www = new URL("https://www.gradescope.com/login");

  it("stores host-only and domain cookies and sends them where they apply", () => {
    const jar = new CookieJar();
    jar.setFromHeader("_gradescope_session=s1; path=/; secure; HttpOnly; SameSite=Lax", www);
    jar.setFromHeader("signed_token=t1; domain=.gradescope.com; path=/; expires=Wed, 01 Jan 2031 00:00:00 GMT; secure", www);
    jar.setFromHeader("evil=1; domain=example.com; path=/", www);
    assert.equal(jar.headerFor(new URL("https://www.gradescope.com/account")), "_gradescope_session=s1; signed_token=t1");
    assert.equal(jar.headerFor(new URL("https://static.gradescope.com/x")), "signed_token=t1");
    assert.equal(jar.headerFor(new URL("http://www.gradescope.com/account")), "", "secure cookies stay off http");
    assert.equal(jar.has("evil"), false);
  });

  it("respects paths, replaces values, and deletes on Max-Age=0 or past expiry", () => {
    let now = Date.parse("2026-10-15T00:00:00Z");
    const jar = new CookieJar([], () => now);
    jar.setFromHeader("a=1; path=/courses", www);
    jar.setFromHeader("b=1; Max-Age=60", www);
    assert.equal(jar.headerFor(new URL("https://www.gradescope.com/account")), "b=1");
    assert.equal(jar.headerFor(new URL("https://www.gradescope.com/courses/1")), "a=1; b=1");
    jar.setFromHeader("a=2; path=/courses", www);
    assert.equal(jar.headerFor(new URL("https://www.gradescope.com/courses/1")), "a=2; b=1");
    jar.setFromHeader("a=; path=/courses; Max-Age=0", www);
    assert.equal(jar.headerFor(new URL("https://www.gradescope.com/courses/1")), "b=1");
    now += 61_000;
    assert.equal(jar.headerFor(new URL("https://www.gradescope.com/courses/1")), "");
    jar.setFromHeader("c=1; expires=Thu, 01 Jan 2015 00:00:00 GMT", www);
    assert.equal(jar.has("c"), false);
  });

  it("imports a pasted Cookie header and lets server cookies replace it", () => {
    const jar = CookieJar.fromCookieHeader("Cookie: signed_token=t1; remember_me=r1; _gradescope_session=old");
    assert.equal(jar.headerFor(new URL("https://www.gradescope.com/account")), "signed_token=t1; remember_me=r1; _gradescope_session=old");
    jar.setFromHeader("_gradescope_session=new; path=/; secure", new URL("https://www.gradescope.com/account"));
    assert.equal(jar.headerFor(new URL("https://www.gradescope.com/account")), "signed_token=t1; remember_me=r1; _gradescope_session=new");
    assert.equal(jar.list().filter((c) => c.name === "_gradescope_session").length, 1);
  });
});

// --- Client against a fake fetch -------------------------------------------------------------

interface Seen {
  method: string;
  path: string;
  cookie: string | null;
  body: string | null;
}

function fakeGradescope(routes: Record<string, (req: Request) => Response>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.text() : null;
    seen.push({ method: req.method, path: url.pathname, cookie: req.headers.get("cookie"), body });
    const handler = routes[`${req.method} ${url.pathname}`];
    return handler ? handler(req) : new Response("not found", { status: 404 });
  };
  return { fetch: fakeFetch as typeof fetch, seen };
}

function html(body: string, setCookies: string[] = [], status = 200, location?: string): Response {
  const headers = new Headers();
  for (const c of setCookies) headers.append("set-cookie", c);
  if (location) headers.set("location", location);
  return new Response(status >= 300 && status < 400 ? null : body, { status, headers });
}

describe("GradescopeClient", () => {
  it("logs in with a password, follows the redirect, and reuses the account page", async () => {
    const { fetch, seen } = fakeGradescope({
      "GET /": () => html(HOME_HTML, ["_gradescope_session=pre; path=/; secure; HttpOnly"]),
      "POST /login": () =>
        html("", ["_gradescope_session=post; path=/; secure; HttpOnly", "signed_token=tok; path=/; secure; HttpOnly"], 302, "https://www.gradescope.com/account"),
      "GET /account": () => html(ACCOUNT_HTML),
      "GET /courses/123456": () => html(STUDENT_COURSE_HTML),
    });
    const client = new GradescopeClient({ fetch, minIntervalMs: 0 });
    await client.loginWithPassword(" student@berkeley.edu ", "pw");

    const post = seen.find((s) => s.method === "POST");
    const form = new URLSearchParams(post?.body ?? "");
    assert.equal(form.get("authenticity_token"), "login+token/abc==");
    assert.equal(form.get("session[email]"), "student@berkeley.edu");
    assert.equal(post?.cookie, "_gradescope_session=pre");
    // The 302's cookies reach the follow-up GET /account, and that page counts as verification.
    assert.deepEqual(seen.map((s) => `${s.method} ${s.path}`), ["GET /", "POST /login", "GET /account"]);
    assert.equal(seen.at(-1)?.cookie, "_gradescope_session=post; signed_token=tok");

    const before = seen.length;
    const courses = await client.listCourses();
    assert.equal(seen.length, before, "listCourses reuses the /account page verify() just loaded");
    assert.equal(courses.filter((c) => c.role === "student").length, 3);

    const assignments = await client.listAssignments("123456", courses[1]);
    assert.equal(assignments.length, 3);
    assert.equal(assignments[0]?.course_name, "CS 61B");

    const session = client.exportSession();
    assert.deepEqual(session.cookies.map((c) => c.name).sort(), ["_gradescope_session", "signed_token"]);
    assert.equal(session.csrf_token, "csrf-account-456");

    const restored = GradescopeClient.fromSession(session, { fetch, minIntervalMs: 0 });
    assert.equal(await restored.verify(), true);
    assert.equal(seen.at(-1)?.cookie, "_gradescope_session=post; signed_token=tok");
  });

  it("reports a rejected password as invalid_credentials", async () => {
    const { fetch } = fakeGradescope({
      "GET /": () => html(HOME_HTML),
      "POST /login": () => html(LOGIN_FAILED_HTML),
    });
    const client = new GradescopeClient({ fetch, minIntervalMs: 0 });
    await assert.rejects(client.loginWithPassword("a@b.edu", "wrong"), (error: unknown) => {
      assert.ok(error instanceof GradescopeError);
      assert.equal(error.code, "invalid_credentials");
      assert.ok(!error.message.includes("wrong"), "the password never appears in errors");
      return true;
    });
  });

  it("treats a redirect to the login page as a signed-out session", async () => {
    const { fetch } = fakeGradescope({
      "GET /account": () => html("", [], 302, "/login"),
      "GET /login": () => html(HOME_HTML),
    });
    const client = GradescopeClient.fromSessionCookies("signed_token=stale; _gradescope_session=stale", { fetch, minIntervalMs: 0 });
    assert.equal(await client.verify(), false);
    await assert.rejects(client.listCourses(), (e: unknown) => e instanceof GradescopeError && e.code === "session_expired");
  });

  it("does not follow redirects off Gradescope", async () => {
    const { fetch, seen } = fakeGradescope({
      "GET /account": () => html("", [], 302, "https://sso.example.edu/login"),
    });
    const client = GradescopeClient.fromSessionCookies("_gradescope_session=x", { fetch, minIntervalMs: 0 });
    assert.equal(await client.verify(), false);
    assert.equal(seen.length, 1);
  });
});
