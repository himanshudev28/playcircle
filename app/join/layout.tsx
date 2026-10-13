import type { Metadata } from "next";

/* The page itself is a client component, so its metadata lives here. */
export const metadata: Metadata = {
  title: "Start a Watch Party",
  description:
    "Create a private PlayCircle room or join one with a code. Paste a YouTube link and everyone watches in sync — no account juggling, no downloads.",
  alternates: { canonical: "/join" },
  openGraph: {
    type: "website",
    url: "/join",
    title: "Start a Watch Party · PlayCircle",
    description:
      "Create a private room or join with a code, then watch YouTube together in perfect sync.",
  },
};

export default function JoinLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
