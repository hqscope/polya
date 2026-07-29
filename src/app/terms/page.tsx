import type { Metadata } from "next";

import ProsePage from "@/components/marketing/ProsePage";
import { contactEmail, defaultOpenGraph } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Terms",
  description: "The terms that govern your use of Polya.",
  alternates: { canonical: "/terms" },
  openGraph: { ...defaultOpenGraph, url: "/terms" },
};

// Working draft — have it reviewed before treating it as legal advice.
export default function TermsPage() {
  return (
    <ProsePage title="Terms of service" updated="July 17, 2026">
      <p>
        These terms govern your use of Polya, a service of Canvascope Inc. By
        signing in, you agree to them.
      </p>

      <h2>The service</h2>
      <p>
        Polya is study help: it tutors you from the materials of the courses
        you connect. Polya works hard to be accurate and shows the source
        behind every claim so you can verify it — but it can still be wrong,
        and it makes no promises about grades or outcomes. Check the source;
        that&apos;s what the citations are for.
      </p>

      <h2>Academic integrity</h2>
      <p>
        You&apos;re responsible for following your institution&apos;s and
        instructor&apos;s rules. Polya&apos;s assistance policies help
        instructors shape what help looks like in their course, but your
        syllabus and your school&apos;s honor code always govern what&apos;s
        permitted.
      </p>

      <h2>Your content</h2>
      <p>
        Course materials remain the property of their owners. By connecting a
        course, you confirm you have the right to use its materials for your
        own study. Polya uses them only to provide the service to you.
      </p>

      <h2>Acceptable use</h2>
      <p>
        Polya is for your personal study. Don&apos;t attempt to access courses
        or data that aren&apos;t yours, disrupt the service, or resell or
        redistribute what it produces or contains.
      </p>

      <h2>Your account</h2>
      <p>
        You sign in with Google and are responsible for the security of that
        account. We may suspend accounts that break these terms.
      </p>

      <h2>Disclaimers</h2>
      <p>
        Polya is provided &quot;as is.&quot; To the fullest extent the law
        allows, Canvascope Inc. disclaims warranties and limits its liability
        arising from your use of the service.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms; if we do, we&apos;ll update this page and
        the date at the top. Continuing to use Polya after a change means you
        accept the new terms.
      </p>

      <h2>Contact</h2>
      <p>
        Questions? Write to{" "}
        <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.
      </p>
    </ProsePage>
  );
}
