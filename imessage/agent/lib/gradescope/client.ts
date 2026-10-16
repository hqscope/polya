// Gradescope over plain HTTP, the way a browser uses it: a cookie jar, the login form, and the
// account and course pages. Gradescope has no public API; Noel chose this approach knowingly.
// Ported from Lectra's GradescopeHTTPClient/AuthService/CatalogService (Swift, June 2026) and
// nyuoss/gradescope-api. Polite by construction: one request at a time per client, a minimum gap
// between requests, a timeout, and an identifying User-Agent.
import {
  classifyFlashError,
  GRADESCOPE_BASE_URL,
  isLoginPage,
  parseAccountCourses,
  parseCourseAssignments,
  parseCsrfToken,
  parseFlashError,
  parseLoginAuthenticityToken,
} from "./parse.ts";
import type { GsAssignment, GsCookie, GsCourse, GsSession } from "./types.ts";

export type GradescopeErrorCode =
  | "invalid_credentials"
  | "sso_required"
  | "session_expired"
  | "login_failed"
  | "missing_token"
  | "http"
  | "network";

export class GradescopeError extends Error {
  readonly code: GradescopeErrorCode;
  constructor(code: GradescopeErrorCode, message: string) {
    super(message);
    this.name = "GradescopeError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// Cookie jar (RFC 6265, the parts Gradescope needs). A domain starting with "." matches the
// domain and its subdomains; one without matches only that host.

function domainMatches(cookieDomain: string, host: string): boolean {
  if (cookieDomain.startsWith(".")) {
    const bare = cookieDomain.slice(1);
    return host === bare || host.endsWith(cookieDomain);
  }
  return host === cookieDomain;
}

function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function defaultPath(requestPath: string): string {
  if (!requestPath.startsWith("/")) return "/";
  const lastSlash = requestPath.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : requestPath.slice(0, lastSlash);
}

export class CookieJar {
  private cookies: GsCookie[] = [];
  private readonly now: () => number;

  constructor(cookies: readonly GsCookie[] = [], now: () => number = Date.now) {
    this.now = now;
    for (const cookie of cookies) this.put(cookie);
  }

  private put(cookie: GsCookie): void {
    this.cookies = this.cookies.filter(
      (c) => !(c.name === cookie.name && c.path === cookie.path && c.domain === cookie.domain),
    );
    if (cookie.expires_at !== null && cookie.expires_at <= this.now()) return;
    this.cookies.push({ ...cookie });
  }

  /** Applies one Set-Cookie header received from `url`. */
  setFromHeader(header: string, url: URL): void {
    const [pair = "", ...attrParts] = header.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) return;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const host = url.hostname.toLowerCase();

    let domain = host;
    let path = defaultPath(url.pathname);
    let expiresAt: number | null = null;
    let maxAge: number | null = null;
    let secure = false;
    let httpOnly = false;
    for (const part of attrParts) {
      const i = part.indexOf("=");
      const key = (i < 0 ? part : part.slice(0, i)).trim().toLowerCase();
      const val = i < 0 ? "" : part.slice(i + 1).trim();
      if (key === "domain" && val) {
        const d = val.toLowerCase().replace(/^\./, "");
        if (host !== d && !host.endsWith(`.${d}`)) return; // a cookie for another site: reject
        domain = `.${d}`;
      } else if (key === "path" && val.startsWith("/")) path = val;
      else if (key === "expires") {
        const t = Date.parse(val);
        if (!Number.isNaN(t)) expiresAt = t;
      } else if (key === "max-age") {
        const n = Number.parseInt(val, 10);
        if (Number.isFinite(n)) maxAge = n;
      } else if (key === "secure") secure = true;
      else if (key === "httponly") httpOnly = true;
    }
    if (maxAge !== null) expiresAt = this.now() + maxAge * 1000;

    // A server-set cookie replaces an imported one of the same name that this host would send,
    // so a pasted ".gradescope.com" cookie and a fresh host-only one never go out together.
    this.cookies = this.cookies.filter(
      (c) => !(c.name === name && c.path === path && domainMatches(c.domain, host)),
    );
    this.put({ name, value, domain, path, expires_at: expiresAt, secure, http_only: httpOnly });
  }

  /** The Cookie header value for a request to `url`, or "" when nothing applies. */
  headerFor(url: URL): string {
    const host = url.hostname.toLowerCase();
    const now = this.now();
    this.cookies = this.cookies.filter((c) => c.expires_at === null || c.expires_at > now);
    return this.cookies
      .filter((c) => domainMatches(c.domain, host) && pathMatches(c.path, url.pathname || "/"))
      .filter((c) => !c.secure || url.protocol === "https:")
      .sort((a, b) => b.path.length - a.path.length)
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  has(name: string): boolean {
    return this.cookies.some((c) => c.name === name);
  }

  list(): GsCookie[] {
    const now = this.now();
    return this.cookies.filter((c) => c.expires_at === null || c.expires_at > now).map((c) => ({ ...c }));
  }

  clear(): void {
    this.cookies = [];
  }

  /**
   * Cookies from a pasted `Cookie:` header ("signed_token=...; remember_me=...;
   * _gradescope_session=..."), scoped to `.gradescope.com`.
   */
  static fromCookieHeader(header: string, domain = ".gradescope.com"): CookieJar {
    const jar = new CookieJar();
    const body = header.trim().replace(/^cookie:\s*/i, "");
    for (const part of body.split(";")) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (!name || !value) continue;
      jar.put({ name, value, domain, path: "/", expires_at: null, secure: true, http_only: true });
    }
    return jar;
  }
}

// ---------------------------------------------------------------------------------------------
// Client

export interface GradescopeClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  userAgent?: string;
  /** Per request, including redirects. Default 20 s. */
  timeoutMs?: number;
  /** Minimum gap between requests. Default 400 ms. */
  minIntervalMs?: number;
  now?: () => number;
}

