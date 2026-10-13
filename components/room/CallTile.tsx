"use client";

import { useEffect, useRef } from "react";
import { Icon } from "@/components/Icon";
import type { RoomUser } from "@/lib/socket";
import { useSpeaking } from "./useCall";

/* The pieces a call is drawn with, shared by the call panel and the floating
   call window (CallFloat). Tiles are picture only: everyone's sound plays
   through CallAudio, once, so moving the tiles between the panel, the
   floating window and picture-in-picture never doubles or drops a voice. */

export function Tile({
  user,
  stream,
  mic,
  cam,
  isSelf = false,
  mirror = false,
  compact = false,
}: {
  user: RoomUser;
  stream: MediaStream | null;
  mic: boolean;
  cam: boolean;
  isSelf?: boolean;
  /** Your own front camera reads like a mirror; everyone else sees it true. */
  mirror?: boolean;
  /** Small tiles (floating window): smaller name, no "connecting" badge. */
  compact?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const speaking = useSpeaking(stream, mic);
  const showVideo = cam && !!stream?.getVideoTracks().length;

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = showVideo ? stream : null;
    // A tile that remounts (panel ↔ floating) must start playing again.
    if (showVideo) el.play().catch(() => {});
  }, [stream, showVideo]);

  return (
    <div
      className={`relative aspect-video overflow-hidden rounded-card border bg-ink transition-[border-color,box-shadow] duration-150 ${
        speaking
          ? "border-emerald-400/80 shadow-[0_0_0_1px_rgba(52,211,153,0.6)]"
          : "border-edge"
      }`}
    >
      {showVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`h-full w-full object-cover ${mirror ? "-scale-x-100" : ""}`}
        />
      ) : (
        <div className="grid h-full place-items-center">
          <Avatar user={user} size={compact ? 30 : 44} ring="border-ink" />
        </div>
      )}

      {!isSelf && !stream && !compact && (
        <span className="absolute right-2 top-2 rounded-full bg-ink/70 px-2 py-0.5 text-[10px] text-smoke">
          connecting…
        </span>
      )}

      <div
        className={`absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-ink/90 to-transparent ${
          compact ? "px-1.5 pb-1 pt-3" : "px-2 pb-1.5 pt-4"
        }`}
      >
        {!mic && (
          <Icon
            name="micOff"
            size={compact ? 11 : 13}
            className="shrink-0 text-signal-hot"
          />
        )}
        <span className={`truncate font-medium ${compact ? "text-[10px]" : "text-xs"}`}>
          {user.name}
          {isSelf && <span className="text-smoke"> (you)</span>}
        </span>
      </div>
    </div>
  );
}

/** Everyone else's sound, one <audio> per person, wherever their tile is. */
export function CallAudio({ streams }: { streams: Record<string, MediaStream> }) {
  return (
    <>
      {Object.entries(streams).map(([id, stream]) => (
        <RemoteAudio key={id} stream={stream} />
      ))}
    </>
  );
}

function RemoteAudio({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    // Autoplay can still be refused (e.g. no click on the page yet); retry
    // on the next tap anywhere rather than leaving the call silent.
    let cancelled = false;
    const retry = () => el.play().catch(() => {});
    el.play().catch(() => {
      if (!cancelled) {
        document.addEventListener("pointerdown", retry, { once: true });
      }
    });
    return () => {
      cancelled = true;
      document.removeEventListener("pointerdown", retry);
    };
  }, [stream]);

  return <audio ref={ref} autoPlay />;
}

export function Avatar({
  user,
  size = 32,
  ring = "border-film",
}: {
  user: Pick<RoomUser, "name" | "color">;
  size?: number;
  ring?: string;
}) {
  return (
    <span
      title={user.name}
      className={`grid shrink-0 place-items-center rounded-full border-2 font-bold text-black ${ring}`}
      style={{
        background: user.color,
        width: size,
        height: size,
        fontSize: Math.round(size * 0.38),
      }}
    >
      {user.name[0]?.toUpperCase()}
    </span>
  );
}
