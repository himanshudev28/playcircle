import { Intro } from "@/components/landing/Intro";
import { ScrubRibbon } from "@/components/ScrubRibbon";
import { Nav } from "@/components/landing/Nav";
import { Hero } from "@/components/landing/Hero";
import { Stats } from "@/components/landing/Stats";
import { UseCases } from "@/components/landing/UseCases";
import { Steps } from "@/components/landing/Steps";
import { PreFaq, PRE_FAQ_ITEMS } from "@/components/landing/PreFaq";
import { Features } from "@/components/landing/Features";
import { RoomPreview } from "@/components/landing/RoomPreview";
import { BigFaq, BIG_FAQ_ITEMS } from "@/components/landing/BigFaq";
import { Footer } from "@/components/landing/Footer";
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/site";

/* One @graph rather than several loose <script> blocks: the nodes cross-
   reference by @id, so the app, the site, and the FAQ are read as one entity
   instead of three unrelated ones. */
const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE_URL}/#organization`,
      name: SITE_NAME,
      url: SITE_URL,
      logo: `${SITE_URL}/icon.svg`,
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      name: SITE_NAME,
      url: SITE_URL,
      description: SITE_DESCRIPTION,
      inLanguage: "en-US",
      publisher: { "@id": `${SITE_URL}/#organization` },
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE_URL}/#app`,
      name: SITE_NAME,
      url: SITE_URL,
      applicationCategory: "EntertainmentApplication",
      operatingSystem: "Web",
      browserRequirements: "Requires a modern browser with JavaScript enabled.",
      description: SITE_DESCRIPTION,
      featureList: [
        "Synchronized YouTube playback",
        "Private rooms with shareable invite codes",
        "Live room chat and reactions",
        "Public lobbies and direct messages",
      ],
      publisher: { "@id": `${SITE_URL}/#organization` },
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
        availability: "https://schema.org/InStock",
      },
    },
    {
      "@type": "FAQPage",
      "@id": `${SITE_URL}/#faq`,
      isPartOf: { "@id": `${SITE_URL}/#website` },
      /* Both FAQ blocks on the page, merged — Google honours one FAQPage per URL. */
      mainEntity: [...PRE_FAQ_ITEMS, ...BIG_FAQ_ITEMS].map((i) => ({
        "@type": "Question",
        name: i.q,
        acceptedAnswer: { "@type": "Answer", text: i.a },
      })),
    },
  ],
};

export default function Home() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <Intro />
      <ScrubRibbon />
      <Nav />
      <main>
        <Hero />
        <Stats />
        <UseCases />
        <Steps />
        <PreFaq />
        <Features />
        <RoomPreview />
        <BigFaq />
      </main>
      <Footer />
    </>
  );
}
