// Pings IndexNow (Bing, Yandex, Seznam, Naver — the indexes AI answer
// engines ride on; Google ignores IndexNow) with every public URL. Run after
// deploys that change public pages:
//
//   npm run seo:indexnow
//
// The key is public by design and must match public/<KEY>.txt.
import { PUBLIC_PATHS, siteUrl } from "../src/lib/seo.ts";

const KEY = "69334ce71859d2a0cbbec43c703cb36a";

const host = new URL(siteUrl).host;
const urlList = PUBLIC_PATHS.map((path) => new URL(path, siteUrl).href);

const resp = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({
    host,
    key: KEY,
    keyLocation: `${siteUrl}/${KEY}.txt`,
    urlList,
  }),
});

console.log(
  `IndexNow ${resp.status} ${resp.statusText} — ${host}, ${urlList.length} URLs`,
);

// Per the IndexNow spec, 200 and 202 both mean the submission was accepted.
if (resp.status !== 200 && resp.status !== 202) {
  const body = await resp.text();
  if (body) console.error(body);
  process.exit(1);
}
