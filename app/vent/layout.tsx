import type { Metadata } from "next";

/* Anonymous user posts — kept out of the index deliberately. */
export const metadata: Metadata = {
  title: "Vent",
  description: "The anonymous PlayCircle community board.",
  robots: { index: false, follow: false },
};

export default function VentLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
