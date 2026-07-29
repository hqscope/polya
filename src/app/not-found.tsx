import type { Metadata } from "next";
import Link from "next/link";

import Logo from "@/components/Logo";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <Logo />
      <h1 className="text-[21px]">This page doesn&apos;t exist</h1>
      <p className="max-w-sm text-[13px] leading-relaxed text-ink2">
        The page you&apos;re looking for may have moved. Head back and pick up
        where you left off.
      </p>
      <Link href="/" className="button-secondary mt-2 h-9 px-4 text-[13px]">
        Go home
      </Link>
    </div>
  );
}
