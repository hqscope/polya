import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

import { landingTitle } from "@/lib/seo";

export const alt = landingTitle;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// The askpolya.com card from the Scope brand kit (scope-brand,
// web/link-previews/polya-link-preview-1200x630.png): Polya's mark and name on
// plum, with the one-line description. It's a finished image because the
// design uses film grain, which Satori can't draw. Satori takes images as data
// URIs only.
export default async function OpengraphImage() {
  const image = await readFile(join(process.cwd(), "assets/og/polya-link-preview.png"));
  const src = `data:image/png;base64,${image.toString("base64")}`;

  return new ImageResponse(
    <img src={src} alt="" width={size.width} height={size.height} />,
    size,
  );
}
