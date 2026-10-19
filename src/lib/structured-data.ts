// schema.org JSON-LD builders for the public pages. Only claims we can stand
// behind: no ratings, no social profiles, no site search — fields get added
// when the real thing exists.

import type { FaqItem } from "@/lib/content/faq";
import {
  contactEmail,
  landingDescription,
  OWNER_SITE_URL,
  ownerName,
  siteName,
  siteUrl,
} from "@/lib/seo";

type SchemaNode = Record<string, unknown>;

const ownerId = `${siteUrl}/#owner`;
const websiteId = `${siteUrl}/#website`;

// Polya is run by an individual, not a company, so the publisher is a Person.
function owner(): SchemaNode {
  return {
    "@type": "Person",
    "@id": ownerId,
    name: ownerName,
    url: OWNER_SITE_URL,
    email: contactEmail,
    brand: { "@type": "Brand", name: siteName },
  };
}

function website(): SchemaNode {
  return {
    "@type": "WebSite",
    "@id": websiteId,
    url: siteUrl,
    name: siteName,
    publisher: { "@id": ownerId },
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
    publisher: { "@id": ownerId },
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
    "@graph": [owner(), website(), softwareApplication(), faqPage(faq)],
  };
}
