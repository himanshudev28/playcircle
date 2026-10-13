"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Icon } from "@/components/Icon";
import { getSocket, type LiveMedia, type StageQuality } from "@/lib/socket";
import type { LiveStageApi, LiveStageStats } from "./useLiveStage";

/* Fills the player box (the parent is `relative aspect-video`).
   - Viewer: the presenter's stream, with status overlays, quality and stats.
   - Presenter: a muted preview of the capture (tab/screen/camera) or the
     file's own <video controls> — that element *is* the source everyone else
     sees. A front camera is mirrored here only, like a mirror; viewers get
     the true picture. */

const LEVELS: { value: StageQuality; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "1080", label: "1080p" },
  { value: "720", label: "720p" },
  { value: "480", label: "480p" },
];

const SOURCE_NOUN: Record<LiveMedia["source"], string> = {
  tab: "tab",
  screen: "screen",
  file: "video",
  camera: "camera",
};

export function LiveStageView({
  api,
  media,
  isAdmin,
}: {
  api: LiveStageApi;
  media: LiveMedia;
  isAdmin: boolean;
}) {
  if (api.native) return <NativePresenterView api={api} media={media} />;
  if (api.isPresenter) return <PresenterView api={api} media={media} />;
  return <ViewerView api={api} media={media} isAdmin={isAdmin} />;
}

/* ------------------------------------------------------------- Viewer */

function ViewerView({
  api,
  media,
  isAdmin,
}: {
  api: LiveStageApi;
  media: LiveMedia;
  isAdmin: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const stream = api.remoteStream;

  // Try with sound first (the viewer has usually clicked in the room
  // already); if the browser refuses, fall back to muted + "Tap to unmute".
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stream;
    if (!stream) return;
    let cancelled = false;
    el.muted = false;
    el.play()
      .then(() => {
        if (!cancelled) {
          setMuted(false);
          setBlocked(false);
        }
      })
      .catch(() => {
        if (cancelled) return;
        el.muted = true;
        setMuted(true);
        setBlocked(true);
        el.play().catch(() => {});
      });
    return () => {
      cancelled = true;
    };
  }, [stream]);

  function toggleMute() {
    const el = videoRef.current;
    if (!el) return;
    const next = !el.muted;
    el.muted = next;
    setMuted(next);
    setBlocked(false);
    if (!next) el.play().catch(() => {});
  }

  const status = api.status;

  return (
    <div ref={wrapRef} className="group absolute inset-0 bg-ink">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className="absolute inset-0 h-full w-full bg-ink object-contain"
      />

      {status === "failed" ? (
        <Overlay>
          <p className="text-sm font-semibold">Couldn&apos;t connect to the share</p>
          <p className="max-w-xs text-xs text-smoke">
            Strict networks (offices, some mobile carriers) can block direct
            connections between browsers.
          </p>
          <button
            onClick={api.retry}
            className="mt-1 rounded-card bg-signal px-4 py-2 text-sm font-semibold transition hover:bg-signal-hot active:scale-95"
          >
            Retry
          </button>
        </Overlay>
      ) : status !== "live" || !stream ? (
        <Overlay>
          <Spinner />
          <p className="text-sm font-semibold">
            Connecting to {media.by}&apos;s {SOURCE_NOUN[media.source]}…
          </p>
        </Overlay>
      ) : null}

      {blocked && status === "live" && (
        <button
          onClick={toggleMute}
          className="absolute left-1/2 top-1/2 z-20 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-full bg-signal px-5 py-3 text-sm font-semibold shadow-[0_0_40px_-8px_rgba(244,67,60,0.85)] transition hover:bg-signal-hot active:scale-95"
        >
          <SpeakerIcon muted size={18} />
          Tap to unmute
        </button>
      )}

      {isAdmin && (
        <div className="absolute right-3 top-3 z-20">
          <button
            onClick={() => getSocket().emit("stage:stop", { streamId: media.streamId })}
            title="End this share for everyone"
            className="rounded-full border border-edge bg-ink/70 px-3 py-1.5 text-xs font-medium text-smoke backdrop-blur-sm transition hover:border-signal/50 hover:text-bone"
          >
            End share
          </button>
        </div>
      )}

      <Controls>
        <LiveChip media={media} />
        <div className="flex shrink-0 items-center gap-1.5">
          <StatsChip stats={api.stats} />
          <QualityMenu
            label="Quality"
            value={api.quality}
            onChange={api.setQuality}
          />
          <IconButton label={muted ? "Unmute" : "Mute"} onClick={toggleMute}>
            <SpeakerIcon muted={muted} size={16} />
          </IconButton>
          <FullscreenButton wrapRef={wrapRef} videoRef={videoRef} />
        </div>
      </Controls>
    </div>
  );
}

/* ---------------------------------------------------------- Presenter */

