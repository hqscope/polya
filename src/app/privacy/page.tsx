import type { Metadata } from "next";

import ProsePage from "@/components/marketing/ProsePage";
import { contactEmail, defaultOpenGraph } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "How Polya handles your account, your Canvas connection, and your course materials.",
  alternates: { canonical: "/privacy" },
  openGraph: { ...defaultOpenGraph, url: "/privacy" },
};

// Working draft written from what the product actually does — have it
// reviewed before treating it as legal advice, and update it alongside any
// change to what Polya collects or stores.
export default function PrivacyPage() {
  return (
    <ProsePage title="Privacy" updated="July 17, 2026">
      <p>
        Polya exists to help you learn from your own course materials. This
        page explains, in plain language, what Polya stores and why.
      </p>

      <h2>What Polya stores</h2>
      <ul>
        <li>
          The basics of the Google account you sign in with — your name and
          email address.
        </li>
        <li>
          The Canvas web address and Canvas access token you provide when you
          connect your school&apos;s Canvas.
        </li>
        <li>
          The course materials brought in for the courses you choose —
          readings, slides, pages, and lecture transcripts.
        </li>
        <li>Your study conversations with Polya.</li>
      </ul>

      <h2>How it&apos;s used</h2>
      <p>
        Only to run Polya: importing the courses you pick and tutoring you
        from them. To answer a question, Polya processes the relevant parts of
        your course materials and your conversation with the AI services that
        power its tutoring. We don&apos;t sell your information or your course
        materials, and we don&apos;t use them for advertising.
      </p>

      <h2>Your Canvas access token</h2>
      <p>
        It&apos;s stored securely on our servers, never shown in the app after
        you enter it, and used only to read the courses you choose to connect.
        Nothing is ever posted back to Canvas. Contact us any time to remove
        it.
      </p>

      <h2>Your course materials</h2>
      <p>
        They remain yours — and their authors&apos;. Polya uses them only to
        help you study: answering your questions with citations back to the
        exact page, slide, or lecture moment.
      </p>

      <h2>Removing your data</h2>
      <p>
        Email us and we&apos;ll remove your account, your Canvas connection,
        and any imported materials.
      </p>

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
