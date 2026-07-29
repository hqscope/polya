import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

import { landingTitle } from "@/lib/seo";

export const alt = landingTitle;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Satori needs raw static font buffers (no variable fonts, no woff2) — hence
// the vendored TTFs in assets/fonts. Layout rules: flexbox only, and every
// multi-child div needs an explicit display: "flex".
export default async function OpengraphImage() {
  const [bold, regular] = await Promise.all([
    readFile(join(process.cwd(), "assets/fonts/InstrumentSans-Bold.ttf")),
    readFile(join(process.cwd(), "assets/fonts/InstrumentSans-Regular.ttf")),
  ]);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 88px",
          background: "#f7f8f8",
          fontFamily: "Instrument Sans",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 12,
              background: "#191f1d",
              color: "#fafcfb",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 34,
              fontWeight: 700,
            }}
          >
            P
          </div>
          <div
            style={{
              fontSize: 40,
              fontWeight: 700,
              letterSpacing: "-0.02em",
              color: "#191f1d",
            }}
          >
            Polya
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div
            style={{
              fontSize: 68,
              fontWeight: 700,
              letterSpacing: "-0.03em",
              color: "#191f1d",
              lineHeight: 1.06,
              maxWidth: 940,
            }}
          >
            Understand it, don&apos;t just submit it.
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              fontSize: 28,
              color: "#5c6562",
            }}
          >
            <span>Course-aware tutoring, with a citation on every answer.</span>
            <span
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 34,
                height: 34,
                borderRadius: 8,
                background: "#0d7263",
                color: "#f4faf8",
                fontSize: 19,
                fontWeight: 700,
              }}
            >
              1
            </span>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            fontSize: 24,
            fontWeight: 700,
            color: "#0d7263",
          }}
        >
          askpolya.com
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Instrument Sans", data: bold, weight: 700, style: "normal" },
        { name: "Instrument Sans", data: regular, weight: 400, style: "normal" },
      ],
    },
  );
}
