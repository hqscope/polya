import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// Full-bleed square on purpose — iOS applies its own corner mask, so baked-in
// rounding would leave black corners. Mirrors src/app/icon.svg.
export default async function AppleIcon() {
  const bold = await readFile(
    join(process.cwd(), "assets/fonts/InstrumentSans-Bold.ttf"),
  );

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#191f1d",
          color: "#fafcfb",
          fontSize: 104,
          fontWeight: 700,
          fontFamily: "Instrument Sans",
        }}
      >
        P
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Instrument Sans", data: bold, weight: 700, style: "normal" },
      ],
    },
  );
}
