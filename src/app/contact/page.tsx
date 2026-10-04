import type { Metadata } from "next";

import ProsePage from "@/components/marketing/ProsePage";
import { contactEmail, defaultOpenGraph, orgName } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Contact",
  description: `Get in touch with the Polya team at ${orgName}.`,
  alternates: { canonical: "/contact" },
  openGraph: { ...defaultOpenGraph, url: "/contact" },
};

export default function ContactPage() {
  return (
    <ProsePage title="Contact">
      <p>Questions, problems, or ideas — we read everything.</p>

      <h2>Email</h2>
      <p>
        Write to <a href={`mailto:${contactEmail}`}>{contactEmail}</a>. If
        something looks wrong, include your school, the course, and a
        screenshot — it helps us fix things fast.
      </p>

      <h2>Instructors &amp; universities</h2>
      <p>
        Exploring Polya for a course, a department, or a campus? Say hello at{" "}
        <a href={`mailto:${contactEmail}`}>{contactEmail}</a> — we&apos;d love
        to talk.
      </p>

      <h2>Privacy requests</h2>
      <p>
        To remove your account, your Canvas connection, or any imported
        materials, email us from the address you sign in with and we&apos;ll
        take care of it.
      </p>
    </ProsePage>
  );
}
