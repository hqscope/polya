// schema.org JSON-LD builders for the public pages. Only claims we can stand
// behind: no ratings, no social profiles, no site search — fields get added
// when the real thing exists.

import type { FaqItem } from "@/lib/content/faq";
import {
  absoluteUrl,
  contactEmail,
  landingDescription,
  orgName,
  siteName,
  siteUrl,
} from "@/lib/seo";

type SchemaNode = Record<string, unknown>;

const organizationId = `${siteUrl}/#organization`;
const websiteId = `${siteUrl}/#website`;

function organization(): SchemaNode {
  return {
    "@type": "Organization",
    "@id": organizationId,
    name: orgName,
    url: siteUrl,
    email: contactEmail,
    brand: { "@type": "Brand", name: siteName },
    logo: { "@type": "ImageObject", url: absoluteUrl("/icon.svg") },
  };
}

function website(): SchemaNode {
  return {
    "@type": "WebSite",
    "@id": websiteId,
    url: siteUrl,
    name: siteName,
    publisher: { "@id": organizationId },
  };
}

function softwareApplication(): SchemaNode {
  return {
    "@type": "SoftwareApplication",
    name: siteName,
    url: siteUrl,
    description: landingDescription,
    applicationCategory: "EducationalApplication",
    operatingSystem: "Web",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    publisher: { "@id": organizationId },
  };
}

function faqPage(faq: readonly FaqItem[]): SchemaNode {
  return {
    "@type": "FAQPage",
    mainEntity: faq.map(({ question, answer }) => ({
      "@type": "Question",
      name: question,
      acceptedAnswer: { "@type": "Answer", text: answer },
    })),
  };
}

// The landing page's full graph. FAQ items are passed in from the same array
// that renders the visible section, so page and schema stay in sync.
export function buildLandingGraph(faq: readonly FaqItem[]): SchemaNode {
  return {
    "@context": "https://schema.org",
    "@graph": [organization(), website(), softwareApplication(), faqPage(faq)],
  };
}
