import type { Metadata } from "next";
import Link from "next/link";

import MarketingFooter from "@/components/marketing/MarketingFooter";
import MarketingHeader from "@/components/marketing/MarketingHeader";
import { defaultOpenGraph } from "@/lib/seo";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "How Polya tutors from your actual course: connect your school's Canvas, ask anything from the class, and climb the help ladder — with a citation on every answer.",
  alternates: { canonical: "/how-it-works" },
  openGraph: { ...defaultOpenGraph, url: "/how-it-works" },
};

function SectionHeading({ num, children }: { num: string; children: string }) {
  return (
    <h2 className="mt-12 flex items-baseline gap-3 text-[21px] tracking-[-0.02em]">
      <span className="font-mono text-[13px] font-normal text-accent-ink">
        {num}
      </span>
      {children}
    </h2>
  );
}

function ExampleCard({
  label,
  question,
  answer,
}: {
  label: string;
  question: string;
  answer: string;
}) {
  return (
    <div className="mt-5 flex flex-col gap-2.5 rounded-[11px] border border-line bg-surface p-[18px] shadow-card">
      <span className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink3">
        {label}
      </span>
      <p className="m-0 text-[14px] font-semibold text-ink">“{question}”</p>
      <p className="m-0 text-[13px] leading-[1.7] text-ink2">{answer}</p>
    </div>
  );
}

export default function HowItWorksPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <MarketingHeader />
      <main className="flex-1">
        <article className="mx-auto w-full max-w-[760px] px-7 pt-16 pb-24">
          <p className="eyebrow">How it works</p>
          <h1 className="mt-4 text-[36px] leading-[1.1] tracking-[-0.03em] text-balance">
            How Polya works
          </h1>
          <p className="m-0 mt-4 max-w-[620px] text-[15.5px] leading-[1.65] text-pretty text-ink2">
            Polya is a tutor that has actually done the reading. Here&apos;s
            the whole loop — from connecting a course to climbing out of being
            stuck — and where every answer gets its receipts.
          </p>

          <SectionHeading num="01">Connect your course</SectionHeading>
          <p className="m-0 mt-3.5 text-[14px] leading-[1.7] text-ink2">
            Sign in with Google, then connect your school&apos;s Canvas — the
            same account you already use for class. Polya asks for your
            school&apos;s Canvas web address and a Canvas access token, and
            shows you exactly where to find both.
          </p>
          <p className="m-0 mt-3.5 text-[14px] leading-[1.7] text-ink2">
            Pick the courses you want help with. Polya studies what each class
            actually covers — the readings, slides, pages, and lecture
            recordings — so its help always comes from what your course
            actually teaches. Your materials stay yours: Polya only uses them
            to help you study.
          </p>

          <SectionHeading num="02">Ask anything from the class</SectionHeading>
          <p className="m-0 mt-3.5 text-[14px] leading-[1.7] text-ink2">
            Ask about a concept, a reading, or a problem you&apos;re stuck on.
            Polya answers from your course, not the open internet — in the
            language and notation your class uses.
          </p>
          <p className="m-0 mt-3.5 text-[14px] leading-[1.7] text-ink2">
            Every claim carries a small numbered citation. Click it and the
            exact source opens beside the answer: the page of the reading, the
            slide from lecture, or the precise moment in a recording.
          </p>
          <ExampleCard
            label="Example · Intro biology"
            question="Why does the electron transport chain need oxygen?"
            answer="Polya explains it from your own lecture — and the citation opens the recording at the moment your professor says oxygen is the terminal electron acceptor."
          />

          <SectionHeading num="03">Climb the help ladder</SectionHeading>
          <p className="m-0 mt-3.5 text-[14px] leading-[1.7] text-ink2">
            Ask Polya to solve something and it won&apos;t just hand you the
            answer. It starts with a hint. Still stuck? It gives you the next
            step. Then a worked example of the same kind of problem — and the
            full solution when that&apos;s what actually helps you learn.
          </p>
          <p className="m-0 mt-3.5 text-[14px] leading-[1.7] text-ink2">
            There&apos;s an &quot;I&apos;m stuck — next step&quot; button for
            exactly the moment it sounds like. You climb one rung at a time,
            and you decide when to climb.
          </p>
          <ExampleCard
            label="Example · Statistics"
            question="Which statistical test should I use for three groups?"
            answer="Polya walks the same decision procedure your professor taught in class — step by step, citing the method slides as it goes."
          />

          <SectionHeading num="04">
            Study within your instructor&apos;s policy
          </SectionHeading>
          <p className="m-0 mt-3.5 text-[14px] leading-[1.7] text-ink2">
            Instructors can set a per-course assistance policy — Open, Guided,
            Practice, or Review — and Polya visibly follows it. You&apos;ll
            see the active policy in every conversation, so what Polya will
            and won&apos;t reveal is never a mystery.{" "}
            <Link href="/for-instructors" className="font-semibold">
              More on policies →
            </Link>
          </p>

          <div className="mt-12 flex items-center gap-3">
            <Link href="/login" className="button-primary">
              Get started
            </Link>
            <Link href="/#faq" className="button-secondary">
              Read the FAQ
            </Link>
          </div>
        </article>
      </main>
      <MarketingFooter />
    </div>
  );
}
