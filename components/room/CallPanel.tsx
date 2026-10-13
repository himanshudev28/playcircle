"use client";

import { useEffect, useRef } from "react";
import { Icon, type IconName } from "@/components/Icon";
import type { RoomUser } from "@/lib/socket";
import { useSpeaking, type CallApi } from "./useCall";

export function CallPanel({
  call,
  users,
  selfId,
}: {
  call: CallApi;
  users: RoomUser[];
  selfId: string | null;
}) {
  const callers = users.filter((u) => u.call);
  const others = callers.filter((u) => u.id !== selfId);
  const self = users.find((u) => u.id === selfId);

  if (!call.inCall) {
    return (
      <div className="flex flex-col gap-3 rounded-panel border border-edge bg-film p-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3 px-1">
          {callers.length > 0 ? (
            <div className="flex -space-x-2">
              {callers.slice(0, 4).map((u) => (
                <Avatar key={u.id} user={u} size={30} ring="border-film" />
              ))}
            </div>
          ) : (
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-edge bg-ink text-dim">
              <Icon name="headphones" size={17} />
            </span>
          )}
          <div className="min-w-0">
            <p className="text-sm font-semibold">
              {callers.length > 0
                ? `${callers.length} in the call`
                : "Voice & video"}
            </p>
            <p className="truncate text-xs text-smoke">
              {callers.length > 0
                ? callers.map((u) => u.name).join(", ")
                : "Talk face-to-face or voice-only while you watch."}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => call.join(false)}
            disabled={call.joining}
            className="flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-card border border-edge bg-bone/5 px-4 py-2.5 text-sm font-medium transition hover:bg-bone/10 disabled:opacity-50 sm:flex-none"
          >
            <Icon name="mic" size={16} />
            Join voice
          </button>
          <button
            onClick={() => call.join(true)}
            disabled={call.joining}
            className="flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-card bg-signal px-4 py-2.5 text-sm font-semibold transition hover:bg-signal-hot active:scale-95 disabled:opacity-50 sm:flex-none"
          >
            <Icon name="video" size={16} />
            {call.joining ? "Connecting…" : "Join with video"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-panel border border-edge bg-film p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
        {self && (
          <Tile
            user={self}
            stream={call.localStream}
            mic={call.mic}
            cam={call.cam}
            isSelf
          />
        )}
        {others.map((u) => (
          <Tile
            key={u.id}
            user={u}
            stream={call.remoteStreams[u.id] || null}
            mic={!!u.call?.mic}
            cam={!!u.call?.cam}
          />
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="px-1 text-xs text-smoke">
          {others.length === 0
            ? "You're the only one here — others can join from their call bar."
            : `${callers.length} in the call`}
        </p>
        <div className="flex gap-2">
          <ControlButton
            onClick={call.toggleMic}
            icon={call.mic ? "mic" : "micOff"}
            label={call.mic ? "Mute" : "Unmute"}
            off={!call.mic}
          />
          <ControlButton
            onClick={call.toggleCam}
            icon={call.cam ? "video" : "videoOff"}
            label={call.cam ? "Turn camera off" : "Turn camera on"}
            off={!call.cam}
          />
          <button
            onClick={call.leave}
            title="Leave call"
            aria-label="Leave call"
            className="grid h-10 w-14 place-items-center rounded-card bg-signal transition hover:bg-signal-hot active:scale-95"
          >
            <Icon name="phoneOff" size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

function ControlButton({
  onClick,
  icon,
  label,
  off,
}: {
  onClick: () => void;
  icon: IconName;
  label: string;
  off: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={!off}
      className={`grid h-10 w-10 place-items-center rounded-card border transition active:scale-95 ${
        off
          ? "border-signal/40 bg-signal/15 text-signal-hot hover:bg-signal/25"
          : "border-edge bg-bone/5 hover:bg-bone/10"
      }`}
    >
      <Icon name={icon} size={18} />
    </button>
  );
}

function Tile({
  user,
  stream,
  mic,
  cam,
  isSelf = false,
}: {
  user: RoomUser;
  stream: MediaStream | null;
  mic: boolean;
  cam: boolean;
  isSelf?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const speaking = useSpeaking(stream, mic);
  const showVideo = cam && !!stream?.getVideoTracks().length;

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = showVideo ? stream : null;
  }, [stream, showVideo]);

  // Remote audio plays through its own element so it never depends on
  // whether the video is showing. Your own mic is never played back.
  useEffect(() => {
    const el = audioRef.current;
    if (isSelf || !el) return;
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
  }, [stream, isSelf]);

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
          className={`h-full w-full object-cover ${isSelf ? "-scale-x-100" : ""}`}
        />
      ) : (
        <div className="grid h-full place-items-center">
          <Avatar user={user} size={44} ring="border-ink" />
        </div>
      )}
      {!isSelf && <audio ref={audioRef} autoPlay />}

      {!isSelf && !stream && (
        <span className="absolute right-2 top-2 rounded-full bg-ink/70 px-2 py-0.5 text-[10px] text-smoke">
          connecting…
        </span>
      )}

      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-ink/90 to-transparent px-2 pb-1.5 pt-4">
        {!mic && (
          <Icon name="micOff" size={13} className="shrink-0 text-signal-hot" />
        )}
        <span className="truncate text-xs font-medium">
          {user.name}
          {isSelf && <span className="text-smoke"> (you)</span>}
        </span>
      </div>
    </div>
  );
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
