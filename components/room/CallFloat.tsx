"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "@/components/Icon";
import type { RoomUser } from "@/lib/socket";
import { Avatar, Tile } from "./CallTile";
import type { CallApi } from "./useCall";

/* The call, floating over whatever you're watching: a small window of
   cameras you can drag to any corner, shrink to a pill, or send back to the
   call panel. It also covers the two "outside the page" cases:

   - Full screen: a fullscreen element hides everything that isn't inside
     it, so the window is portalled *into* the fullscreen element (when that
     element can hold children — a <video> or <iframe> can't).
   - Picture-in-picture: in a browser, "Pop out" paints the cameras onto a
     canvas and hands that to the browser's PiP window (one video is all PiP
     takes, so the cameras are composited into one). In the Android app the
     whole activity goes PiP and CallPip fills it with the cameras. */

type Corner = "tl" | "tr" | "bl" | "br";
type Size = "s" | "m";

const CORNER_KEY = "pc:callFloat:corner";
const SIZE_KEY = "pc:callFloat:size";

function load<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: just don't remember */
  }
}

/* ------------------------------------------------- fullscreen host */

function fullscreenHost(): Element | null {
  if (typeof document === "undefined") return null;
  const el =
    document.fullscreenElement ??
    (document as Document & { webkitFullscreenElement?: Element | null })
      .webkitFullscreenElement ??
    null;
  // Media and frames render their own content: children would never show.
  if (!el || /^(VIDEO|IFRAME|IMG|CANVAS)$/.test(el.tagName)) return null;
  return el;
}

function subscribeFullscreen(cb: () => void) {
  document.addEventListener("fullscreenchange", cb);
  document.addEventListener("webkitfullscreenchange", cb);
  return () => {
    document.removeEventListener("fullscreenchange", cb);
    document.removeEventListener("webkitfullscreenchange", cb);
  };
}

/** The element in full screen, if the call window can live inside it. */
export function useFullscreenHost(): Element | null {
  return useSyncExternalStore(subscribeFullscreen, fullscreenHost, () => null);
}

/* -------------------------------------------------------- who shows */

type Entry = {
  user: RoomUser;
  stream: MediaStream | null;
  mic: boolean;
  cam: boolean;
  isSelf: boolean;
};

function entries(call: CallApi, users: RoomUser[], selfId: string | null): Entry[] {
  const list: Entry[] = [];
  for (const u of users) {
    if (!u.call || u.id === selfId) continue;
    list.push({
      user: u,
      stream: call.remoteStreams[u.id] || null,
      mic: !!u.call.mic,
      cam: !!u.call.cam,
      isSelf: false,
    });
  }
  const self = users.find((u) => u.id === selfId);
  if (self) {
    list.push({ user: self, stream: call.localStream, mic: call.mic, cam: call.cam, isSelf: true });
  }
  return list;
}

/* ------------------------------------------------------ the window */

