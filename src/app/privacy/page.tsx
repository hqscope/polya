import type { Metadata } from "next";

import ProsePage from "@/components/marketing/ProsePage";
import { contactEmail, defaultOpenGraph } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "What Polya stores, who helps run it, how long it keeps your data, and how to remove it.",
  alternates: { canonical: "/privacy" },
  openGraph: { ...defaultOpenGraph, url: "/privacy" },
};

// Written from what the product actually does (audited 2026-10-03: tables,
// events, edge functions, the ChatGPT/Claude connector). Have it reviewed
// before treating it as legal advice, and update it alongside any change to
// what Polya collects or stores.
//
// The "don't let them train on it" line depends on the Gemini key being on a
// paid tier (the free tier allows Google to use inputs to improve its
// products). Keep billing on, or change that sentence.
export default function PrivacyPage() {
  return (
    <ProsePage title="Privacy" updated="October 3, 2026">
      <p>
        Polya exists to help you learn from your own course materials. This
        page explains, in plain language, what Polya stores, who helps us run
        it, how long we keep it, and how to remove it.
      </p>

      <h2>What Polya stores</h2>
      <ul>
        <li>
          Your account: your name and email address from the Google account you
          sign in with, or the email address and password for an account set up
          that way.
        </li>
        <li>
          Your Canvas connection: your school&apos;s Canvas address and the
          Canvas access token you provide, stored encrypted. We also keep a
          security log of when the connection was used: the time, your
          school&apos;s address, and the kind of action.
        </li>
        <li>
          The course materials you bring in for the courses you choose
          (readings, slides, pages, assignments and lecture transcripts), plus
          the search index Polya builds from them.
        </li>
        <li>
          The study mode and study note you set for each course, your
          conversations with Polya, and your practice checks.
        </li>
        <li>
          A record of what you do in Polya, such as connecting or importing a
          course, starting a conversation, asking a question or opening a
          citation. It&apos;s linked to your account and never includes what
          you asked or read. We use it to understand whether Polya is working.
        </li>
        <li>
          A count of visits: a random number your browser generates, plus the
          date and time. It tells us how many people use Polya.
        </li>
        <li>Daily usage counts, so we can apply fair-use limits.</li>
      </ul>

      <h2>How it&apos;s used</h2>
      <p>
        Only to run Polya: importing the courses you pick, tutoring you from
        them, and keeping the service working and fair to everyone. We
        don&apos;t sell your information or your course materials, we
        don&apos;t use them for advertising, and there are no third-party
        analytics or advertising trackers in the product.
      </p>

      <h2>Who helps us run Polya</h2>
      <ul>
        <li>
          Anthropic writes Polya&apos;s tutoring replies. To answer, it receives
          your question, the relevant passages from your course, your recent
          conversation, and any lecture notes you add to a question.
        </li>
        <li>
          Google reads your course files (including text in images and scanned
          pages) and builds the search index that lets Polya find the right
          passage for each question.
        </li>
        <li>
          Supabase stores Polya&apos;s data and files, and Vercel hosts the
          website.
        </li>
      </ul>
      <p>
        They process this data on our behalf under their terms for business
        customers. We don&apos;t let them use your materials or conversations
        to train their models.
      </p>

      <h2>Using Polya in ChatGPT or Claude</h2>
      <p>
        If you connect Polya to ChatGPT or Claude, that assistant can see the
        names of the courses you&apos;ve added, the study mode for each, and
        passages from your materials when you ask about a course. Polya only
        receives what the assistant sends to look something up, like which
        course and what to search for. It never receives your chat history.
        What you say in ChatGPT or Claude is covered by OpenAI&apos;s or
        Anthropic&apos;s own privacy policy. The connection can only read; it
        can&apos;t change anything in Polya or Canvas. You can disconnect it
        at any time in the assistant&apos;s settings.
      </p>

      <h2>Your Canvas access token</h2>
      <p>
        It&apos;s never shown in the app after you enter it, and it&apos;s
        used only to read the courses you choose to connect. Nothing is ever
        posted back to Canvas. Email us at any time to remove it.
      </p>

      <h2>Your course materials</h2>
      <p>
        They remain yours and their authors&apos;. Polya uses them only to
        help you study: answering your questions with citations back to the
        exact page, slide, or lecture moment.
      </p>

      <h2>How long we keep it</h2>
      <p>
        We keep your data while your account is open. Nothing is deleted on a
        timer, so your courses are there when you come back.
      </p>
      <ul>
        <li>
          Remove a course from your library and its materials, files, search
          index, conversations and study mode are deleted right away.
        </li>
        <li>
          Ask us to delete your account and we&apos;ll delete it, along with
          everything above, within 30 days. Your Polya account is the same
          account you use for other Scope apps, such as Lectra and the Scope
          browser extension, so deleting it removes your data there too.
        </li>
      </ul>

      <h2>Removing your data</h2>
      <p>
        You can remove any course yourself from your course list. To remove
        your Canvas connection or your whole account, email{" "}
        <a href={`mailto:${contactEmail}`}>{contactEmail}</a> from the address
        you sign in with.
      </p>

      <h2>Age</h2>
      <p>Polya is made for college students and isn&apos;t meant for children under 13.</p>

      <h2>Changes</h2>
      <p>
        If this policy changes, we&apos;ll update this page and the date at
        the top.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about any of this? Write to{" "}
        <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.
      </p>
    </ProsePage>
  );
}
