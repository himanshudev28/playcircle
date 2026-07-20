import { Suspense } from "react";
import { RoomClient } from "@/components/room/RoomClient";

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
