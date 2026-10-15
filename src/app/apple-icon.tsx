import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// Full-bleed square on purpose — iOS applies its own corner mask, so baked-in
// rounding would leave black corners. Mirrors src/app/icon.svg.
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#5A2147",
        }}
      >
        <svg width="76" height="94.3" viewBox="0 0 54 67">
          <path fill="#FBEFF5" fillRule="evenodd" d="M0 27a27 27 0 1 0 54 0a27 27 0 1 0 -54 0ZM14 27a13 13 0 1 0 26 0a13 13 0 1 0 -26 0Z" />
          <path fill="#FBEFF5" d="M0 27H14V60A7 7 0 0 1 0 60Z" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
