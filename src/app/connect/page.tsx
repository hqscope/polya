import type { Metadata } from "next";
import Link from "next/link";

import MarketingFooter from "@/components/marketing/MarketingFooter";
import MarketingHeader from "@/components/marketing/MarketingHeader";
import { contactEmail, defaultOpenGraph } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Use Polya in ChatGPT and Claude",
  description:
    "Bring your courses and the study mode you chose for each into ChatGPT and Claude, so their help matches how you want to learn and cites what your class covers.",
  alternates: { canonical: "/connect" },
  openGraph: { ...defaultOpenGraph, url: "/connect" },
};

const CONNECTOR_URL = "https://askpolya.com/mcp";

function SectionHeading({ children }: { children: string }) {
  return <h2 className="mt-12 text-[21px] tracking-[-0.02em]">{children}</h2>;
}

function Steps({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="m-0 mt-4 flex list-decimal flex-col gap-2 pl-5 text-[14px] leading-[1.7] text-ink2">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ol>
  );
}

function Prompt({ children }: { children: string }) {
  return (
    <li className="rounded-[11px] border border-line bg-surface px-[18px] py-3 text-[13.5px] text-ink shadow-card">
      “{children}”
    </li>
  );
}

export default function ConnectPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <MarketingHeader />
      <main className="flex-1">
        <article className="mx-auto w-full max-w-[760px] px-7 pt-16 pb-24">
          <p className="eyebrow">ChatGPT and Claude</p>
          <h1 className="mt-4 text-[36px] leading-[1.1] tracking-[-0.03em] text-balance">
            Use Polya in ChatGPT and Claude
          </h1>
          <p className="m-0 mt-4 max-w-[620px] text-[15.5px] leading-[1.65] text-pretty text-ink2">
            Choose how you want help in each course, from hints only to full
            worked solutions, and the assistant you already use checks that
            before it helps. Its explanations come from your own readings,
            slides and lectures, with the source for each one.
          </p>

          <SectionHeading>Before you start</SectionHeading>
          <p className="m-0 mt-4 text-[14px] leading-[1.7] text-ink2">
            Add a course to Polya first, then pick its study mode on the
            course&apos;s Materials page. ChatGPT and Claude check that mode
            before helping with the class.{" "}
            <Link href="/login" className="text-accent-ink underline underline-offset-2">
              Sign in to Polya
            </Link>
          </p>

          <SectionHeading>Claude</SectionHeading>
          <Steps
            items={[
              "On claude.ai or the Claude desktop app, open Customize, then Connectors.",
              <>
                Choose <strong>Add custom connector</strong> and enter{" "}
                <code className="font-mono text-[13px] text-ink">{CONNECTOR_URL}</code>.
              </>,
              "Sign in to Polya when asked and choose Allow. Polya then works in Claude on the web, desktop and phone.",
            ]}
          />

          <SectionHeading>ChatGPT</SectionHeading>
          <Steps
            items={[
              "In ChatGPT, open Settings, then Security and login, and turn on Developer mode.",
              <>
                Go to Plugins, choose <strong>+</strong>, name it Polya and enter{" "}
                <code className="font-mono text-[13px] text-ink">{CONNECTOR_URL}</code>.
              </>,
              "Sign in to Polya when asked and choose Allow.",
            ]}
          />

          <SectionHeading>Things to ask</SectionHeading>
          <ul className="m-0 mt-4 flex list-none flex-col gap-2.5 p-0">
            <Prompt>What study mode is my Data 100 course in?</Prompt>
            <Prompt>Explain gradient descent the way my Data 100 lectures do.</Prompt>
            <Prompt>Quiz me on this week&apos;s probability material.</Prompt>
          </ul>

          <SectionHeading>What ChatGPT and Claude can see</SectionHeading>
          <p className="m-0 mt-4 text-[14px] leading-[1.7] text-ink2">
            Only what they need to help: the names of the courses you&apos;ve added,
            each course&apos;s study rules, and passages from your materials when
            you ask about a course. They can&apos;t change anything in Polya or
            Canvas. ChatGPT and Claude still write their own answers, so treat
            the rules as a guide you&apos;re choosing to follow. You can disconnect
            at any time from the assistant&apos;s settings. Read the{" "}
            <Link href="/privacy" className="text-accent-ink underline underline-offset-2">
              privacy policy
            </Link>{" "}
            or email{" "}
            <a href={`mailto:${contactEmail}`} className="text-accent-ink underline underline-offset-2">
              {contactEmail}
            </a>
            .
          </p>
        </article>
      </main>
      <MarketingFooter />
    </div>
  );
}
