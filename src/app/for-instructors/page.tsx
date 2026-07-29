import type { Metadata } from "next";
import Link from "next/link";

import MarketingFooter from "@/components/marketing/MarketingFooter";
import MarketingHeader from "@/components/marketing/MarketingHeader";
import { contactEmail, defaultOpenGraph } from "@/lib/seo";

export const metadata: Metadata = {
  title: "For instructors & universities",
  description:
    "Set a per-course assistance policy — Open, Guided, Practice, or Review — and Polya visibly follows it, tutoring from the materials you assigned with a citation on every answer.",
  alternates: { canonical: "/for-instructors" },
  openGraph: { ...defaultOpenGraph, url: "/for-instructors" },
};

const POLICIES = [
  {
    name: "Open",
    body: "Full answers allowed on request — a fit for self-study, review-heavy courses, and contexts where getting unstuck fast matters more than the struggle.",
  },
  {
    name: "Guided",
    body: "Hints and steps first; full solutions held back until the student engages. The default stance for problem-set courses.",
  },
  {
    name: "Practice",
    body: "Quiz stance: Polya never reveals an answer before the student commits one. Built for exam prep and the week an assignment is live.",
  },
  {
    name: "Review",
    body: "Post-deadline: full worked solutions plus suggested next practice, so a finished assignment becomes a study asset.",
  },
];

export default function ForInstructorsPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <MarketingHeader />
      <main className="flex-1">
        <article className="mx-auto w-full max-w-[760px] px-7 pt-16 pb-24">
          <p className="eyebrow">For instructors &amp; universities</p>
          <h1 className="mt-4 text-[36px] leading-[1.1] tracking-[-0.03em] text-balance">
            Set the rules AI help follows in your course.
          </h1>
          <p className="m-0 mt-4 max-w-[620px] text-[15.5px] leading-[1.65] text-pretty text-ink2">
            Students already use AI to get through school. Polya turns that
            help into a tutor — one that teaches from what you assigned,
            follows the policy you set, and shows its sources on every answer.
          </p>

          <h2 className="mt-12 text-[21px] tracking-[-0.02em]">
            One dial, four positions
          </h2>
          <p className="m-0 mt-3.5 text-[14px] leading-[1.7] text-ink2">
            Every course gets an assistance policy. Change it any time —
            Polya&apos;s behavior follows immediately, and students see the
            active policy in every conversation.
          </p>
          <div className="mt-6 grid gap-3 md:grid-cols-2">
            {POLICIES.map(({ name, body }) => (
              <div
                key={name}
                className="flex flex-col gap-1.5 rounded-[11px] border border-line bg-surface p-[18px] shadow-card"
              >
                <span className="text-[13px] font-[650] text-accent-ink">
                  {name}
                </span>
                <p className="m-0 text-[13px] leading-[1.7] text-ink2">
                  {body}
                </p>
              </div>
            ))}
          </div>

          <h2 className="mt-12 text-[21px] tracking-[-0.02em]">
            Grounded in what you assigned
          </h2>
          <p className="m-0 mt-3.5 text-[14px] leading-[1.7] text-ink2">
            Polya tutors from your course materials — the readings, slides,
            pages, and lecture recordings — in the language and notation you
            teach with. When you&apos;ve taught a method, Polya follows your
            method: a student who asks which statistical test to use gets
            walked through the decision procedure from your slides, not a
            generic recipe from the internet.
          </p>
          <p className="m-0 mt-3.5 text-[14px] leading-[1.7] text-ink2">
            Every claim carries a citation a student can open — the exact
            page, slide, or lecture moment. Verifiable help builds the habit
            you actually want in your students: checking the source.
          </p>

          <h2 className="mt-12 text-[21px] tracking-[-0.02em]">
            Transparent by design
          </h2>
          <p className="m-0 mt-3.5 text-[14px] leading-[1.7] text-ink2">
            The policy is visible in every conversation, so the amount of help
            is never a secret — not to your students, and not to you. Polya is
            built to be adopted, not banned: a sanctioned way for students to
            get help that actually teaches.
          </p>

          <h2 className="mt-12 text-[21px] tracking-[-0.02em]">
            Academic integrity
          </h2>
          <p className="m-0 mt-3.5 text-[14px] leading-[1.7] text-ink2">
            Polya&apos;s stance is simple: help should build understanding,
            not shortcut it. What counts as permitted help remains your call —
            Polya gives you the dial to make that call real inside the tool
            your students actually use.
          </p>

          <div className="mt-12 flex flex-wrap items-center gap-x-4 gap-y-3">
            <Link href="/login" className="button-primary">
              See it with a course
            </Link>
            <p className="m-0 text-[13.5px] text-ink2">
              Exploring a department or campus rollout?{" "}
              <a href={`mailto:${contactEmail}`} className="font-semibold">
                Get in touch
              </a>
              .
            </p>
          </div>
        </article>
      </main>
      <MarketingFooter />
    </div>
  );
}
