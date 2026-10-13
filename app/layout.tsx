import type { Metadata, Viewport } from "next";
import { Sora, Manrope, Azeret_Mono } from "next/font/google";
import {
  SITE_DESCRIPTION,
  SITE_DESCRIPTION_SHORT,
  SITE_KEYWORDS,
  SITE_NAME,
  SITE_TAGLINE,
  SITE_URL,
} from "@/lib/site";
import { PwaSetup } from "@/components/InstallButton";
import "./globals.css";

/* Three roles, three faces:
   Sora     — display. Tight, slightly condensed, holds up at 7xl.
   Manrope  — body. Open counters, reads well at small sizes on black.
   Azeret   — data. Timecodes, room codes, latency. Squarish, instrument-like. */
const sora = Sora({
  variable: "--font-sora",
  subsets: ["latin"],
  display: "swap",
});

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
  display: "swap",
});

const azeret = Azeret_Mono({
  variable: "--font-azeret",
  subsets: ["latin"],
  display: "swap",
});

const TITLE = `${SITE_NAME} — ${SITE_TAGLINE}`;

export const metadata: Metadata = {
  /* Without metadataBase, OG images and canonicals stay relative — and every
     crawler ignores relative URLs in those slots. */
  metadataBase: new URL(SITE_URL),
  title: { default: TITLE, template: `%s · ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  keywords: SITE_KEYWORDS,
  applicationName: SITE_NAME,
  authors: [{ name: SITE_NAME, url: SITE_URL }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
  category: "entertainment",
  alternates: { canonical: "/" },
  /* iOS autolinks anything that looks like a phone number — room codes qualify. */
  formatDetection: { telephone: false, address: false, email: false },
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
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: SITE_NAME,
    locale: "en_US",
    title: TITLE,
    description: SITE_DESCRIPTION_SHORT,
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: SITE_DESCRIPTION_SHORT,
  },
  appleWebApp: { capable: true, title: SITE_NAME, statusBarStyle: "black-translucent" },
};

/* themeColor belongs to the viewport export — deprecated in `metadata` since 14. */
export const viewport: Viewport = {
  themeColor: "#060505", /* --color-ink */
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${sora.variable} ${manrope.variable} ${azeret.variable} h-full`}
    >
      <body className="grain min-h-full bg-ink text-bone">
        {children}
        <PwaSetup />
      </body>
    </html>
  );
}
