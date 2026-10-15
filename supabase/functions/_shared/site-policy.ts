// Course-website fetch policy: what the crawler may read and from where.
// robots.txt rules, sitemap <loc>s, the private-address check that backs the
// fetch guard's hostname filter with a DNS answer, and the rewrite of
// "open in DataHub" notebook links to the public file they name. Pure module
// (no Deno globals) so Node's test runner covers it; callers do the I/O.

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export interface RobotsRules {
  groups: Array<{ agents: string[]; rules: RobotsRule[] }>;
  sitemaps: string[];
}

/** What a missing robots.txt (404) means: everything is allowed. */
export const ALLOW_ALL_ROBOTS: RobotsRules = { groups: [], sitemaps: [] };

/** The product token matched against User-agent lines. */
export const ROBOTS_AGENT = "polya";

export function parseRobotsTxt(text: string): RobotsRules {
  const out: RobotsRules = { groups: [], sitemaps: [] };
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  let lastWasAgent = false;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const match = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!match) continue;
    const field = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (field === "user-agent") {
      // Consecutive User-agent lines share one group.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        out.groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field === "sitemap") {
      if (value) out.sitemaps.push(value);
    } else if ((field === "allow" || field === "disallow") && current && value) {
      // An empty Disallow allows everything, so it adds no rule.
      current.rules.push({ allow: field === "allow", pattern: value });
    }
  }
  return out;
}

function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${regex}${anchored ? "$" : ""}`).test(path);
}

/**
 * Whether `pathAndQuery` may be fetched. Our own group wins over `*`; within
 * a group the longest matching rule wins and Allow wins a tie (RFC 9309).
 */
export function robotsAllows(rules: RobotsRules, pathAndQuery: string, agent = ROBOTS_AGENT): boolean {
  const token = agent.toLowerCase();
  const group =
    rules.groups.find((g) => g.agents.includes(token)) ??
    rules.groups.find((g) => g.agents.includes("*"));
  if (!group) return true;
  let best: RobotsRule | null = null;
  for (const rule of group.rules) {
    if (!patternMatches(rule.pattern, pathAndQuery)) continue;
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow)
    ) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

/** Every <loc> in a sitemap or sitemap index. */
export function parseSitemapLocs(xml: string): string[] {
  const out: string[] = [];
  for (const match of String(xml ?? "").matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    out.push(match[1]!.replace(/&amp;/g, "&"));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Private addresses
// ---------------------------------------------------------------------------

function ipv4Octets(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? octets : null;
}

/**
 * True for addresses a public course website can't legitimately resolve to:
 * private, loopback, link-local, carrier-grade NAT, benchmarking, multicast,
 * reserved, unique-local IPv6, and IPv4-mapped forms of those. Anything that
 * doesn't parse counts as private (fail closed).
 */
export function isPrivateAddress(ip: string): boolean {
  const value = String(ip ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  const v4 = ipv4Octets(value);
  if (v4) {
    const [a, b, c] = v4 as [number, number, number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (!value.includes(":")) return true;
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]!);
  if (value === "::" || value === "::1") return true;
  const first = Number.parseInt(value.split(":")[0] || "0", 16);
  if (!Number.isFinite(first)) return true;
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xff00) === 0xff00 // ff00::/8 multicast
  );
}

export type ResolveHost = (hostname: string) => Promise<string[]>;

/**
 * Resolves `hostname` and throws when any answer is a private address, so a
 * public-looking name can't point the fetch at an internal service. A
 * resolver that can't run (unsupported in the runtime) leaves the hostname
 * filter as the only check, which is the documented boundary today. This
 * narrows DNS rebinding but can't close it: the fetch resolves again.
 */
export async function assertPublicHost(hostname: string, resolve: ResolveHost | null): Promise<void> {
  if (!resolve) return;
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    return; // no answer here: the fetch itself will fail or the hostname filter applies
  }
  if (addresses.some(isPrivateAddress)) {
    throw new Error("That address points somewhere Polya can't open.");
  }
}

// ---------------------------------------------------------------------------
// Notebook links
// ---------------------------------------------------------------------------

/**
 * nbgitpuller "open this notebook in DataHub" links name a public GitHub repo
 * and a path inside it. Returns the raw file address, or null when the link
 * isn't one or points at a folder.
 */
export function notebookLinkToRaw(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (!/\/git-pull\/?$/.test(url.pathname)) return null;
  const repoParam = url.searchParams.get("repo");
  if (!repoParam) return null;
  let repo: URL;
  try {
    repo = new URL(repoParam);
  } catch {
    return null;
  }
  if (repo.hostname.toLowerCase() !== "github.com") return null;
  const [owner, nameRaw] = repo.pathname.split("/").filter(Boolean);
  if (!owner || !nameRaw) return null;
  const name = nameRaw.replace(/\.git$/, "");
  const branch = url.searchParams.get("branch") || "main";

  let path = url.searchParams.get("subpath") ?? url.searchParams.get("urlpath") ?? "";
  path = path.replace(/^\/+/, "").replace(/^(lab\/tree|tree|notebooks|lab|voila\/render)\//, "");
  if (path.startsWith(`${name}/`)) path = path.slice(name.length + 1);
  if (!path || !/\.[a-z0-9]+$/i.test(path)) return null;
  const segments = [owner, name, branch, ...path.split("/")].map(encodeURIComponent);
  return `https://raw.githubusercontent.com/${segments.join("/")}`;
}
