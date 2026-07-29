import Link from "next/link";

// The wordmark: plain text "Polya" in Instrument Sans Bold, tracked tight.
// Identical on every screen — size can be tuned via className.
export default function Logo({
  href = "/",
  className = "",
}: {
  href?: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`text-[15.5px] font-bold tracking-[-0.02em] text-ink hover:text-ink ${className}`}
    >
      Polya
    </Link>
  );
}
