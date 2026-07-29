import Link from "next/link";

import Logo from "@/components/Logo";

const NAV_LINKS = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/for-instructors", label: "For instructors" },
  { href: "/#faq", label: "FAQ" },
];

// Shared chrome for the public marketing pages (landing, walkthroughs, legal).
export default function MarketingHeader() {
  return (
    <header className="sticky top-0 z-10 border-b border-line-soft bg-bg">
      <div className="mx-auto flex h-[58px] max-w-[1120px] items-center gap-9 px-7">
        <Logo />
        <nav className="hidden items-center gap-[22px] sm:flex">
          {NAV_LINKS.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className="text-[13px] font-medium text-ink2 hover:text-ink"
            >
              {label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-[18px]">
          <Link
            href="/login"
            className="text-[13px] font-medium text-ink2 hover:text-ink"
          >
            Sign in
          </Link>
          <Link
            href="/login"
            className="button-primary h-8 rounded-[7px] px-3.5 text-[13px]"
          >
            Get started
          </Link>
        </div>
      </div>
    </header>
  );
}
