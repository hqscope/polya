import type { Metadata } from "next";
import Link from "next/link";

import AppPreview from "@/components/landing/AppPreview";
import MarketingFooter from "@/components/marketing/MarketingFooter";
import MarketingHeader from "@/components/marketing/MarketingHeader";
import JsonLd from "@/components/seo/JsonLd";
import { FAQ_ITEMS } from "@/lib/content/faq";
import {
  defaultOpenGraph,
  landingDescription,
  landingTitle,
} from "@/lib/seo";
import { buildLandingGraph } from "@/lib/structured-data";

export const metadata: Metadata = {
  title: { absolute: landingTitle },
  description: landingDescription,
  alternates: { canonical: "/" },
  openGraph: {
    ...defaultOpenGraph,
    url: "/",
    title: landingTitle,
    description:
      "Understand it, don't just submit it. Course-aware tutoring with citations from your actual class materials.",
  },
};

const STEPS = [
  {
    num: "01",
    title: "Connect your course",
    body: "Sign in with Google and connect your school’s Canvas. Pick a course, and Polya studies what the class actually covers — the readings, slides, pages, and lecture recordings.",
  },
  {
    num: "02",
    title: "Ask anything from the class",
    body: "Polya answers from your course, not the open internet. Every claim carries a citation that opens the exact page, slide, or lecture moment behind it.",
  },
  {
    num: "03",
    title: "Climb the ladder",
    body: "Stuck on a problem? Polya starts with a hint, then a step, then a worked example — the full solution when that’s what serves the learning, always within your instructor’s policy.",
  },
];

const FEATURES = [
  {
    num: "01",
    title: "Answers with receipts",
    body: "Every claim carries a citation. Click it and the exact PDF page or lecture moment opens beside the answer — verify it yourself, in one click.",
  },
  {
    num: "02",
    title: "Teaches instead of finishing",
    body: "Ask “solve this” and Polya starts with a hint, then a step, then a worked example — the full solution only when that’s what helps you learn.",
  },
  {
    num: "03",
    title: "Instructor-controlled",
    body: "A per-course policy — Open, Guided, Practice, or Review — visibly changes how much Polya reveals. Built to be adopted, not banned.",
  },
];

function ReceiptsDemo() {
  return (
    <div className="mt-1.5 flex flex-col gap-[9px] rounded-[9px] border border-line-soft bg-surface px-3.5 py-[13px]">
      <p className="m-0 text-[12px] leading-relaxed text-ink">
        …the total cost is work per level times the number of levels
        <span className="mx-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded bg-accent px-[3px] align-[2px] text-[9.5px] font-bold text-on-accent">
          1
        </span>
      </p>
      <div className="flex items-center gap-[7px] rounded-md border border-line-soft bg-rail px-[9px] py-1.5">
        <span className="font-mono text-[10px] text-accent-ink">12:40</span>
        <span className="overflow-hidden text-[11px] text-ellipsis whitespace-nowrap text-ink2">
          Lecture 9 — the exact moment, opened
        </span>
      </div>
    </div>
  );
}

function LadderDemo() {
  return (
    <div className="mt-1.5 flex flex-col gap-2 rounded-[9px] border border-line-soft bg-surface px-3.5 py-[13px]">
      {[
        { label: "Hint", rung: "rung 1", solid: false },
        { label: "Next step", rung: "rung 2", solid: false },
        { label: "Worked example", rung: "rung 3", solid: true },
      ].map(({ label, rung, solid }) => (
        <div key={rung} className="flex items-center gap-2">
          <span
            className={
              solid
                ? "rounded bg-accent px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.09em] text-on-accent"
                : "text-[9.5px] font-bold uppercase tracking-[0.09em] text-accent-ink"
            }
          >
            {label}
          </span>
          <span className="h-px flex-1 bg-line" />
          <span className="font-mono text-[9.5px] text-ink3">{rung}</span>
        </div>
      ))}
    </div>
  );
}

