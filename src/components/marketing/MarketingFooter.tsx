import Link from "next/link";

import Logo from "@/components/Logo";

const FOOTER_LINKS = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/for-instructors", label: "For instructors" },
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/contact", label: "Contact" },
];

export default function MarketingFooter() {
  return (
    <footer>
      <div className="mx-auto flex max-w-[1120px] flex-col gap-2.5 px-7 pt-7 pb-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Logo className="text-[13.5px]" />
          <div className="flex flex-wrap items-center gap-[18px]">
            {FOOTER_LINKS.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className="text-[12.5px] text-ink3 hover:text-ink"
              >
                {label}
              </Link>
            ))}
          </div>
        </div>
        <span className="text-[12px] text-ink3">
          Polya — course-aware AI tutoring for your Canvas classes.
        </span>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <span className="text-[12px] text-ink3">© 2026 Canvascope Inc.</span>
          <span className="text-[12px] text-ink3">
            Named for George Pólya, who taught the world how to solve it.
          </span>
        </div>
      </div>
    </footer>
  );
}