export function CallFloat({
  call,
  users,
  selfId,
  host,
  pip,
  onDock,
}: {
  call: CallApi;
  users: RoomUser[];
  selfId: string | null;
  /** Full-screen element to render inside; null → the page. */
  host: Element | null;
  /** The browser pop-out, owned by the call panel so it outlives this. */
  pip: SystemPip;
  /** Back to the call panel. Not offered in full screen (there's no panel). */
  onDock?: () => void;
}) {
  const [corner, setCorner] = useState<Corner>(() =>
    load(CORNER_KEY, ["tl", "tr", "bl", "br"] as const, "br")
  );
  const [size, setSize] = useState<Size>(() => load(SIZE_KEY, ["s", "m"] as const, "s"));
  const [minimized, setMinimized] = useState(false);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const start = useRef<{ px: number; py: number; moved: boolean } | null>(null);

  const all = entries(call, users, selfId);
  const others = all.filter((e) => !e.isSelf);
  // Faces first; cap the window at four tiles.
  const shown = [...others.slice(0, 3), ...all.filter((e) => e.isSelf)];
  const hidden = Math.max(0, others.length - 3);

  // Drag anywhere on the handle; let go and it snaps to the nearest corner.
  const onPointerDown = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    start.current = { px: e.clientX, py: e.clientY, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const s = start.current;
    if (!s) return;
    const dx = e.clientX - s.px;
    const dy = e.clientY - s.py;
    if (!s.moved && Math.hypot(dx, dy) < 6) return;
    s.moved = true;
    setDrag({ x: dx, y: dy });
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    const s = start.current;
    start.current = null;
    if (!s?.moved) {
      setDrag(null);
      if (minimized) setMinimized(false); // a tap on the pill opens it
      return;
    }
    const rect = boxRef.current?.getBoundingClientRect();
    setDrag(null);
    if (!rect) return;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const next: Corner = `${cy < window.innerHeight / 2 ? "t" : "b"}${
      cx < window.innerWidth / 2 ? "l" : "r"
    }` as Corner;
    setCorner(next);
    save(CORNER_KEY, next);
    e.preventDefault();
  };

  const place =
    (corner[0] === "t" ? "top-3 " : "bottom-[max(0.75rem,env(safe-area-inset-bottom))] ") +
    (corner[1] === "l" ? "left-3" : "right-3");
  const width = size === "s" ? "w-[10.5rem] sm:w-56" : "w-[15rem] sm:w-80";

  const toggleSize = () => {
    const next: Size = size === "s" ? "m" : "s";
    setSize(next);
    save(SIZE_KEY, next);
  };

  const box = (
    <div
      ref={boxRef}
      role="dialog"
      aria-label="Call"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        start.current = null;
        setDrag(null);
      }}
      style={drag ? { transform: `translate(${drag.x}px, ${drag.y}px)` } : undefined}
      className={`fixed ${place} z-[55] touch-none select-none overflow-hidden rounded-card border border-edge bg-film-2/95 text-bone shadow-2xl backdrop-blur ${
        drag ? "cursor-grabbing" : "cursor-grab transition-[top,left,right,bottom] duration-200"
      } ${minimized ? "" : width}`}
    >
      {minimized ? (
        <div className="flex items-center gap-2 px-2.5 py-2">
          <div className="flex -space-x-2">
            {all.slice(0, 3).map((e) => (
              <Avatar key={e.user.id} user={e.user} size={26} ring="border-film-2" />
            ))}
          </div>
          <span className="text-xs font-semibold">{all.length} in call</span>
          {!call.mic && <Icon name="micOff" size={13} className="text-signal-hot" />}
          <FloatButton icon="arrowRight" label="Show call" onClick={() => setMinimized(false)} small />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1 px-2 pb-1 pt-1.5">
            <span className="mr-auto flex items-center gap-1.5 pl-0.5 text-[11px] text-smoke">
              <GripIcon />
              {all.length} in call
            </span>
            <FloatButton
              icon="minus"
              label="Minimise"
              onClick={() => setMinimized(true)}
              small
            />
            <FloatButton
              icon={size === "s" ? "expand" : "shrink"}
              label={size === "s" ? "Bigger" : "Smaller"}
              onClick={toggleSize}
              small
            />
            {onDock && !host && (
              <FloatButton icon="dock" label="Back to the call panel" onClick={onDock} small />
            )}
          </div>

          <div className={`grid gap-1 px-1.5 ${shown.length > 2 ? "grid-cols-2" : "grid-cols-1"}`}>
            {shown.map((e) => (
              <Tile
                key={e.user.id}
                user={e.user}
                stream={e.stream}
                mic={e.mic}
                cam={e.cam}
                isSelf={e.isSelf}
                mirror={e.isSelf && call.facing === "user"}
                compact
              />
            ))}
          </div>
          {hidden > 0 && (
            <p className="px-2 pt-1 text-[10px] text-smoke">+{hidden} more in the call</p>
          )}
          {others.length === 0 && (
            <p className="px-2 pt-1 text-[10px] leading-snug text-smoke">
              Waiting for others to join…
            </p>
          )}

          <div className="flex items-center justify-center gap-1.5 px-1.5 pb-1.5 pt-1.5">
            <FloatButton
              icon={call.mic ? "mic" : "micOff"}
              label={call.mic ? "Mute" : "Unmute"}
              onClick={call.toggleMic}
              off={!call.mic}
            />
            <FloatButton
              icon={call.cam ? "video" : "videoOff"}
              label={call.cam ? "Turn camera off" : "Turn camera on"}
              onClick={call.toggleCam}
              off={!call.cam}
            />
            {call.cam && call.canFlip && (
              <FloatButton
                icon="flip"
                label={call.facing === "user" ? "Switch to back camera" : "Switch to front camera"}
                onClick={call.flipCam}
              />
            )}
            {pip.supported && (
              <FloatButton
                icon="pip"
                label={pip.active ? "Close the pop-out" : "Pop out (stays on top of other apps)"}
                onClick={pip.active ? pip.close : pip.open}
                on={pip.active}
              />
            )}
          </div>
        </>
      )}
    </div>
  );

  return createPortal(box, host ?? document.body);
}

/* ---------------------------------------- Android app's PiP window */