function PolicyDemo() {
  return (
    <div className="mt-1.5 flex flex-col rounded-[9px] border border-line-soft bg-surface p-2">
      {[
        { label: "Open", hint: "full answers", selected: false },
        { label: "Guided", hint: "hints first", selected: true },
        { label: "Practice", hint: "commit first", selected: false },
        { label: "Review", hint: "post-deadline", selected: false },
      ].map(({ label, hint, selected }) => (
        <div
          key={label}
          className={`flex items-center gap-2 rounded-md px-2 py-1.5 ${selected ? "bg-accent-soft" : ""}`}
        >
          <span
            className={
              selected
                ? "h-3 w-3 rounded-full border-4 border-accent"
                : "h-3 w-3 rounded-full border-[1.5px] border-line"
            }
          />
          <span
            className={`text-[11.5px] font-semibold ${selected ? "text-accent-ink" : "text-ink2"}`}
          >
            {label}
          </span>
          <span className="ml-auto text-[10px] text-ink3">{hint}</span>
        </div>
      ))}
    </div>
  );
}

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <JsonLd data={buildLandingGraph(FAQ_ITEMS)} />
      <MarketingHeader />

      <main className="flex-1">
        <section className="mx-auto w-full max-w-[1120px] px-7 pt-[84px]">
          <p className="eyebrow">Course-aware AI tutoring</p>
          <h1 className="mt-4 max-w-[680px] text-[40px] leading-[1.05] tracking-[-0.035em] text-balance sm:text-[52px]">
            Understand it, don&apos;t just submit it.
          </h1>
          <p className="mt-5 max-w-[560px] text-[16.5px] leading-[1.65] text-pretty text-ink2">
            Polya reads your actual course — the readings, the slides, the
            lecture recordings — and works through problems with you the way a
            good tutor would. Every answer shows exactly where in your course
            it came from.
          </p>
          <div className="mt-7 flex items-center gap-3">
            <Link href="/login" className="button-primary">
              Get started
            </Link>
            <a href="#how-it-works" className="button-secondary">
              See how it works
            </a>
          </div>
          <p className="mt-4 text-[12.5px] text-ink3">
            Works with your school&apos;s Canvas · Governed by your
            instructor&apos;s policy
          </p>
        </section>

        <section className="mx-auto w-full max-w-[1120px] px-7 pt-14">
          <AppPreview />
        </section>

        <section
          id="how-it-works"
          className="mx-auto w-full max-w-[1120px] px-7 pt-[104px]"
        >
          <p className="eyebrow">How it works</p>
          <h2 className="mt-3.5 max-w-[560px] text-[30px] tracking-[-0.03em] text-balance">
            Connect a course. Ask anything. Actually learn it.
          </h2>
          <div className="mt-10 flex max-w-[760px] flex-col">
            {STEPS.map(({ num, title, body }) => (
              <div
                key={num}
                className="grid grid-cols-[44px_1fr] gap-x-4 border-t border-line py-6"
              >
                <span className="pt-[3px] font-mono text-[12px] text-accent-ink">
                  {num}
                </span>
                <div>
                  <h3 className="text-[16.5px] tracking-[-0.015em]">{title}</h3>
                  <p className="m-0 mt-2 text-[13.5px] leading-[1.7] text-pretty text-ink2">
                    {body}
                  </p>
                </div>
              </div>
            ))}
          </div>
          <p className="m-0 mt-5 text-[13.5px]">
            <Link href="/how-it-works" className="font-semibold">
              See the full walkthrough →
            </Link>
          </p>
        </section>

        <section id="why" className="mx-auto w-full max-w-[1120px] px-7 pt-[104px]">
          <p className="eyebrow">Why Polya</p>
          <h2 className="mt-3.5 max-w-[520px] text-[30px] tracking-[-0.03em] text-balance">
            Three things a chatbot won&apos;t do.
          </h2>
          <div className="mt-10 grid border-t border-line md:grid-cols-3">
            {FEATURES.map(({ num, title, body }, i) => (
              <div
                key={num}
                className={`flex flex-col gap-3 py-7 pb-2 ${
                  i === 0
                    ? "md:pr-7"
                    : i === 1
                      ? "md:border-l md:border-line-soft md:px-7"
                      : "md:border-l md:border-line-soft md:pl-7"
                }`}
              >
                <span className="font-mono text-[11px] text-ink3">{num}</span>
                <h3 className="text-[16.5px] tracking-[-0.015em]">{title}</h3>
                <p className="m-0 text-[13.5px] leading-[1.7] text-pretty text-ink2">
                  {body}
                </p>
                {i === 0 ? <ReceiptsDemo /> : i === 1 ? <LadderDemo /> : <PolicyDemo />}
              </div>
            ))}
          </div>
        </section>

        <section
          id="instructors"
          className="mt-[104px] border-y border-line bg-surface"
        >
          <div className="mx-auto grid max-w-[1120px] items-center gap-14 px-7 py-16 md:grid-cols-[1.2fr_1fr]">
            <div className="flex flex-col gap-3.5">
              <p className="eyebrow">For instructors &amp; universities</p>
              <h2 className="text-[28px] tracking-[-0.03em] text-balance">
                Academic help your policies can actually govern.
              </h2>
              <p className="m-0 max-w-[480px] text-[14px] leading-[1.7] text-pretty text-ink2">
                Polya tutors from the materials you assigned, in the language
                you teach with, at the assistance level you choose. Students
                see the policy in every conversation — and every answer shows
                its sources.
              </p>
              <div className="mt-1.5 flex items-center gap-4">
                <Link
                  href="/login"
                  className="button-secondary h-9 self-start bg-bg px-4 text-[13px]"
                >
                  See it with a course
                </Link>
                <Link href="/for-instructors" className="text-[13px] font-semibold">
                  Learn more →
                </Link>
              </div>
            </div>
            <div className="flex flex-col gap-3 rounded-[11px] border border-line bg-bg p-[18px] shadow-card">
              <div className="flex items-center justify-between">
                <span className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink3">
                  Assistance policy · CS 3510
                </span>
                <span className="text-[11px] font-semibold text-accent-ink">
                  ✓ Saved
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex flex-col gap-0.5 rounded-lg border border-accent bg-accent-soft px-3 py-2.5">
                  <span className="text-[12.5px] font-[650] text-accent-ink">
                    Guided
                  </span>
                  <span className="text-[11px] leading-[1.55] text-ink2">
                    Hints and steps first; full solutions held back until the
                    student engages.
                  </span>
                </div>
                <div className="flex flex-col gap-0.5 rounded-lg border border-line-soft bg-surface px-3 py-2.5">
                  <span className="text-[12.5px] font-[650]">Practice</span>
                  <span className="text-[11px] leading-[1.55] text-ink2">
                    Never reveals the answer before the student commits one.
                  </span>
                </div>
                <div className="flex flex-col gap-0.5 rounded-lg border border-line-soft bg-surface px-3 py-2.5">
                  <span className="text-[12.5px] font-[650]">Review</span>
                  <span className="text-[11px] leading-[1.55] text-ink2">
                    Post-deadline — full worked solutions plus suggested
                    practice.
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="faq" className="mx-auto w-full max-w-[1120px] px-7 pt-[104px] pb-6">
          <p className="eyebrow">Frequently asked questions</p>
          <h2 className="mt-3.5 max-w-[520px] text-[30px] tracking-[-0.03em] text-balance">
            Asked and answered.
          </h2>
          <div className="mt-10 grid md:grid-cols-2 md:gap-x-16">
            {FAQ_ITEMS.map(({ question, answer }) => (
              <div
                key={question}
                className="flex flex-col gap-2 border-t border-line py-6"
              >
                <h3 className="text-[15.5px] tracking-[-0.015em]">{question}</h3>
                <p className="m-0 text-[13.5px] leading-[1.7] text-pretty text-ink2">
                  {answer}
                </p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}
