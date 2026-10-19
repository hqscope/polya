import type { Metadata } from "next";

import ProsePage from "@/components/marketing/ProsePage";
import {
  contactEmail,
  defaultOpenGraph,
  OWNER_SITE_URL,
  ownerName,
  SCOPE_SITE_URL,
} from "@/lib/seo";

export const metadata: Metadata = {
  title: "About",
  description: `Polya is an independent product created, owned, and operated by ${ownerName}, the founder of Scope.`,
  alternates: { canonical: "/about" },
  openGraph: { ...defaultOpenGraph, url: "/about" },
};

// Names the owner plainly: OpenAI's plugin review has to match Polya to the
// individual verified on the OpenAI account. Keep it in step with
// src/lib/seo.ts and the plugin manifest's developer name.
export default function AboutPage() {
  return (
    <ProsePage title="About Polya">
      <p>
        Polya is an independent product created, owned, and operated by{" "}
        {ownerName}. It&apos;s a tutor that works from your own course
        materials and helps you reason through problems instead of handing you
        answers.
      </p>

      <h2>Who makes it</h2>
      <p>
        {ownerName} is the founder of Scope, a set of study tools built around
        the courses students already take. Polya is one of them. {ownerName}{" "}
        designs, builds, and runs Polya, and owns the askpolya.com domain.
      </p>
      <ul>
        <li>
          {ownerName}:{" "}
          <a href={OWNER_SITE_URL}>noelsason.com</a>
        </li>
        <li>
          Scope: <a href={SCOPE_SITE_URL}>canvascope.org</a>
        </li>
      </ul>

      <h2>The name</h2>
      <p>
        Polya is named for George Pólya, the mathematician whose book How to
        Solve It taught generations to work through problems one question at a
        time.
      </p>

      <h2>Contact</h2>
      <p>
        Write to <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.
      </p>
    </ProsePage>
  );
}
