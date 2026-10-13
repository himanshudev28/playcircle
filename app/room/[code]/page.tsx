import { Suspense } from "react";
import type { Metadata } from "next";
import { RoomClient } from "@/components/room/RoomClient";

/* Rooms are private and short-lived. The title still carries the code so an
   invite link previews usefully in chat apps, but crawlers are kept out. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ code: string }>;
}): Promise<Metadata> {
  const { code } = await params;
  const room = decodeURIComponent(code).toUpperCase();

  return {
    title: `Room ${room}`,
    description: `Join room ${room} on PlayCircle and watch YouTube together, in sync.`,
    robots: { index: false, follow: false, nocache: true },
    openGraph: {
      type: "website",
      title: `Join room ${room} · PlayCircle`,
      description: "Someone invited you to watch together. The video is already rolling.",
    },
  };
}

export default async function RoomPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return (
    <Suspense fallback={<div className="min-h-screen bg-black" />}>
      <RoomClient code={decodeURIComponent(code).toUpperCase()} />
    </Suspense>
  );
}
