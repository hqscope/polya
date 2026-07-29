import type { Metadata, Viewport } from "next";
import { Instrument_Sans } from "next/font/google";

import { defaultOpenGraph, orgName, siteDescription, siteUrl } from "@/lib/seo";

import "./globals.css";

const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-instrument",
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  applicationName: "Polya",
  category: "education",
  creator: orgName,
  publisher: orgName,
  title: {
    default: "Polya — AI study help that teaches",
    template: "%s | Polya",
  },
  description: siteDescription,
  openGraph: { ...defaultOpenGraph, url: "/" },
  twitter: { card: "summary_large_image" },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  formatDetection: { telephone: false, address: false, email: false },
  verification: {
    ...(process.env.GOOGLE_SITE_VERIFICATION && {
      google: process.env.GOOGLE_SITE_VERIFICATION,
    }),
    ...(process.env.BING_SITE_VERIFICATION && {
      other: { "msvalidate.01": process.env.BING_SITE_VERIFICATION },
    }),
  },
};

export const viewport: Viewport = {
  themeColor: "#f7f8f8",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={instrumentSans.variable}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
