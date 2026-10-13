import type { Metadata } from "next";

/* A live feed of user-created rooms: nothing here is stable enough to rank,
   and indexing it would expose room listings that turn over by the minute. */
export const metadata: Metadata = {
  title: "Lobby",
  description: "Browse public PlayCircle rooms that are open to join right now.",
  robots: { index: false, follow: false },
};

export default function LobbyLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
