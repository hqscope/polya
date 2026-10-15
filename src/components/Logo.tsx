import Link from "next/link";

// Polya logo: the p-bubble mark + "polya" wordmark (Instrument Sans Bold,
// -0.03em tracking, outlined so it renders identically everywhere).
// `size` is the lockup height in px. Mark = --brand (#5A2147); wordmark =
// currentColor (text-ink).
const MARK_RING = "M0 27a27 27 0 1 0 54 0a27 27 0 1 0 -54 0ZM14 27a13 13 0 1 0 26 0a13 13 0 1 0 -26 0Z";
const MARK_STEM = "M0 27H14V60A7 7 0 0 1 0 60Z";
const LOCKUP_RING = "M0 37a37 37 0 1 0 74 0a37 37 0 1 0 -74 0ZM19.19 37a17.81 17.81 0 1 0 35.63 0a17.81 17.81 0 1 0 -35.63 0Z";
const LOCKUP_STEM = "M0 37H19.19V82.22A9.59 9.59 0 0 1 0 82.22Z";
const WORDMARK = "M138.4 74Q131.1 74 126.7 70.6Q122.3 67.2 121.5 61.3L122.3 61.2L122.3 93.5L107.3 93.5L107.3 22L122 22L122 33.3L121.1 33.1Q122.2 27.5 127.1 24.25Q132 21 139.2 21Q146.1 21 151.15 24.25Q156.2 27.5 158.95 33.4Q161.7 39.3 161.7 47.3Q161.7 55.4 158.8 61.4Q155.9 67.4 150.7 70.7Q145.5 74 138.4 74ZM134.2 62Q139.5 62 142.8 58.2Q146.1 54.4 146.1 47.4Q146.1 40.4 142.75 36.7Q139.4 33 134 33Q128.8 33 125.45 36.75Q122.1 40.5 122.1 47.5Q122.1 54.5 125.45 58.25Q128.8 62 134.2 62ZM192.3 74Q183.9 74 177.55 70.65Q171.2 67.3 167.65 61.25Q164.1 55.2 164.1 47.3Q164.1 39.4 167.65 33.5Q171.2 27.6 177.55 24.3Q183.9 21 192.3 21Q200.8 21 207.15 24.3Q213.5 27.6 217 33.5Q220.5 39.4 220.5 47.3Q220.5 55.2 216.95 61.25Q213.4 67.3 207.05 70.65Q200.7 74 192.3 74ZM192.3 62.2Q195.8 62.2 198.65 60.4Q201.5 58.6 203.2 55.25Q204.9 51.9 204.9 47.2Q204.9 40.3 201.25 36.55Q197.6 32.8 192.3 32.8Q187 32.8 183.35 36.6Q179.7 40.4 179.7 47.2Q179.7 51.9 181.4 55.25Q183.1 58.6 185.95 60.4Q188.8 62.2 192.3 62.2ZM225.5 73L225.5 1L240.5 1L240.5 73L225.5 73ZM252.1 93.5L266.2 62.3L268.8 58L282 22L298 22L267.1 93.5L252.1 93.5ZM262.9 72L243.3 22L259.5 22L275.6 67.6L262.9 72ZM330 73Q329.4 70.8 329.15 68.3Q328.9 65.8 328.9 62.5L328.5 62.5L328.5 38.4Q328.5 35.3 326.45 33.55Q324.4 31.8 320.4 31.8Q316.6 31.8 314.35 33.1Q312.1 34.4 311.4 36.9L297.1 36.9Q298.1 30 304.2 25.5Q310.3 21 320.9 21Q331.9 21 337.7 25.9Q343.5 30.8 343.5 40L343.5 62.5Q343.5 65 343.85 67.55Q344.2 70.1 345 73L330 73ZM312.2 74Q304.6 74 300.1 70.15Q295.6 66.3 295.6 59.9Q295.6 52.8 300.95 48.45Q306.3 44.1 315.9 42.8L330.8 40.7L330.8 49.4L318.4 51.3Q314.4 51.9 312.5 53.5Q310.6 55.1 310.6 57.9Q310.6 60.4 312.4 61.7Q314.2 63 317.2 63Q321.9 63 325.2 60.45Q328.5 57.9 328.5 54.5L329.9 62.5Q327.7 68.2 323.2 71.1Q318.7 74 312.2 74Z";

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

// The lockup alone, no link — for static replicas like the landing preview.
export function PolyaLockup({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 345 93.5"
      style={{ height: size, width: (size * 345) / 93.5 }}
      aria-hidden="true"
    >
      <path fill="var(--brand, #5A2147)" fillRule="evenodd" d={LOCKUP_RING} />
      <path fill="var(--brand, #5A2147)" d={LOCKUP_STEM} />
      <path fill="currentColor" d={WORDMARK} />
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
      <PolyaLockup size={size} />
    </Link>
  );
}
