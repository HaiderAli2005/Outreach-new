import type { Metadata } from "next";
import { Landing } from "@/components/marketing/Landing";
import { FAQS, SEO } from "@/lib/landingContent";

/** The public site address, for the canonical link and social cards. Set NEXT_PUBLIC_SITE_URL in production. */
const SITE = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");

export const metadata: Metadata = {
  title: { absolute: SEO.title },
  description: SEO.description,
  keywords: SEO.keywords,
  ...(SITE ? { metadataBase: new URL(SITE), alternates: { canonical: "/" } } : {}),
  openGraph: { type: "website", siteName: "Aperture", title: SEO.title, description: SEO.description, ...(SITE ? { url: SITE } : {}) },
  twitter: { card: "summary_large_image", title: SEO.title, description: SEO.description },
  robots: { index: true, follow: true },
};

/** Structured data: what the product is and costs, and the FAQ, so search results can show them directly. */
const jsonLd = [
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Aperture",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    description: SEO.description,
    ...(SITE ? { url: SITE } : {}),
    offers: { "@type": "Offer", price: "0.04", priceCurrency: "USD", description: "Per email sent. Prepaid, no plan, $10 free credit when you add a card." },
  },
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQS.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
  },
];

export default function Home() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
      <Landing />
    </>
  );
}
