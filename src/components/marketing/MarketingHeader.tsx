"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

import Logo from "@/components/Logo";

const NAV_LINKS = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/for-instructors", label: "For instructors" },
  { href: "/#faq", label: "FAQ" },
];

// Shared chrome for the public marketing pages (landing, walkthroughs, legal).
// Below `sm`, the nav links move into a disclosure menu behind a toggle
// button, since there's no visible way to reach them below that breakpoint
// otherwise. Sign in and Get started both lead to the same place (there's no
// separate signup), so the header shows one CTA.
export default function MarketingHeader() {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="sticky top-0 z-10 border-b border-line-soft bg-bg">
      <div className="relative mx-auto flex h-[58px] max-w-[1120px] items-center gap-9 px-7">
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
          <button
            ref={buttonRef}
            type="button"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            onClick={() => setOpen((value) => !value)}
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-[7px] text-ink2 hover:text-ink sm:hidden"
          >
            <span className="sr-only">Menu</span>
            <svg aria-hidden="true" viewBox="0 0 18 18" className="h-[18px] w-[18px]">
              <path
                d="M2.5 5h13M2.5 9h13M2.5 13h13"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <Link
            href="/login"
            className="button-primary h-8 rounded-[7px] px-3.5 text-[13px]"
          >
            Get started
          </Link>
        </div>

        {open ? (
          <>
            <div
              aria-hidden="true"
              onClick={() => setOpen(false)}
              className="fixed inset-x-0 top-[58px] bottom-0 z-10 bg-ink/20 sm:hidden"
            />
            <nav
              id={panelId}
              className="absolute inset-x-2 top-[58px] z-10 flex animate-fade-up flex-col gap-1 rounded-[10px] border border-line bg-bg p-2 shadow-[0_18px_40px_-20px_rgba(25,31,29,0.45)] sm:hidden"
            >
              {NAV_LINKS.map(({ href, label }) => (
                <Link
                  key={href}
                  href={href}
                  onClick={() => setOpen(false)}
                  className="rounded-[7px] px-3 py-2.5 text-[13px] font-medium text-ink2 hover:bg-rail hover:text-ink"
                >
                  {label}
                </Link>
              ))}
            </nav>
          </>
        ) : null}
      </div>
    </header>
  );
}