/** Fills the Android app's picture-in-picture window with the cameras. */
export function CallPip({
  call,
  users,
  selfId,
}: {
  call: CallApi;
  users: RoomUser[];
  selfId: string | null;
}) {
  const all = entries(call, users, selfId);
  const others = all.filter((e) => !e.isSelf);
  const self = all.find((e) => e.isSelf);
  const main = others.length ? others.slice(0, 4) : self ? [self] : [];

  return createPortal(
    <div className="fixed inset-0 z-[2147483647] bg-ink">
      <div
        className={`grid h-full w-full gap-0.5 ${
          main.length > 2 ? "grid-cols-2 grid-rows-2" : main.length === 2 ? "grid-cols-2" : ""
        }`}
      >
        {main.map((e) => (
          <PipFace key={e.user.id} entry={e} mirror={e.isSelf && call.facing === "user"} />
        ))}
      </div>
      {/* Your own camera rides in a corner once someone else is on screen. */}
      {others.length > 0 && self && self.cam && (
        <div className="absolute bottom-1 right-1 w-[30%] overflow-hidden rounded-md border border-edge">
          <PipFace entry={self} mirror={call.facing === "user"} />
        </div>
      )}
    </div>,
    document.body
  );
}

function PipFace({ entry, mirror }: { entry: Entry; mirror: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const showVideo = entry.cam && !!entry.stream?.getVideoTracks().length;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = showVideo ? entry.stream : null;
    if (showVideo) el.play().catch(() => {});
  }, [entry.stream, showVideo]);
  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden bg-ink">
      {showVideo ? (
        <video
          ref={ref}
          autoPlay
          playsInline
          muted
          className={`h-full w-full object-cover ${mirror ? "-scale-x-100" : ""}`}
        />
      ) : (
        <div className="grid h-full place-items-center">
          <Avatar user={entry.user} size={28} ring="border-ink" />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------ browser PiP ("Pop out") */

type PipVideo = HTMLVideoElement & {
  requestPictureInPicture?: () => Promise<unknown>;
};

function systemPipSupported(): boolean {
  if (typeof document === "undefined") return false;
  // The Android app has its own (whole-app) PiP; the WebView has none.
  if ((window as Window & { PlayCircleAndroid?: unknown }).PlayCircleAndroid) return false;
  return (
    !!(document as Document & { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled &&
    typeof HTMLCanvasElement.prototype.captureStream === "function"
  );
}

const W = 640;
const H = 360;

/* One canvas, every camera: PiP shows a single video, so the call is drawn
   into one. Painted on a timer (rAF stops when the tab is hidden, and a PiP
   window is mostly used with the tab hidden; a page in a call plays audio,
   so its timers aren't throttled away). */
export type SystemPip = ReturnType<typeof useSystemPip>;

export function useSystemPip(call: CallApi, users: RoomUser[], selfId: string | null) {
  const [active, setActive] = useState(false);
  const [supported] = useState(systemPipSupported);
  const latest = useRef<{ list: Entry[]; facing: CallApi["facing"] }>({ list: [], facing: "user" });
  const run = useRef<{ stop: () => void } | null>(null);

  useEffect(() => {
    latest.current = { list: entries(call, users, selfId), facing: call.facing };
  });

  const close = useCallback(() => {
    run.current?.stop();
  }, []);

  const open = useCallback(async () => {
    if (run.current) return;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext("2d");
    if (!g) return;
    const sources = new Map<MediaStream, HTMLVideoElement>();
    const sourceFor = (stream: MediaStream) => {
      let v = sources.get(stream);
      if (!v) {
        v = document.createElement("video");
        v.muted = true;
        v.playsInline = true;
        v.srcObject = stream;
        v.play().catch(() => {});
        sources.set(stream, v);
      }
      return v;
    };

    const paint = () => {
      const { list, facing } = latest.current;
      const others = list.filter((e) => !e.isSelf);
      const self = list.find((e) => e.isSelf);
      const main = others.length ? others.slice(0, 4) : self ? [self] : [];
      g.fillStyle = "#060505";
      g.fillRect(0, 0, W, H);
      const cols = main.length > 1 ? 2 : 1;
      const rows = main.length > 2 ? 2 : 1;
      const cw = W / cols;
      const ch = H / rows;
      main.forEach((e, i) => {
        drawFace(g, e, (i % cols) * cw, Math.floor(i / cols) * ch, cw, ch, e.isSelf && facing === "user");
      });
      if (others.length && self?.cam) {
        drawFace(g, self, W - 168, H - 100, 160, 92, facing === "user", true);
      }
      // Drop sources nobody's drawing any more.
      const live = new Set(list.map((e) => e.stream));
      for (const [s, v] of sources) {
        if (!live.has(s)) {
          v.srcObject = null;
          sources.delete(s);
        }
      }
    };

    const drawFace = (
      ctx: CanvasRenderingContext2D,
      e: Entry,
      x: number,
      y: number,
      w: number,
      h: number,
      mirror: boolean,
      framed = false
    ) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 1, y + 1, w - 2, h - 2);
      ctx.clip();
      ctx.fillStyle = "#100e0d";
      ctx.fillRect(x, y, w, h);
      const v = e.cam && e.stream?.getVideoTracks().length ? sourceFor(e.stream) : null;
      if (v && v.videoWidth) {
        // object-fit: cover
        const s = Math.max(w / v.videoWidth, h / v.videoHeight);
        const dw = v.videoWidth * s;
        const dh = v.videoHeight * s;
        if (mirror) {
          ctx.translate(x + w, y);
          ctx.scale(-1, 1);
          ctx.drawImage(v, (w - dw) / 2, (h - dh) / 2, dw, dh);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
        } else {
          ctx.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
        }
      } else {
        const r = Math.min(w, h) * 0.18;
        ctx.fillStyle = e.user.color;
        ctx.beginPath();
        ctx.arc(x + w / 2, y + h / 2, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#000";
        ctx.font = `700 ${Math.round(r)}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(e.user.name[0]?.toUpperCase() ?? "?", x + w / 2, y + h / 2);
      }
      ctx.restore();
      if (framed) {
        ctx.strokeStyle = "rgba(245,241,234,0.5)";
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);
      } else {
        ctx.fillStyle = "rgba(6,5,5,0.6)";
        ctx.fillRect(x, y + h - 26, w, 26);
        ctx.fillStyle = "#f5f1ea";
        ctx.font = "600 14px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(e.isSelf ? `${e.user.name} (you)` : e.user.name, x + 10, y + h - 13, w - 20);
      }
    };

    paint();
    const timer = setInterval(paint, 1000 / 15);
    const out = document.createElement("video") as PipVideo;
    out.muted = true;
    out.playsInline = true;
    out.srcObject = canvas.captureStream(15);

    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      for (const v of sources.values()) v.srcObject = null;
      sources.clear();
      (out.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
      out.srcObject = null;
      if (document.pictureInPictureElement === out) {
        document.exitPictureInPicture().catch(() => {});
      }
      run.current = null;
      setActive(false);
    };
    run.current = { stop };
    out.addEventListener("leavepictureinpicture", stop);
    try {
      await out.play();
      if (stopped) return; // left the call meanwhile
      await out.requestPictureInPicture!();
      if (stopped) {
        document.exitPictureInPicture().catch(() => {});
        return;
      }
      setActive(true);
    } catch {
      stop();
    }
  }, []);

  // Leaving the call (or the page) closes the pop-out.
  useEffect(() => {
    if (!call.inCall) run.current?.stop();
  }, [call.inCall]);
  useEffect(() => () => run.current?.stop(), []);

  return { supported, active, open, close };
}

/* ---------------------------------------------------------- parts */

function FloatButton({
  icon,
  label,
  onClick,
  off = false,
  on = false,
  small = false,
}: {
  icon: IconName | "minus" | "expand" | "shrink" | "dock";
  label: string;
  onClick: () => void;
  off?: boolean;
  on?: boolean;
  small?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`grid shrink-0 place-items-center rounded-full border transition active:scale-95 ${
        small ? "h-6 w-6" : "h-8 w-8"
      } ${
        off
          ? "border-signal/40 bg-signal/15 text-signal-hot hover:bg-signal/25"
          : on
            ? "border-bone/40 bg-bone/20 hover:bg-bone/25"
            : "border-edge bg-bone/5 hover:bg-bone/10"
      }`}
    >
      <Glyph name={icon} size={small ? 12 : 15} />
    </button>
  );
}

function Glyph({
  name,
  size,
}: {
  name: IconName | "minus" | "expand" | "shrink" | "dock";
  size: number;
}): ReactNode {
  const own: Record<string, ReactNode> = {
    minus: <path d="M5 12h14" />,
    expand: <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />,
    shrink: <path d="M20 10h-6V4M4 14h6v6M14 10l7-7M10 14l-7 7" />,
    dock: (
      <>
        <rect x="3.5" y="4.5" width="17" height="15" rx="2.4" />
        <path d="M3.5 14.5h17" />
      </>
    ),
  };
  if (name in own) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {own[name]}
      </svg>
    );
  }
  return <Icon name={name as IconName} size={size} />;
}

function GripIcon() {
  return (
    <svg width={10} height={10} viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="2" r="1" />
      <circle cx="7" cy="2" r="1" />
      <circle cx="3" cy="5" r="1" />
      <circle cx="7" cy="5" r="1" />
      <circle cx="3" cy="8" r="1" />
      <circle cx="7" cy="8" r="1" />
    </svg>
  );
}
