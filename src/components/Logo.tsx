import Link from "next/link";

// Polya logo. The wordmark is "polya" with the brand mark (a lowercase p
// drawn as a speech bubble) standing in for the "p", followed by "olya" in
// Instrument Sans Bold at -0.03em, outlined so it renders identically
// everywhere. The mark's ring matches the font's x-height (o: y 21–74 at
// 100px) and keeps the font's p→o spacing. Mark = --brand (#5A2147);
// "olya" = currentColor (text-ink).
const MARK_RING = "M0 27a27 27 0 1 0 54 0a27 27 0 1 0 -54 0ZM14 27a13 13 0 1 0 26 0a13 13 0 1 0 -26 0Z";
const MARK_STEM = "M0 27H14V60A7 7 0 0 1 0 60Z";

// Exported for places that can't use CSS variables (the share image).
export const WORDMARK = {
  width: 236.3,
  height: 93.5,
  ring: "M0 47.5a26.5 26.5 0 1 0 53 0a26.5 26.5 0 1 0 -53 0ZM13.74 47.5a12.76 12.76 0 1 0 25.52 0a12.76 12.76 0 1 0 -25.52 0Z",
  stem: "M0 47.5H13.74V79.89A6.87 6.87 0 0 1 0 79.89Z",
  olya: "M83.6 74Q75.2 74 68.85 70.65Q62.5 67.3 58.95 61.25Q55.4 55.2 55.4 47.3Q55.4 39.4 58.95 33.5Q62.5 27.6 68.85 24.3Q75.2 21 83.6 21Q92.1 21 98.45 24.3Q104.8 27.6 108.3 33.5Q111.8 39.4 111.8 47.3Q111.8 55.2 108.25 61.25Q104.7 67.3 98.35 70.65Q92 74 83.6 74ZM83.6 62.2Q87.1 62.2 89.95 60.4Q92.8 58.6 94.5 55.25Q96.2 51.9 96.2 47.2Q96.2 40.3 92.55 36.55Q88.9 32.8 83.6 32.8Q78.3 32.8 74.65 36.6Q71 40.4 71 47.2Q71 51.9 72.7 55.25Q74.4 58.6 77.25 60.4Q80.1 62.2 83.6 62.2ZM116.8 73L116.8 1L131.8 1L131.8 73L116.8 73ZM143.4 93.5L157.5 62.3L160.1 58L173.3 22L189.3 22L158.4 93.5L143.4 93.5ZM154.2 72L134.6 22L150.8 22L166.9 67.6L154.2 72ZM221.3 73Q220.7 70.8 220.45 68.3Q220.2 65.8 220.2 62.5L219.8 62.5L219.8 38.4Q219.8 35.3 217.75 33.55Q215.7 31.8 211.7 31.8Q207.9 31.8 205.65 33.1Q203.4 34.4 202.7 36.9L188.4 36.9Q189.4 30 195.5 25.5Q201.6 21 212.2 21Q223.2 21 229 25.9Q234.8 30.8 234.8 40L234.8 62.5Q234.8 65 235.15 67.55Q235.5 70.1 236.3 73L221.3 73ZM203.5 74Q195.9 74 191.4 70.15Q186.9 66.3 186.9 59.9Q186.9 52.8 192.25 48.45Q197.6 44.1 207.2 42.8L222.1 40.7L222.1 49.4L209.7 51.3Q205.7 51.9 203.8 53.5Q201.9 55.1 201.9 57.9Q201.9 60.4 203.7 61.7Q205.5 63 208.5 63Q213.2 63 216.5 60.45Q219.8 57.9 219.8 54.5L221.2 62.5Q219 68.2 214.5 71.1Q210 74 203.5 74Z",
};

export function PolyaMark({
  className = "",
  color = "var(--brand, #5A2147)",
}: {
  className?: string;
  color?: string;
}) {
  return (
    <svg viewBox="0 0 54 67" className={className} aria-hidden="true">
      <path fill={color} fillRule="evenodd" d={MARK_RING} />
      <path fill={color} d={MARK_STEM} />
    </svg>
  );
}

// The wordmark alone, no link — for static replicas like the landing preview.
// `size` is the height in px.
export function PolyaWordmark({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox={`0 0 ${WORDMARK.width} ${WORDMARK.height}`}
      style={{ height: size, width: (size * WORDMARK.width) / WORDMARK.height }}
      aria-hidden="true"
    >
      <path fill="var(--brand, #5A2147)" fillRule="evenodd" d={WORDMARK.ring} />
      <path fill="var(--brand, #5A2147)" d={WORDMARK.stem} />
      <path fill="currentColor" d={WORDMARK.olya} />
    </svg>
  );
}

export default function Logo({
  href = "/",
  size = 16,
  className = "",
}: {
  href?: string;
  size?: number;
  className?: string;
}) {
  return (
    <Link
      href={href}
      aria-label="Polya"
      className={`inline-flex shrink-0 items-center text-ink hover:text-ink ${className}`}
    >
      <PolyaWordmark size={size} />
    </Link>
  );
}
