import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertPublicHost,
  isPrivateAddress,
  notebookLinkToRaw,
  parseRobotsTxt,
  parseSitemapLocs,
  robotsAllows,
} from "../supabase/functions/_shared/site-policy.ts";

const fixtures = join(import.meta.dirname, "fixtures", "course-site", "ds100-fa26");

test("the real course site's robots.txt allows everything", () => {
  const rules = parseRobotsTxt(readFileSync(join(fixtures, "robots.txt"), "utf8"));
  assert.equal(robotsAllows(rules, "/fa26/"), true);
  assert.equal(robotsAllows(rules, "/fa26/lectures/07/"), true);
  assert.deepEqual(rules.sitemaps, ["https://ds100.org/sitemap.xml"]);
});

test("robots.txt: longest rule wins, Allow wins a tie, our own group beats *", () => {
  const rules = parseRobotsTxt(
    [
      "User-agent: *",
      "Disallow: /private/",
      "Allow: /private/syllabus",
      "Disallow: /*.pdf$",
      "",
      "User-agent: Googlebot",
      "User-agent: Polya",
      "Disallow: /drafts/",
    ].join("\n"),
  );
  // Our token matches the second group (consecutive agents share one), so * doesn't apply.
  assert.equal(robotsAllows(rules, "/private/x"), true);
  assert.equal(robotsAllows(rules, "/drafts/hw1/"), false);

  const star = parseRobotsTxt("User-agent: *\nDisallow: /private/\nAllow: /private/syllabus\nDisallow: /*.pdf$\n");
  assert.equal(robotsAllows(star, "/private/notes/"), false);
  assert.equal(robotsAllows(star, "/private/syllabus/"), true);
  assert.equal(robotsAllows(star, "/files/hw1.pdf"), false);
  assert.equal(robotsAllows(star, "/files/hw1.pdf?x=1"), true);
  assert.equal(robotsAllows(star, "/public/"), true);
});

test("robots.txt: an empty Disallow and a missing file both allow everything", () => {
  assert.equal(robotsAllows(parseRobotsTxt("User-agent: *\nDisallow:\n"), "/anything"), true);
  assert.equal(robotsAllows(parseRobotsTxt(""), "/anything"), true);
});

test("sitemap <loc>s come back decoded", () => {
  const xml = readFileSync(join(fixtures, "sitemap.xml"), "utf8");
  const locs = parseSitemapLocs(xml);
  assert.ok(locs.includes("https://ds100.org/fa26/lectures/07/"));
  assert.ok(locs.includes("https://ds100.org/fa26/assets/other/sqlReview.pdf"));
  assert.deepEqual(parseSitemapLocs("<urlset><url><loc>https://x.edu/a?b=1&amp;c=2</loc></url></urlset>"), [
    "https://x.edu/a?b=1&c=2",
  ]);
});

test("private, loopback, link-local and mapped addresses are refused; public ones pass", () => {
  for (const ip of [
    "10.0.0.5", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "198.18.0.1", "::1", "::", "fe80::1", "fd00::1",
    "::ffff:127.0.0.1", "[::1]", "not-an-ip",
  ]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["185.199.108.153", "8.8.8.8", "172.32.0.1", "2606:50c0:8000::153", "::ffff:8.8.8.8"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("assertPublicHost refuses a name that resolves inside the network", async () => {
  await assert.rejects(assertPublicHost("course.example.edu", async () => ["93.184.216.34", "10.1.2.3"]));
  await assertPublicHost("ds100.org", async () => ["185.199.108.153"]);
  // No resolver, or a resolver that can't answer: the hostname filter stands alone.
  await assertPublicHost("ds100.org", null);
  await assertPublicHost("ds100.org", async () => {
    throw new Error("unsupported");
  });
});

test("DataHub notebook links rewrite to the public file in the repo", () => {
  assert.equal(
    notebookLinkToRaw(
      "https://data100.datahub.berkeley.edu/hub/user-redirect/git-pull?repo=https%3A%2F%2Fgithub.com%2FDS-100%2Ffa26-student&branch=main&urlpath=lab%2Ftree%2Ffa26-student%2Fhw%2Fhw01%2Fhw01.ipynb",
    ),
    "https://raw.githubusercontent.com/DS-100/fa26-student/main/hw/hw01/hw01.ipynb",
  );
  assert.equal(
    notebookLinkToRaw(
      "https://data100.datahub.berkeley.edu/hub/user-redirect/git-pull?repo=https://github.com/DS-100/fa26-student&subpath=lec/lec07/lec07.ipynb&app=lab",
    ),
    "https://raw.githubusercontent.com/DS-100/fa26-student/main/lec/lec07/lec07.ipynb",
  );
  // A folder, a non-GitHub repo, and an ordinary page aren't notebook files.
  assert.equal(
    notebookLinkToRaw("https://hub.example.edu/hub/user-redirect/git-pull?repo=https://github.com/a/b&urlpath=lab/tree/b/hw"),
    null,
  );
  assert.equal(notebookLinkToRaw("https://hub.example.edu/git-pull?repo=https://gitlab.com/a/b&subpath=x.ipynb"), null);
  assert.equal(notebookLinkToRaw("https://ds100.org/fa26/"), null);
});