function PresenterView({ api, media }: { api: LiveStageApi; media: LiveMedia }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const isFile = media.source === "file";
  // Pulled out up front: passing a member of `api` as a ref makes the
  // compiler treat all of `api` as a ref.
  const {
    localPreview: preview,
    bindFileVideo,
    fileUrl,
    status,
    viewerCount,
    stats,
    cap,
    setCap,
    stopShare,
    camera,
    flipCamera,
  } = api;
  const mirrored = camera?.facing === "user";

  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    el.muted = true; // never play your own capture back
    el.srcObject = preview;
    if (preview) el.play().catch(() => {});
  }, [preview]);

  const watching =
    viewerCount === 1 ? "1 watching" : `${viewerCount} watching`;

  return (
    <div ref={wrapRef} className="group absolute inset-0 bg-ink">
      {isFile ? (
        <video
          ref={bindFileVideo}
          src={fileUrl ?? undefined}
          controls
          autoPlay
          playsInline
          className="absolute inset-0 h-full w-full bg-ink object-contain"
        />
      ) : (
        <video
          ref={previewRef}
          autoPlay
          playsInline
          muted
          className={`absolute inset-0 h-full w-full bg-ink object-contain ${
            mirrored ? "-scale-x-100" : ""
          }`}
        />
      )}

      {status === "starting" && (
        <Overlay>
          <Spinner />
          <p className="text-sm font-semibold">Starting your share…</p>
        </Overlay>
      )}

      {/* Banner: what you're sharing, who's watching, and the controls. */}
      <div className="absolute inset-x-0 top-0 z-20 flex flex-wrap items-center gap-2 bg-gradient-to-b from-ink/90 via-ink/60 to-transparent p-3 pb-8">
        <span className="flex min-w-[11rem] flex-1 items-center gap-2 text-sm">
          <LiveDot />
          <span className="truncate">
            You&apos;re sharing <span className="font-semibold">{media.title}</span>
            <span className="text-smoke"> · {watching}</span>
          </span>
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <StatsChip stats={stats} />
          <QualityMenu label="Max quality" value={cap} onChange={setCap} />
          {camera?.canFlip && (
            <IconButton
              label={
                camera.facing === "user" ? "Switch to back camera" : "Switch to front camera"
              }
              onClick={flipCamera}
            >
              <Icon name="flip" size={15} />
            </IconButton>
          )}
          <FullscreenButton wrapRef={wrapRef} videoRef={previewRef} />
          <button
            onClick={stopShare}
            className="flex items-center gap-1.5 rounded-full bg-signal px-3 py-1.5 text-xs font-semibold transition hover:bg-signal-hot active:scale-95"
          >
            <StopIcon />
            Stop sharing
          </button>
        </div>
        {isFile && (
          <p className="w-full text-[11px] text-smoke">
            Pausing or seeking here pauses or seeks for everyone.
          </p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------- Presenter, Android app */

// The Android app captures and sends the phone screen itself, so this page
// has no preview — showing one would mirror the screen into itself.
function NativePresenterView({ api, media }: { api: LiveStageApi; media: LiveMedia }) {
  const { status, viewerCount, cap, setCap, stopShare } = api;
  const watching = viewerCount === 1 ? "1 watching" : `${viewerCount} watching`;
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-ink px-6 text-center">
      {status === "starting" ? (
        <>
          <Spinner />
          <p className="text-sm font-semibold">Starting your screen share…</p>
          <p className="max-w-xs text-xs text-smoke">
            Tap “Start now” and pick “Entire screen” when Android asks.
          </p>
        </>
      ) : (
        <>
          <span className="flex items-center gap-2 text-sm">
            <LiveDot />
            <span>
              Your phone screen is live as{" "}
              <span className="font-semibold">{media.title}</span>
              <span className="text-smoke"> · {watching}</span>
            </span>
          </span>
          <p className="max-w-xs text-xs text-smoke">
            Open any app — everyone sees what&apos;s on your screen. Come back here or use
            the notification to stop.
          </p>
          <div className="flex items-center gap-2">
            <QualityMenu label="Max quality" value={cap} onChange={setCap} />
            <button
              onClick={stopShare}
              className="flex items-center gap-1.5 rounded-full bg-signal px-3 py-1.5 text-xs font-semibold transition hover:bg-signal-hot active:scale-95"
            >
              <StopIcon />
              Stop sharing
            </button>
          </div>
        </>
      )}
      {status === "starting" && (
        <button
          onClick={stopShare}
          className="rounded-full border border-edge px-3 py-1.5 text-xs font-medium text-smoke transition hover:bg-bone/5"
        >
          Cancel
        </button>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- Parts */

function Overlay({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-ink/80 px-6 text-center backdrop-blur-sm">
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="h-8 w-8 animate-spin rounded-full border-2 border-edge-strong border-t-signal"
    />
  );
}

function LiveDot() {
  return (
    <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-signal opacity-60" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-signal" />
    </span>
  );
}

/** Bottom bar: shown on hover/focus on desktop, always on touch screens. */
function Controls({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-x-0 bottom-0 z-20 flex items-end justify-between gap-2 bg-gradient-to-t from-ink/90 via-ink/50 to-transparent p-3 pt-10 transition-opacity duration-200 focus-within:opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
      {children}
    </div>
  );
}

function LiveChip({ media }: { media: LiveMedia }) {
  return (
    <span className="flex min-w-0 items-center gap-2 rounded-full border border-edge bg-ink/70 px-3 py-1.5 text-xs backdrop-blur-sm">
      <LiveDot />
      <span className="font-semibold tracking-wide text-signal-hot">LIVE</span>
      <span className="truncate text-bone">
        {media.title}
        <span className="text-smoke"> · by {media.by}</span>
      </span>
    </span>
  );
}

export function formatStats(s: LiveStageStats | null): string | null {
  if (!s) return null;
  const parts: string[] = [];
  if (s.width && s.height) parts.push(`${s.width}×${s.height}`);
  if (s.fps) parts.push(`${s.fps}fps`);
  if (s.kbps !== undefined) {
    parts.push(
      s.kbps >= 1000 ? `${(s.kbps / 1000).toFixed(1)} Mbps` : `${s.kbps} kbps`
    );
  }
  return parts.length ? parts.join(" · ") : null;
}

function StatsChip({ stats }: { stats: LiveStageStats | null }) {
  const text = formatStats(stats);
  if (!text) return null;
  return (
    <span className="group/stats relative">
      <button
        type="button"
        aria-label={`Stream stats: ${text}`}
        className="grid h-8 w-8 place-items-center rounded-full border border-edge bg-ink/70 text-smoke backdrop-blur-sm transition hover:text-bone"
      >
        <svg
          width={15}
          height={15}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M4 19V13M10 19V8M16 19v-4M22 19V5" />
        </svg>
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full right-0 mb-2 whitespace-nowrap rounded-card border border-edge bg-film-2 px-3 py-1.5 font-mono text-[11px] text-bone opacity-0 shadow-lg transition group-focus-within/stats:opacity-100 group-hover/stats:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}

function QualityMenu({
  label,
  value,
  onChange,
}: {
  label: string;
  value: StageQuality;
  onChange: (q: StageQuality) => void;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = LEVELS.find((l) => l.value === value)?.label ?? "Auto";

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        className="flex h-8 items-center gap-1 rounded-full border border-edge bg-ink/70 px-3 text-xs font-medium backdrop-blur-sm transition hover:bg-film-2"
      >
        {current}
        <Icon name="chevronDown" size={13} className="text-smoke" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          className="absolute bottom-full right-0 z-30 mb-2 w-36 overflow-hidden rounded-card border border-edge bg-film-2 py-1 shadow-xl"
        >
          <p className="data px-3 pb-1 pt-2 text-dim">{label}</p>
          {LEVELS.map((l) => (
            <button
              key={l.value}
              role="menuitemradio"
              aria-checked={l.value === value}
              onClick={() => {
                onChange(l.value);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm transition hover:bg-bone/5"
            >
              {l.label}
              {l.value === value && (
                <Icon name="check" size={14} className="text-signal-hot" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="grid h-8 w-8 place-items-center rounded-full border border-edge bg-ink/70 backdrop-blur-sm transition hover:bg-film-2"
    >
      {children}
    </button>
  );
}

type WebkitVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

function FullscreenButton({
  wrapRef,
  videoRef,
}: {
  wrapRef: RefObject<HTMLDivElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const [full, setFull] = useState(false);

  useEffect(() => {
    const onChange = () =>
      setFull(!!wrapRef.current && document.fullscreenElement === wrapRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [wrapRef]);

  function toggle() {
    const wrap = wrapRef.current;
    if (!wrap) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (typeof wrap.requestFullscreen === "function") {
      wrap.requestFullscreen().catch(() => {});
    } else {
      // iOS Safari: only the video element itself can go fullscreen.
      (videoRef.current as WebkitVideo | null)?.webkitEnterFullscreen?.();
    }
  }

  const label = full ? "Exit full screen" : "Full screen";
  return (
    <IconButton label={label} onClick={toggle}>
      <svg
        width={15}
        height={15}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {full ? (
          <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
        ) : (
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
        )}
      </svg>
    </IconButton>
  );
}

function SpeakerIcon({ muted, size }: { muted: boolean; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
      {muted ? (
        <path d="M16 9.5l5 5M21 9.5l-5 5" />
      ) : (
        <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
      )}
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2.5" />
    </svg>
  );
}