interface PageResponse {
  status: number;
  url: URL;
  html: string;
}

const DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; PolyaAssistant/0.1; +https://askpolya.com)";
const MAX_REDIRECTS = 6;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GradescopeClient {
  readonly baseUrl: URL;
  private jar: CookieJar;
  private csrfToken: string | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  /** /account HTML from the last verify(), reused once by listCourses() to save a request. */
  private accountHtml: string | null = null;

  constructor(options: GradescopeClientOptions = {}, jar?: CookieJar) {
    this.baseUrl = new URL(options.baseUrl ?? GRADESCOPE_BASE_URL);
    this.fetchImpl = options.fetch ?? fetch;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.minIntervalMs = options.minIntervalMs ?? 400;
    this.now = options.now ?? Date.now;
    this.jar = jar ?? new CookieJar([], this.now);
  }

  /** Restores a session saved with exportSession(). */
  static fromSession(session: GsSession, options: GradescopeClientOptions = {}): GradescopeClient {
    const client = new GradescopeClient(options, new CookieJar(session.cookies, options.now ?? Date.now));
    client.csrfToken = session.csrf_token;
    return client;
  }

  /**
   * For SSO accounts (e.g. CalNet) with no Gradescope password: a `Cookie` header copied from a
   * signed-in browser (signed_token / remember_me / _gradescope_session), or saved cookies.
   * Call verify() before trusting it.
   */
  static fromSessionCookies(cookies: string | readonly GsCookie[], options: GradescopeClientOptions = {}): GradescopeClient {
    const now = options.now ?? Date.now;
    const jar = typeof cookies === "string" ? CookieJar.fromCookieHeader(cookies) : new CookieJar(cookies, now);
    return new GradescopeClient(options, jar);
  }

  exportSession(): GsSession {
    return { cookies: this.jar.list(), csrf_token: this.csrfToken, saved_at: new Date(this.now()).toISOString() };
  }

  hasCookie(name: string): boolean {
    return this.jar.has(name);
  }

  // --- HTTP ----------------------------------------------------------------------------------

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async send(method: "GET" | "POST", path: string, form?: Record<string, string>): Promise<PageResponse> {
    return this.enqueue(async () => {
      let url = new URL(path, this.baseUrl);
      let currentMethod = method;
      let body: string | undefined = form ? new URLSearchParams(form).toString() : undefined;
      let referer = this.baseUrl.toString();

      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const wait = this.lastRequestAt + this.minIntervalMs - this.now();
        if (wait > 0) await sleep(wait);
        this.lastRequestAt = this.now();

        const headers: Record<string, string> = {
          "User-Agent": this.userAgent,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: referer,
        };
        const cookie = this.jar.headerFor(url);
        if (cookie) headers.Cookie = cookie;
        if (this.csrfToken) headers["X-CSRF-Token"] = this.csrfToken;
        if (currentMethod === "POST") {
          headers["Content-Type"] = "application/x-www-form-urlencoded; charset=utf-8";
          headers.Origin = this.baseUrl.origin;
        }

        let res: Response;
        try {
          res = await this.fetchImpl(url, {
            method: currentMethod,
            headers,
            body: currentMethod === "POST" ? body : undefined,
            redirect: "manual",
            signal: AbortSignal.timeout(this.timeoutMs),
          });
        } catch (error) {
          const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "failed";
          throw new GradescopeError("network", `Gradescope request ${reason}: ${currentMethod} ${url.pathname}`);
        }
        for (const header of res.headers.getSetCookie()) this.jar.setFromHeader(header, url);

        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location) {
          await res.body?.cancel();
          const next = new URL(location, url);
          if (!/(^|\.)gradescope\.com$/i.test(next.hostname) && next.hostname !== this.baseUrl.hostname) {
            // An off-site hop (e.g. a school's SSO page) means this session can't continue here.
            return { status: res.status, url: next, html: "" };
          }
          if (res.status === 301 || res.status === 302 || res.status === 303) {
            currentMethod = "GET";
            body = undefined;
          }
          referer = url.toString();
          url = next;
          continue;
        }
        return { status: res.status, url, html: await res.text() };
      }
      throw new GradescopeError("http", "Gradescope redirected too many times");
    });
  }

  private remember(page: PageResponse): void {
    const csrf = parseCsrfToken(page.html);
    if (csrf) this.csrfToken = csrf;
  }

  private isSignedOut(page: PageResponse): boolean {
    return (
      page.status === 401 ||
      page.status === 403 ||
      page.url.pathname.startsWith("/login") ||
      page.url.hostname !== this.baseUrl.hostname ||
      isLoginPage(page.html)
    );
  }

  // --- Auth ----------------------------------------------------------------------------------

  /** Email + password login. Throws GradescopeError (invalid_credentials, sso_required, ...). */
  async loginWithPassword(email: string, password: string): Promise<void> {
    const trimmed = email.trim();
    if (!trimmed || !password) throw new GradescopeError("invalid_credentials", "Email and password are required");

    this.jar.clear();
    this.csrfToken = null;
    this.accountHtml = null;

    const home = await this.send("GET", "/");
    const token = parseLoginAuthenticityToken(home.html);
    if (!token) throw new GradescopeError("missing_token", "Couldn't find Gradescope's login form token");

    const result = await this.send("POST", "/login", {
      utf8: "✓",
      "session[email]": trimmed,
      "session[password]": password,
      "session[remember_me]": "1",
      commit: "Log In",
      "session[remember_me_sso]": "0",
      authenticity_token: token,
    });
    this.remember(result);

    const flash = parseFlashError(result.html);
    if (flash) {
      const kind = classifyFlashError(flash);
      if (kind === "invalid_credentials") {
        throw new GradescopeError(
          "invalid_credentials",
          `Gradescope rejected the email/password ("${flash}"). Accounts that sign in through a school (SSO) have no Gradescope password; connect them with a session cookie instead.`,
        );
      }
      if (kind === "sso_required") {
        throw new GradescopeError("sso_required", `Gradescope requires school sign-in for this account ("${flash}"). Connect it with a session cookie instead.`);
      }
      throw new GradescopeError("login_failed", `Gradescope login failed: ${flash}`);
    }
    if (this.isSignedOut(result)) {
      throw new GradescopeError("login_failed", "Gradescope returned to the login page without saying why");
    }
    // Success is a 302 to /account; when that page already loaded, it is the verification.
    if (result.status === 200 && result.url.pathname.startsWith("/account")) {
      this.accountHtml = result.html;
      return;
    }
    if (!(await this.verify())) throw new GradescopeError("login_failed", "Logged in, but the account page didn't load");
  }

  /** True when the session reaches the signed-in account page. */
  async verify(): Promise<boolean> {
    this.accountHtml = null;
    const page = await this.send("GET", "/account");
    if (this.isSignedOut(page)) return false;
    if (page.status !== 200) throw new GradescopeError("http", `Gradescope /account returned ${page.status}`);
    this.remember(page);
    this.accountHtml = page.html;
    return true;
  }

  // --- Data ----------------------------------------------------------------------------------

  /** Every course on the account page, student and instructor, in page order. */
  async listCourses(): Promise<GsCourse[]> {
    let html = this.accountHtml;
    this.accountHtml = null;
    if (html === null) {
      const page = await this.send("GET", "/account");
      if (this.isSignedOut(page)) throw new GradescopeError("session_expired", "Gradescope session expired");
      if (page.status !== 200) throw new GradescopeError("http", `Gradescope /account returned ${page.status}`);
      this.remember(page);
      html = page.html;
    }
    return parseAccountCourses(html);
  }

  /** Assignments on one course page. Pass the course from listCourses() for its name and role. */
  async listAssignments(
    courseId: string,
    course?: Pick<GsCourse, "name" | "short_name" | "role"> | null,
    options: { timeZone?: string } = {},
  ): Promise<GsAssignment[]> {
    if (!/^\d+$/.test(courseId)) throw new GradescopeError("http", "Invalid Gradescope course id");
    const courseName = course ? course.short_name || course.name : null;
    const paths = course?.role === "instructor" ? [`/courses/${courseId}/assignments`, `/courses/${courseId}`] : [`/courses/${courseId}`];

    let lastStatus = 0;
    for (const path of paths) {
      const page = await this.send("GET", path);
      lastStatus = page.status;
      if (page.status === 401 || page.status === 403) continue;
      if (this.isSignedOut(page)) throw new GradescopeError("session_expired", "Gradescope session expired");
      if (page.status !== 200) continue;
      this.remember(page);
      return parseCourseAssignments(page.html, {
        courseId,
        courseName,
        timeZone: options.timeZone,
        baseUrl: this.baseUrl.toString(),
      });
    }
    throw new GradescopeError("http", `Gradescope course ${courseId} returned ${lastStatus}`);
  }
}
