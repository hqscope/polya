import type { ReactNode } from "react";

import MarketingFooter from "@/components/marketing/MarketingFooter";
import MarketingHeader from "@/components/marketing/MarketingHeader";

// Shared shell for simple prose pages (privacy, terms, contact). The selector
// classes style the body's h2/p/ul so page content stays plain JSX.
export default function ProsePage({
  title,
  updated,
  children,
}: {
  title: string;
  updated?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <MarketingHeader />
      <main className="flex-1">
        <article className="mx-auto w-full max-w-[720px] px-7 pt-16 pb-24">
          <h1 className="text-[32px] tracking-[-0.03em] text-balance">
            {title}
          </h1>
          {updated ? (
            <p className="m-0 mt-3 text-[12.5px] text-ink3">
              Last updated {updated}
            </p>
          ) : null}
          <div className="mt-4 [&_h2]:mt-9 [&_h2]:text-[19px] [&_h2]:tracking-[-0.02em] [&_li]:mt-2 [&_p]:m-0 [&_p]:mt-3.5 [&_p]:text-[14px] [&_p]:leading-[1.7] [&_p]:text-ink2 [&_ul]:m-0 [&_ul]:mt-3.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:text-[14px] [&_ul]:leading-[1.7] [&_ul]:text-ink2">
            {children}
          </div>
        </article>
      </main>
      <MarketingFooter />
    </div>
  );
}
