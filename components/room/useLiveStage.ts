"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { Socket } from "socket.io-client";
import {
  getSocket,
  type Media,
  type PlayerAction,
  type RoomSnapshot,
  type ShareSource,
  type StageQuality,
} from "@/lib/socket";
import { iceServers } from "@/lib/ice";
import {
  onNativeToast,
  setNativeCap,
  setNativeVoice,
  startNativeShare,
  stopNativeShare,
  useInNativeApp,
  useNativeShare,
} from "@/lib/nativeApp";

/* Live stage: one presenter streams a browser tab, a screen, a camera or a
   local video file to everyone else in the room over WebRTC.

   Phones: no mobile browser has getDisplayMedia, so tab/screen are desktop
   only. Phones can share a camera (getUserMedia) or a video file — the file
   is captured with captureStream() where it exists (Chrome, Firefox) and by
   painting it onto a canvas plus Web Audio where it doesn't (Safari, iOS).

   Topology is a one-to-many mesh: the presenter holds one RTCPeerConnection
   per viewer and always makes the offer (sendonly); viewers only answer
   (recvonly). Socket.IO carries the signalling as stage:* events, and every
   one of them is scoped by the share's `streamId`, so nothing from an older
   share can leak into a newer one.

   Within a share, a viewer can ask again (retry / reconnect) and the
   presenter rebuilds that one connection. Each rebuild gets a negotiation
   number `n` that rides along inside the signal payload and is echoed back,
   so an answer or candidate meant for a connection that was already replaced
   is dropped instead of being applied to its successor.

   Every connection is built with one video and one audio transceiver up
   front. Changing what's sent (a file's tracks appearing after load, a source
   switch) is a replaceTrack() — never a renegotiation.

   Past ~8 viewers the presenter's upload is the bottleneck; that needs an SFU. */

const MAX_VIEWERS = 8;
/** A viewer with no working connection after this long asks again. */
const CONNECT_TIMEOUT = 10_000;
/** How many times a viewer re-sends stage:want before giving up. */
const MAX_REWANTS = 3;
/** A "disconnected" link gets this long to recover before a retry. */
const DISCONNECT_GRACE = 5_000;
const STATS_INTERVAL = 2_000;
const ACK_TIMEOUT = 8_000;
/** A rejoin's room:state doesn't re-send a stage:want sent this recently. */
const WANT_DEDUPE = 1_500;

const TARGET_HEIGHT: Record<Exclude<StageQuality, "auto">, number> = {
  "1080": 1080,
  "720": 720,
  "480": 480,
};
const MAX_BITRATE: Record<Exclude<StageQuality, "auto">, number> = {
  "1080": 4_500_000,
  "720": 2_500_000,
  "480": 1_200_000,
};
const RANK: Record<StageQuality, number> = { auto: 4, "1080": 3, "720": 2, "480": 1 };

/** The more restrictive of two quality levels. */
function lowerOf(a: StageQuality, b: StageQuality): StageQuality {
  return RANK[a] <= RANK[b] ? a : b;
}

/* ------------------------------------------------------------------ Types */

export type LiveStageStats = {
  width?: number;
  height?: number;
  fps?: number;
  kbps?: number;
};

export type LiveStageApi = {
  /** Feature detection; tab/screen are false on phones (screen is true in
      the Android app, which shares the whole phone screen natively). */
  supported: { tab: boolean; screen: boolean; file: boolean; camera: boolean };
  isPresenter: boolean;
  /** Presenting through the Android app: no preview or stats on this page. */
  native: boolean;
  /** Android app share: whether its sound / the mic goes out too. */
  nativeAudio: { sound: boolean; voice: boolean; setVoice: (on: boolean) => void } | null;
  status: "idle" | "starting" | "connecting" | "live" | "failed";
  /** Viewer: the presenter's stream. */
  remoteStream: MediaStream | null;
  /** Presenter: tab/screen capture preview. */
  localPreview: MediaStream | null;
  /** Presenter: local file object URL. */
  fileUrl: string | null;
  /** Presenter, camera share: which way it faces and whether it can flip. */
  camera: { facing: Facing; canFlip: boolean } | null;
  /** Presenter, camera share: switch between front and back cameras. */
  flipCamera: () => void;
  /** Presenter, camera share: mute/unmute its mic (off while in a call). */
  setCameraMic: (on: boolean) => void;
  /** Call from the click that opens the file picker: Safari only lets an
      AudioContext start inside a user gesture, and the file's sound needs one. */
  primeFileShare: () => void;
  /** Presenter: ref callback for the file <video>. Stable identity. */
  bindFileVideo: (el: HTMLVideoElement | null) => void;
  /** Presenter: connected viewers. */
  viewerCount: number;
  stats: LiveStageStats | null;
  /** Presenter: quality ceiling for everyone. */
  cap: StageQuality;
  setCap: (q: StageQuality) => void;
  /** Viewer: preference sent to the presenter (stage:quality). */
  quality: StageQuality;
  setQuality: (q: StageQuality) => void;
  startShare: (source: ShareSource, file?: File, opts?: ShareOpts) => Promise<void>;
  stopShare: () => void;
  /** Viewer: start over after "failed" (re-sends stage:want). */
  retry: () => void;
};

export type Facing = "user" | "environment";
export type ShareOpts = {
  /** camera: send the microphone too (off while in a call — it already
      carries your voice). */
  withAudio?: boolean;
};

type Signal = {
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  /** Negotiation number of the presenter-side connection (echoed back). */
  n?: number;
};
type SignalMsg = { from: string; streamId: string; data: Signal };
type StartReply = { ok: boolean; streamId?: string; error?: string };

type PresState = {
  phase: "starting" | "live";
  source: ShareSource;
  streamId: string | null;
  preview: MediaStream | null;
  fileUrl: string | null;
  facing?: Facing;
  canFlip?: boolean;
};
type ViewState = {
  streamId: string;
  status: "connecting" | "live" | "failed";
  stream: MediaStream | null;
};
type StatsState = { key: string; value: LiveStageStats };

/** Presenter-side: everything about the share in progress. */
type Share = {
  source: ShareSource;
  streamId: string | null;
  /** tab/screen: the getDisplayMedia stream. file: the captured stream. */
  stream: MediaStream | null;
  video: MediaStreamTrack | null;
  audio: MediaStreamTrack | null;
  fileUrl: string | null;
  fileEl: HTMLVideoElement | null;
  /** file: one capture per element. React 19 re-runs ref callbacks
      (element → null → element, e.g. under StrictMode), so a re-bind reuses
      the element's capture instead of starting (and leaking) another. */
  captures: Map<HTMLVideoElement, MediaStream>;
  /** Firefox's mozCaptureStream silences the element; this plays it back. */
  monitor: HTMLAudioElement | null;
  detach: (() => void) | null;
  /** camera: which way the camera faces; set while a flip is in flight. */
  facing: Facing;
  flipping: boolean;
};

/** Presenter-side: one viewer's connection. */
type ViewerPeer = {
  pc: RTCPeerConnection;
  n: number;
  videoTx: RTCRtpTransceiver;
  audioTx: RTCRtpTransceiver;
  queued: RTCIceCandidateInit[];
  connected: boolean;
  /** setParameters calls must not overlap (transactionId). */
  chain: Promise<void>;
};

/** Viewer-side: the connection to the current presenter. */
type ViewerCtl = {
  streamId: string;
  presenter: string;
  pc: RTCPeerConnection | null;
  n: number | undefined;
  queued: RTCIceCandidateInit[];
  stream: MediaStream | null;
  live: boolean;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
};

type Setters = {
  setPres: Dispatch<SetStateAction<PresState | null>>;
  setView: Dispatch<SetStateAction<ViewState | null>>;
  setViewerCount: Dispatch<SetStateAction<number>>;
  setStats: Dispatch<SetStateAction<StatsState | null>>;
  setCap: Dispatch<SetStateAction<StageQuality>>;
  setQuality: Dispatch<SetStateAction<StageQuality>>;
};

type CapturableVideo = HTMLVideoElement & {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
};

type SendParams = RTCRtpSendParameters & {
  degradationPreference?: "maintain-framerate" | "maintain-resolution" | "balanced";
};

/* ------------------------------------------------------ Feature detection */

const NOTHING = { tab: false, screen: false, file: false, camera: false };
let detected: typeof NOTHING | null = null;

/** Phones and tablets: no screen capture worth offering. */
export function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } })
    .userAgentData;
  if (uaData?.mobile) return true;
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua)) return true;
  // iPadOS reports itself as a Mac.
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

function detectSupport(): typeof NOTHING {
  if (detected) return detected;
  if (typeof window === "undefined") return NOTHING;
  const rtc = typeof RTCPeerConnection !== "undefined";
  const mobile = isMobileDevice();
  const display =
    rtc && !mobile && typeof navigator.mediaDevices?.getDisplayMedia === "function";
  const file = rtc && (hasNativeFileCapture() || canCanvasCapture());
  const camera = rtc && typeof navigator.mediaDevices?.getUserMedia === "function";
  detected = { tab: display, screen: display, file, camera };
  return detected;
}

function hasNativeFileCapture(): boolean {
  const proto = HTMLMediaElement.prototype as unknown as Record<string, unknown>;
  return (
    typeof proto.captureStream === "function" ||
    typeof proto.mozCaptureStream === "function"
  );
}

function canCanvasCapture(): boolean {
  return (
    typeof HTMLCanvasElement.prototype.captureStream === "function" && !!audioCtor()
  );
}

function audioCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext ||
    null
  );
}

const noSubscribe = () => () => {};
const serverSupport = () => NOTHING;

/* ---------------------------------------------------------------- Helpers */

function stopAll(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((t) => t.stop());
}

function errName(e: unknown): string {
  return e && typeof e === "object" && "name" in e ? String(e.name) : "";
}

function errMessage(e: unknown): string {
  return e && typeof e === "object" && "message" in e ? String(e.message) : "";
}

async function getDisplay(source: "tab" | "screen"): Promise<MediaStream> {
  const video = {
    frameRate: { ideal: 30 },
    height: { ideal: 1080 },
    displaySurface: source === "tab" ? "browser" : "monitor",
  };
  const opts = {
    video,
    audio: true,
    preferCurrentTab: false,
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
    systemAudio: "include",
  };
  const md = navigator.mediaDevices;
  try {
    return await md.getDisplayMedia(opts as DisplayMediaStreamOptions);
  } catch (e) {
    // Browsers that can't capture audio (or dislike an option) reject the
    // whole request; try again with video only.
    const name = errName(e);
    if (name === "TypeError" || name === "NotSupportedError") {
      return md.getDisplayMedia({ video, audio: false } as DisplayMediaStreamOptions);
    }
    throw e;
  }
}

function cameraVideo(facing: Facing): MediaTrackConstraints {
  return {
    facingMode: { ideal: facing },
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
  };
}

async function getCamera(facing: Facing, withAudio: boolean): Promise<MediaStream> {
  const md = navigator.mediaDevices;
  const audio = withAudio ? { echoCancellation: true, noiseSuppression: true } : false;
  try {
    return await md.getUserMedia({ video: cameraVideo(facing), audio });
  } catch (e) {
    // A missing or busy mic shouldn't cost the picture.
    const name = errName(e);
    if (withAudio && (name === "NotFoundError" || name === "NotReadableError")) {
      return md.getUserMedia({ video: cameraVideo(facing), audio: false });
    }
    throw e;
  }
}

async function cameraCount(): Promise<number> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "videoinput").length;
  } catch {
    return 0;
  }
}

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/** Canvas captures also hold a paint loop and an audio graph. */
const captureStops = new WeakMap<MediaStream, () => void>();

function stopCapture(stream: MediaStream) {
  captureStops.get(stream)?.();
  captureStops.delete(stream);
  stopAll(stream);
}

/* Safari (and so every iPhone browser) can't captureStream() a <video>:
   paint the element onto a canvas and capture that, and route its sound
   through Web Audio. A <video> can only ever have one MediaElementSource,
   so this runs at most once per element (the captures map sees to that). */
function canvasCapture(el: HTMLVideoElement, ctx: AudioContext | null): MediaStream {
  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d");
  // Phones pay for every pixel twice (paint + encode).
  const maxHeight = isMobileDevice() ? 720 : 1080;
  const draw = () => {
    const vw = el.videoWidth;
    const vh = el.videoHeight;
    if (!g || !vw || !vh) return;
    const scale = Math.min(1, maxHeight / vh);
    const w = Math.round((vw * scale) / 2) * 2;
    const h = Math.round((vh * scale) / 2) * 2;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    g.drawImage(el, 0, 0, w, h);
  };

  const fv = el as FrameVideo;
  let stopped = false;
  let handle = 0;
  const viaFrames = typeof fv.requestVideoFrameCallback === "function";
  const loop = () => {
    if (stopped) return;
    draw();
    handle = viaFrames ? fv.requestVideoFrameCallback!(loop) : requestAnimationFrame(loop);
  };
  loop();
  // Paused or seeked: no new frames, but a viewer joining now still needs a
  // picture, so repaint now and then.
  const idle = setInterval(() => {
    if (el.paused) draw();
  }, 1000);
  el.addEventListener("seeked", draw);
  el.addEventListener("loadeddata", draw);

  const tracks: MediaStreamTrack[] = [...canvas.captureStream(30).getVideoTracks()];
  let source: MediaElementAudioSourceNode | null = null;
  let dest: MediaStreamAudioDestinationNode | null = null;
  if (ctx) {
    try {
      source = ctx.createMediaElementSource(el);
      dest = ctx.createMediaStreamDestination();
      source.connect(dest);
      // The element's sound now only reaches the speakers through the graph.
      source.connect(ctx.destination);
      tracks.push(...dest.stream.getAudioTracks());
    } catch {
      source = null; // picture only
    }
  }
  const resume = () => {
    if (ctx && ctx.state !== "running") ctx.resume().catch(() => {});
  };
  resume();
  el.addEventListener("play", resume);

  const stream = new MediaStream(tracks);
  captureStops.set(stream, () => {
    stopped = true;
    if (viaFrames) fv.cancelVideoFrameCallback?.(handle);
    else cancelAnimationFrame(handle);
    clearInterval(idle);
    el.removeEventListener("seeked", draw);
    el.removeEventListener("loadeddata", draw);
    el.removeEventListener("play", resume);
    // Keep source → speakers: the element may still be on screen.
    if (source && dest) {
      try {
        source.disconnect(dest);
      } catch {
        /* already gone */
      }
    }
  });
  return stream;
}

/** A readable name for what was picked. Chrome labels tabs with internal ids. */
function shareTitle(source: ShareSource, track: MediaStreamTrack): string {
  const surface = (track.getSettings() as MediaTrackSettings & {
    displaySurface?: string;
  }).displaySurface;
  const label = track.label.trim();
  const readable =
    !!label &&
    !label.includes("://") &&
    !/^(screen|window|tab|web-contents)[:\s-]/i.test(label) &&
    // Opaque ids (e.g. a canvas or virtual-camera track) aren't names.
    !/^[A-Za-z0-9+/=_-]{20,}$/.test(label);
  if (surface === "monitor") return "Screen";
  if (surface === "window") return readable ? label : "A window";
  if (surface === "browser" || source === "tab") {
    return readable ? label : "Browser tab";
  }
  return "Screen";
}

/** Can this browser decode the file at all? Resolves false on a decode error. */
function probeVideo(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      v.onloadedmetadata = null;
      v.onerror = null;
      v.removeAttribute("src");
      v.load();
      resolve(ok);
    };
    // A huge file on a slow disk: let the real element have a go.
    const timer = setTimeout(() => done(true), 8000);
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () => done(true);
    v.onerror = () => done(false);
    v.src = url;
  });
}

/* ----------------------------------------------------------------- Engine */

/* All the WebRTC bookkeeping lives in one plain object, created once per
   hook instance. React only sees the state it pushes through the setters. */
class StageEngine {
  private toast: (msg: string) => void = () => {};

  private set: Setters;
  private socket: Socket | null = null;

  // presenter
  private share: Share | null = null;
  private peers = new Map<string, ViewerPeer>();
  private prefs = new Map<string, StageQuality>();
  private negotiation = 0;
  private cap: StageQuality = "auto";
  private warnedFull = false;
  /** Canvas file captures route sound through this; made in a gesture. */
  private audioCtx: AudioContext | null = null;

  // viewer
  private viewer: ViewerCtl | null = null;
  private quality: StageQuality = "auto";
  /** The last stage:want we sent, so room:state doesn't double it up. */
  private lastWant: { streamId: string; sid: string | undefined; at: number } | null =
    null;

  /** room:denied (removed, room ended, password): we're outside the room
      until the next room:state, so there's nobody to tell about a stop. */
  private outside = false;

  // stats: last byte/frame counters per report, per connection
  private prev = new WeakMap<
    RTCPeerConnection,
    Map<string, { bytes: number; frames: number; ts: number }>
  >();

  constructor(setters: Setters) {
    this.set = setters;
  }

  setToast(fn: (msg: string) => void) {
    this.toast = fn;
  }

  private emit(ev: string, payload: unknown) {
    (this.socket ?? getSocket()).emit(ev, payload);
  }

  /* ---------------------------------------------------- socket wiring */

  attach = (socket: Socket) => {
    this.socket = socket;
    const onViewer = ({ id, streamId }: { id: string; streamId: string }) => {
      if (this.share?.streamId && this.share.streamId === streamId) {
        // offerTo closes its own connection on failure (and only that one).
        this.offerTo(id).catch(() => {});
      }
    };
    const onLeft = ({ id, streamId }: { id: string; streamId: string }) => {
      if (this.share?.streamId !== streamId) return;
      this.prefs.delete(id);
      this.closePeer(id);
    };
    const onQuality = ({
      id,
      streamId,
      level,
    }: {
      id: string;
      streamId: string;
      level: StageQuality;
    }) => {
      if (this.share?.streamId !== streamId || !(level in RANK)) return;
      this.prefs.set(id, level);
      this.applyParams(id);
    };
    const onSignal = (msg: SignalMsg) => {
      this.onSignal(msg).catch(() => {});
    };
    // The stage moved on without us (an admin ended it, we lost video
    // permission, someone loaded something else): end locally.
    const checkStage = (media: Media | null | undefined) => {
      const share = this.share;
      // A share of ours the server still has but we don't (the stage:start
      // ack timed out and we cleaned up): take it down. A share still
      // waiting on its ack is skipped — the server announces the load
      // before it replies.
      if (
        media?.kind === "live" &&
        !!socket.id &&
        media.presenter === socket.id &&
        media.streamId !== share?.streamId &&
        !(share && !share.streamId)
      ) {
        this.emit("stage:stop", { streamId: media.streamId });
      }
      if (!share?.streamId) return;
      if (media?.kind === "live" && media.streamId === share.streamId) return;
      this.endLocal(share);
      this.toast("Your share has ended");
    };
    const onAction = (a: PlayerAction) => {
      if (a?.type === "load") checkStage(a.media ?? null);
    };
    const onState = (snap: RoomSnapshot) => {
      this.outside = false;
      checkStage(snap?.media ?? null);
      // Rejoined after a drop: if we were watching, ask again right away —
      // unless the watch effect (re-run for the new socket id) just did.
      const v = this.viewer;
      if (v && !v.live) {
        const w = this.lastWant;
        if (
          w &&
          w.streamId === v.streamId &&
          w.sid === socket.id &&
          Date.now() - w.at < WANT_DEDUPE
        ) {
          return;
        }
        v.attempts = 0;
        this.sendWant(v);
      }
    };
    // Removed, the room ended, or a password is needed: we're not in the
    // room any more, so everything stops locally. No stage:stop — the
    // server already dropped us (and our share with us).
    const onDenied = () => {
      this.outside = true;
      const share = this.share;
      if (share) this.endLocal(share);
      const v = this.viewer;
      if (v) this.unwatch(v);
      this.set.setView(null);
      this.set.setStats(null);
    };
    const onDisconnect = () => {
      const share = this.share;
      if (share) {
        // The server ends the share when the presenter's socket drops.
        this.endLocal(share);
        this.toast("Connection lost — your share ended");
      }
      const v = this.viewer;
      if (v) {
        this.closeViewerPc(v);
        this.clearViewerTimers(v);
        v.live = false;
        v.attempts = 0;
      }
    };

    socket.on("stage:viewer", onViewer);
    socket.on("stage:viewer-left", onLeft);
    socket.on("stage:quality", onQuality);
    socket.on("stage:signal", onSignal);
    socket.on("player:action", onAction);
    socket.on("room:state", onState);
    socket.on("room:denied", onDenied);
    socket.on("disconnect", onDisconnect);
    return () => {
      socket.off("stage:viewer", onViewer);
      socket.off("stage:viewer-left", onLeft);
      socket.off("stage:quality", onQuality);
      socket.off("stage:signal", onSignal);
      socket.off("player:action", onAction);
      socket.off("room:state", onState);
      socket.off("room:denied", onDenied);
      socket.off("disconnect", onDisconnect);
      this.dispose();
    };
  };

  /** Unmount: end our share (telling the server) and stop watching. */
  dispose() {
    this.stopShare();
    const v = this.viewer;
    if (v) this.unwatch(v);
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
  }

  primeFileShare = () => {
    if (hasNativeFileCapture()) return;
    const Ctx = audioCtor();
    if (!Ctx) return;
    if (!this.audioCtx || this.audioCtx.state === "closed") {
      try {
        this.audioCtx = new Ctx();
      } catch {
        return;
      }
    }
    this.audioCtx.resume().catch(() => {});
  };

  private async onSignal({ from, streamId, data }: SignalMsg) {
    if (!data || typeof data !== "object") return;
    const share = this.share;
    if (share?.streamId && streamId === share.streamId) {
      await this.onPresenterSignal(from, data);
      return;
    }
    const v = this.viewer;
    if (v && streamId === v.streamId && from === v.presenter) {
      await this.onViewerSignal(v, data);
    }
  }

  /* ------------------------------------------------------- presenter */

  startShare = async (
    source: ShareSource,
    file?: File,
    opts: ShareOpts = {}
  ): Promise<void> => {
    if (this.share) {
      this.toast("You're already sharing — stop that first");
      return;
    }
    const support = detectSupport();
    if (!support[source]) {
      this.toast(
        source === "camera"
          ? "This browser can't use the camera"
          : source === "file"
            ? "Your browser can't stream local files — try Chrome or Edge"
            : isMobileDevice()
              ? "Phones can't share their screen from a browser — share your camera or a video file"
              : "Your browser can't share screens"
      );
      return;
    }
    if (!(this.socket ?? getSocket()).connected) {
      this.toast("Reconnecting — try again in a moment");
      return;
    }

    const share: Share = {
      source,
      streamId: null,
      stream: null,
      video: null,
      audio: null,
      fileUrl: null,
      fileEl: null,
      captures: new Map(),
      monitor: null,
      detach: null,
      facing: "user",
      flipping: false,
    };

    let title: string;
    if (source === "file") {
      if (!file || !file.type.startsWith("video/")) {
        this.toast("Pick a video file");
        return;
      }
      this.share = share;
      share.fileUrl = URL.createObjectURL(file);
      this.set.setPres({
        phase: "starting",
        source,
        streamId: null,
        preview: null,
        fileUrl: null,
      });
      const ok = await probeVideo(share.fileUrl);
      if (this.share !== share) return; // stopped meanwhile (endLocal revoked)
      if (!ok) {
        this.endLocal(share);
        this.toast("This browser can't play that file — try MP4 or WebM");
        return;
      }
      title = file.name.replace(/\.[^.]+$/, "") || file.name;
    } else {
      // getDisplayMedia must be the first await: it needs the click's
      // user activation.
      this.share = share;
      this.set.setPres({
        phase: "starting",
        source,
        streamId: null,
        preview: null,
        fileUrl: null,
      });
      let stream: MediaStream;
      try {
        stream =
          source === "camera"
            ? await getCamera(share.facing, opts.withAudio ?? true)
            : await getDisplay(source);
      } catch (e) {
        if (this.share === share) this.endLocal(share);
        const name = errName(e);
        if (source === "camera") {
          this.toast(
            name === "NotAllowedError"
              ? "Camera blocked — allow it in your browser's site settings"
              : name === "NotReadableError"
                ? "Your camera is busy in another app"
                : "Couldn't start the camera"
          );
        } else if (name === "NotAllowedError" && /system/i.test(errMessage(e))) {
          this.toast(
            "Your system blocked screen capture — allow it for this browser in system settings"
          );
        } else if (name !== "NotAllowedError" && name !== "AbortError") {
          // Cancelling the picker is NotAllowedError/AbortError: stay quiet.
          this.toast("Couldn't start sharing — try again");
        }
        return;
      }
      if (this.share !== share) {
        stopAll(stream);
        return;
      }
      const video = stream.getVideoTracks()[0] ?? null;
      if (!video) {
        stopAll(stream);
        this.endLocal(share);
        this.toast("Nothing to share — no video in that capture");
        return;
      }
      video.contentHint = source === "screen" ? "detail" : "motion";
      this.watchEnded(share, video);
      share.stream = stream;
      share.video = video;
      share.audio = stream.getAudioTracks()[0] ?? null;
      title = source === "camera" ? "Live camera" : shareTitle(source, video);
      this.applyCapToSource(share);
      this.set.setPres(this.presFor(share, "starting", null, stream));
      if (source === "camera") this.checkFlip(share);
    }

    const res = await new Promise<StartReply | null>((resolve) => {
      (this.socket ?? getSocket())
        .timeout(ACK_TIMEOUT)
        .emit(
          "stage:start",
          { source, title },
          (err: Error | null, reply?: StartReply) => resolve(err ? null : reply ?? null)
        );
    });

    if (this.share !== share) {
      // Stopped while waiting: don't leave a dead share on the stage
      // (unless we were put out of the room — then it's already gone).
      if (res?.ok && res.streamId && !this.outside) {
        this.emit("stage:stop", { streamId: res.streamId });
      }
      return;
    }
    if (!res?.ok || !res.streamId) {
      this.endLocal(share);
      this.toast(
        res
          ? res.error || "Couldn't start sharing"
          : "Couldn't reach the room — try again"
      );
      return;
    }
    share.streamId = res.streamId;
    this.warnedFull = false;
    const live = this.presFor(
      share,
      "live",
      res.streamId,
      source === "file" ? null : share.stream
    );
    // checkFlip may already have answered.
    this.set.setPres((p) => ({ ...live, canFlip: p?.canFlip }));
  };

  private presFor(
    share: Share,
    phase: PresState["phase"],
    streamId: string | null,
    preview: MediaStream | null
  ): PresState {
    return {
      phase,
      source: share.source,
      streamId,
      preview,
      fileUrl: share.source === "file" && phase === "live" ? share.fileUrl : null,
      facing: share.facing,
    };
  }

  /** The browser's own "Stop sharing" bar, or the camera being taken away. */
  private watchEnded(share: Share, video: MediaStreamTrack) {
    video.addEventListener("ended", () => {
      if (this.share === share && share.video === video && !share.flipping) {
        this.stopShare();
      }
    });
  }

  /** Only offer a flip when there's a second camera to flip to. */
  private checkFlip(share: Share) {
    cameraCount().then((count) => {
      if (this.share !== share || count < 2) return;
      this.set.setPres((p) => (p ? { ...p, canFlip: true } : p));
    });
  }

  /** Camera share: silence its mic while in a call (the call carries your
      voice) and bring it back after. */
  setCameraMic = (on: boolean) => {
    const share = this.share;
    if (share?.source === "camera" && share.audio) share.audio.enabled = on;
  };

  flipCamera = () => {
    this.flipCameraAsync().catch(() => {});
  };

  private async flipCameraAsync() {
    const share = this.share;
    if (!share || share.source !== "camera" || share.flipping) return;
    share.flipping = true;
    const next: Facing = share.facing === "user" ? "environment" : "user";
    const old = share.video;
    const oldId = old?.getSettings().deviceId;
    // Phones generally can't hold two cameras open: let go of this one first.
    old?.stop();
    const open = async (video: MediaTrackConstraints) => {
      try {
        const got = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        return got.getVideoTracks()[0] ?? null;
      } catch {
        return null;
      }
    };
    // facingMode is only a hint: cameras that don't report one (USB webcams,
    // some multi-lens phones) hand back the same device. Then step to
    // another camera by id instead.
    let video = await open(cameraVideo(next));
    if (video && oldId && video.getSettings().deviceId === oldId) {
      video.stop();
      video = null;
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      const other = devices.find((d) => d.kind === "videoinput" && d.deviceId !== oldId);
      if (other?.deviceId) {
        video = await open({
          ...cameraVideo(next),
          facingMode: undefined,
          deviceId: { exact: other.deviceId },
        });
      }
    }
    const flipped = !!video;
    if (!video) {
      // Couldn't switch: get the camera we had back.
      video = await open(
        oldId
          ? { ...cameraVideo(share.facing), deviceId: { exact: oldId } }
          : cameraVideo(share.facing)
      );
    }
    const reported = video?.getSettings().facingMode;
    const facing: Facing =
      reported === "user" || reported === "environment"
        ? reported
        : flipped
          ? next
          : share.facing;
    share.flipping = false;
    if (this.share !== share) {
      video?.stop();
      return;
    }
    if (!video) {
      this.toast("Lost the camera — sharing stopped");
      this.stopShare();
      return;
    }
    if (!flipped) this.toast("Couldn't switch cameras");
    video.contentHint = "motion";
    this.watchEnded(share, video);
    share.facing = facing;
    share.stream = new MediaStream(share.audio ? [video, share.audio] : [video]);
    this.setTracks(share, video, share.audio);
    this.applyCapToSource(share);
    this.set.setPres((p) =>
      p ? { ...p, preview: share.stream, facing: share.facing } : p
    );
  }

  stopShare = () => {
    const share = this.share;
    if (!share) return;
    if (share.streamId) this.emit("stage:stop", { streamId: share.streamId });
    this.endLocal(share);
  };

  /** Local teardown only; the caller tells the server if it needs to. */
  private endLocal(share: Share) {
    if (this.share !== share) return;
    this.share = null;
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    this.prefs.clear();
    share.detach?.();
    share.detach = null;
    stopAll(share.stream);
    for (const captured of share.captures.values()) stopCapture(captured);
    // Idle until the next file share (primeFileShare resumes it); a running
    // context keeps the phone's audio session awake.
    if (this.audioCtx?.state === "running") this.audioCtx.suspend().catch(() => {});
    share.captures.clear();
    share.video?.stop();
    share.audio?.stop();
    if (share.monitor) {
      share.monitor.pause();
      share.monitor.srcObject = null;
    }
    if (share.fileEl) share.fileEl.pause();
    if (share.fileUrl) URL.revokeObjectURL(share.fileUrl);
    this.set.setPres(null);
    this.set.setViewerCount(0);
    this.set.setStats(null);
  }

  /** Ref callback for the presenter's file <video>. */
  bindFileVideo = (el: HTMLVideoElement | null) => {
    const share = this.share;
    if (!share || share.source !== "file" || share.fileEl === el) return;
    share.detach?.();
    share.detach = null;
    share.fileEl = el;
    if (!el) return; // may be a StrictMode re-run: keep the capture for now
    this.captureFile(share, el as CapturableVideo);
    // A different element took over: the old one's capture has no use.
    for (const [old, captured] of share.captures) {
      if (old === el) continue;
      stopCapture(captured);
      share.captures.delete(old);
    }
  };

  private captureFile(share: Share, el: CapturableVideo) {
    // Re-bound (StrictMode, a remount of the same element): reuse.
    let captured: MediaStream | null = share.captures.get(el) ?? null;
    const mode =
      typeof el.captureStream === "function"
        ? "native"
        : typeof el.mozCaptureStream === "function"
          ? "moz"
          : "canvas";
    const viaMoz = mode === "moz";

    const refresh = () => {
      if (this.share !== share || share.fileEl !== el) return;
      if (!captured) {
        try {
          captured =
            mode === "canvas"
              ? canvasCapture(el, this.audioCtx)
              : viaMoz
                ? el.mozCaptureStream!()
                : el.captureStream!();
        } catch {
          return; // not ready yet; loadedmetadata/playing will try again
        }
        share.captures.set(el, captured);
        captured.addEventListener("addtrack", refresh);
        captured.addEventListener("removetrack", refresh);
      }
      const video = captured.getVideoTracks().find((t) => t.readyState === "live") ?? null;
      const audio = captured.getAudioTracks().find((t) => t.readyState === "live") ?? null;
      if (video) video.contentHint = "motion";
      share.stream = captured;
      // Firefox routes the element's sound into the capture only.
      if (viaMoz) {
        if (!share.monitor) share.monitor = new Audio();
        const playing = (share.monitor.srcObject as MediaStream | null)?.getAudioTracks()[0];
        if (audio && playing !== audio) {
          share.monitor.srcObject = new MediaStream([audio]);
          share.monitor.play().catch(() => {});
        }
      }
      this.setTracks(share, video, audio);
    };

    if (captured) {
      captured.addEventListener("addtrack", refresh);
      captured.addEventListener("removetrack", refresh);
    }
    el.addEventListener("loadedmetadata", refresh);
    el.addEventListener("playing", refresh);
    el.addEventListener("resize", refresh);
    refresh();
    share.detach = () => {
      el.removeEventListener("loadedmetadata", refresh);
      el.removeEventListener("playing", refresh);
      el.removeEventListener("resize", refresh);
      if (captured) {
        captured.removeEventListener("addtrack", refresh);
        captured.removeEventListener("removetrack", refresh);
      }
    };
  }

  /** Point every viewer's senders at the share's current tracks. */
  private setTracks(
    share: Share,
    video: MediaStreamTrack | null,
    audio: MediaStreamTrack | null
  ) {
    const changed = share.video !== video || share.audio !== audio;
    share.video = video;
    share.audio = audio;
    for (const [id, peer] of this.peers) {
      if (changed) {
        peer.videoTx.sender.replaceTrack(video).catch(() => {});
        peer.audioTx.sender.replaceTrack(audio).catch(() => {});
      }
      // The source size may have changed; rescale.
      this.applyParams(id);
    }
  }

  private async offerTo(id: string) {
    const share = this.share;
    if (!share?.streamId) return;
    const existing = this.peers.get(id);
    if (!existing && this.peers.size >= MAX_VIEWERS) {
      if (!this.warnedFull) {
        this.warnedFull = true;
        this.toast("More than 8 viewers — some may not see the share (needs an SFU)");
      }
      return;
    }
    if (existing) this.closePeer(id);

    const streamId = share.streamId;
    const n = ++this.negotiation;
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    const videoTx = pc.addTransceiver(share.video ?? "video", { direction: "sendonly" });
    const audioTx = pc.addTransceiver(share.audio ?? "audio", { direction: "sendonly" });
    const peer: ViewerPeer = {
      pc,
      n,
      videoTx,
      audioTx,
      queued: [],
      connected: false,
      chain: Promise.resolve(),
    };
    this.peers.set(id, peer);

    pc.onicecandidate = (e) => {
      if (e.candidate && this.peers.get(id) === peer) {
        this.emit("stage:signal", {
          to: id,
          streamId,
          data: { candidate: e.candidate.toJSON(), n },
        });
      }
    };
    pc.onconnectionstatechange = () => {
      if (this.peers.get(id) !== peer) return;
      const state = pc.connectionState;
      peer.connected = state === "connected";
      if (state === "connected") this.applyParams(id);
      // A failed link is the viewer's to retry (it re-sends stage:want).
      if (state === "failed" || state === "closed") this.closePeer(id);
      else this.countViewers();
    };

    try {
      const offer = await pc.createOffer();
      if (this.peers.get(id) !== peer) return;
      await pc.setLocalDescription(offer);
      if (this.peers.get(id) !== peer || !pc.localDescription) return;
      this.emit("stage:signal", {
        to: id,
        streamId,
        data: { sdp: pc.localDescription.toJSON(), n },
      });
    } catch {
      // Only this attempt's connection: a newer stage:want may already have
      // replaced it, and that one must survive.
      if (this.peers.get(id) === peer) this.closePeer(id);
    }
  }

  private async onPresenterSignal(from: string, data: Signal) {
    const peer = this.peers.get(from);
    if (!peer) return;
    // Meant for a connection we've since replaced.
    if (data.n !== undefined && data.n !== peer.n) return;
    const { pc } = peer;
    if (data.sdp?.type === "answer") {
      if (pc.signalingState !== "have-local-offer") return;
      await pc.setRemoteDescription(data.sdp);
      if (this.peers.get(from) !== peer) return;
      const list = peer.queued.splice(0);
      for (const c of list) await pc.addIceCandidate(c).catch(() => {});
      this.applyParams(from);
    } else if (data.candidate) {
      if (pc.remoteDescription) {
        await pc.addIceCandidate(data.candidate).catch(() => {});
      } else {
        peer.queued.push(data.candidate);
      }
    }
  }

  private closePeer(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    peer.pc.onicecandidate = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    this.countViewers();
  }

  private countViewers() {
    let n = 0;
    for (const p of this.peers.values()) if (p.connected) n++;
    this.set.setViewerCount(n);
  }

  private sourceHeight(share: Share): number {
    return share.video?.getSettings().height || share.fileEl?.videoHeight || 0;
  }

  /** tab/screen/camera: ask the capture itself for the cap's resolution. */
  private applyCapToSource(share: Share) {
    if (share.source === "file" || !share.video) return;
    // A camera at "auto" stays at 720p: phones upload once per viewer.
    const auto = share.source === "camera" ? 720 : 1080;
    const height = this.cap === "auto" ? auto : TARGET_HEIGHT[this.cap];
    share.video
      .applyConstraints({ frameRate: { ideal: 30 }, height: { ideal: height } })
      .catch(() => {})
      .finally(() => {
        if (this.share !== share) return;
        for (const id of this.peers.keys()) this.applyParams(id);
      });
  }

  /** Bitrate / scale / degradation for one viewer: min(cap, their pref). */
  private applyParams(id: string) {
    const peer = this.peers.get(id);
    const share = this.share;
    if (!peer || !share) return;
    peer.chain = peer.chain.then(async () => {
      if (this.peers.get(id) !== peer || this.share !== share) return;
      const sender = peer.videoTx.sender;
      const level = lowerOf(this.cap, this.prefs.get(id) ?? "auto");
      const params = sender.getParameters() as SendParams;
      // Not negotiated yet; we run again on answer and on connect.
      if (!params.encodings || params.encodings.length === 0) return;
      const enc = params.encodings[0];
      if (level === "auto") {
        delete enc.maxBitrate;
        enc.scaleResolutionDownBy = 1;
      } else {
        enc.maxBitrate = MAX_BITRATE[level];
        const h = this.sourceHeight(share);
        const target = TARGET_HEIGHT[level];
        enc.scaleResolutionDownBy = h > target ? h / target : 1;
      }
      params.degradationPreference =
        share.source === "screen" ? "maintain-resolution" : "maintain-framerate";
      try {
        await sender.setParameters(params);
      } catch {
        // Older engines reject degradationPreference; try without it.
        try {
          const retry = sender.getParameters() as SendParams;
          if (!retry.encodings?.length) return;
          retry.encodings[0].maxBitrate = enc.maxBitrate;
          if (enc.maxBitrate === undefined) delete retry.encodings[0].maxBitrate;
          retry.encodings[0].scaleResolutionDownBy = enc.scaleResolutionDownBy;
          await sender.setParameters(retry);
        } catch {
          /* leave the defaults */
        }
      }
    });
  }

  setCap = (q: StageQuality) => {
    this.cap = q;
    this.set.setCap(q);
    const share = this.share;
    if (!share) return;
    if (share.source === "file") {
      for (const id of this.peers.keys()) this.applyParams(id);
    } else {
      this.applyCapToSource(share);
    }
  };

  /* ---------------------------------------------------------- viewer */

  /** Start watching a share; returns the cleanup. */
  watch(streamId: string, presenter: string): () => void {
    const prevV = this.viewer;
    if (prevV) this.unwatch(prevV);
    const v: ViewerCtl = {
      streamId,
      presenter,
      pc: null,
      n: undefined,
      queued: [],
      stream: null,
      live: false,
      attempts: 0,
      timer: null,
      graceTimer: null,
    };
    this.viewer = v;
    this.sendWant(v);
    return () => this.unwatch(v);
  }

  private unwatch(v: ViewerCtl) {
    this.closeViewerPc(v);
    this.clearViewerTimers(v);
    if (this.viewer === v) this.viewer = null;
  }

  private clearViewerTimers(v: ViewerCtl) {
    if (v.timer) clearTimeout(v.timer);
    if (v.graceTimer) clearTimeout(v.graceTimer);
    v.timer = null;
    v.graceTimer = null;
  }

  private closeViewerPc(v: ViewerCtl) {
    const pc = v.pc;
    v.pc = null;
    v.n = undefined;
    v.queued = [];
    v.stream = null;
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.close();
    }
  }

  /** Ask the presenter for a (fresh) connection and arm the stall timer. */
  private sendWant(v: ViewerCtl) {
    if (this.viewer !== v) return;
    this.closeViewerPc(v);
    this.clearViewerTimers(v);
    v.live = false;
    this.emit("stage:want", { streamId: v.streamId });
    this.lastWant = {
      streamId: v.streamId,
      sid: (this.socket ?? getSocket()).id,
      at: Date.now(),
    };
    v.timer = setTimeout(() => this.onStall(v), CONNECT_TIMEOUT);
  }

  /** No working connection: back off and ask again, or give up. */
  private onStall(v: ViewerCtl) {
    if (this.viewer !== v || v.live) return;
    this.clearViewerTimers(v);
    if (v.attempts >= MAX_REWANTS) {
      this.closeViewerPc(v);
      this.set.setView({ streamId: v.streamId, status: "failed", stream: null });
      return;
    }
    v.attempts += 1;
    this.closeViewerPc(v);
    this.set.setView({ streamId: v.streamId, status: "connecting", stream: null });
    v.timer = setTimeout(() => this.sendWant(v), 1000 * 2 ** (v.attempts - 1));
  }

  retry = () => {
    const v = this.viewer;
    if (!v) return;
    v.attempts = 0;
    this.set.setView({ streamId: v.streamId, status: "connecting", stream: null });
    this.sendWant(v);
  };

  private async onViewerSignal(v: ViewerCtl, data: Signal) {
    if (data.sdp?.type === "offer") {
      // A new offer always replaces whatever we had.
      this.closeViewerPc(v);
      const pc = new RTCPeerConnection({ iceServers: iceServers() });
      const n = data.n;
      v.pc = pc;
      v.n = n;
      const current = () => this.viewer === v && v.pc === pc;

      pc.ontrack = () => {
        if (!current()) return;
        // A fresh MediaStream each time so the <video> rebinds cleanly.
        v.stream = new MediaStream(pc.getReceivers().map((r) => r.track));
        this.set.setView({
          streamId: v.streamId,
          status: v.live ? "live" : "connecting",
          stream: v.stream,
        });
      };
      pc.onicecandidate = (e) => {
        if (e.candidate && current()) {
          this.emit("stage:signal", {
            to: v.presenter,
            streamId: v.streamId,
            data: { candidate: e.candidate.toJSON(), n },
          });
        }
      };
      pc.onconnectionstatechange = () => {
        if (!current()) return;
        const state = pc.connectionState;
        if (state === "connected") {
          this.clearViewerTimers(v);
          v.live = true;
          v.attempts = 0;
          this.set.setView({ streamId: v.streamId, status: "live", stream: v.stream });
        } else if (state === "failed") {
          v.live = false;
          this.onStall(v);
        } else if (state === "disconnected") {
          // Often recovers by itself (a network blip); give it a moment.
          if (v.graceTimer) clearTimeout(v.graceTimer);
          v.graceTimer = setTimeout(() => {
            if (!current() || pc.connectionState === "connected") return;
            v.live = false;
            this.onStall(v);
          }, DISCONNECT_GRACE);
        }
      };

      await pc.setRemoteDescription(data.sdp);
      if (!current()) return;
      const answer = await pc.createAnswer();
      if (!current()) return;
      await pc.setLocalDescription(answer);
      if (!current() || !pc.localDescription) return;
      this.emit("stage:signal", {
        to: v.presenter,
        streamId: v.streamId,
        data: { sdp: pc.localDescription.toJSON(), n },
      });
      const list = v.queued.splice(0);
      for (const c of list) await pc.addIceCandidate(c).catch(() => {});
      // A fresh connection on the presenter's side starts at "auto".
      if (this.quality !== "auto") {
        this.emit("stage:quality", { streamId: v.streamId, level: this.quality });
      }
      return;
    }

    if (data.candidate) {
      const pc = v.pc;
      if (!pc) return;
      if (data.n !== undefined && v.n !== undefined && data.n !== v.n) return;
      if (pc.remoteDescription) {
        await pc.addIceCandidate(data.candidate).catch(() => {});
      } else {
        v.queued.push(data.candidate);
      }
    }
  }

  setQuality = (q: StageQuality) => {
    this.quality = q;
    this.set.setQuality(q);
    const v = this.viewer;
    if (v) this.emit("stage:quality", { streamId: v.streamId, level: q });
  };

  /* ----------------------------------------------------------- stats */

  collectStats = async (key: string) => {
    let value: LiveStageStats | null = null;
    try {
      if (this.share) value = await this.presenterStats(this.share);
      else if (this.viewer?.pc) value = await this.viewerStats(this.viewer.pc);
    } catch {
      return;
    }
    if (value) this.set.setStats({ key, value });
  };

  private rate(
    pc: RTCPeerConnection,
    id: string,
    bytes: number,
    frames: number,
    ts: number
  ): { kbps?: number; fps?: number } {
    let map = this.prev.get(pc);
    if (!map) {
      map = new Map();
      this.prev.set(pc, map);
    }
    const last = map.get(id);
    map.set(id, { bytes, frames, ts });
    if (!last || ts <= last.ts) return {};
    const secs = (ts - last.ts) / 1000;
    return {
      kbps: Math.max(0, ((bytes - last.bytes) * 8) / 1000 / secs),
      fps: frames > last.frames ? (frames - last.frames) / secs : undefined,
    };
  }

  private async viewerStats(pc: RTCPeerConnection): Promise<LiveStageStats | null> {
    const report = await pc.getStats();
    let out: LiveStageStats | null = null;
    report.forEach((r: Record<string, unknown>) => {
      if (r.type !== "inbound-rtp" || r.kind !== "video") return;
      const { kbps, fps } = this.rate(
        pc,
        String(r.id),
        Number(r.bytesReceived) || 0,
        Number(r.framesDecoded) || 0,
        Number(r.timestamp) || Date.now()
      );
      out = {
        width: Number(r.frameWidth) || undefined,
        height: Number(r.frameHeight) || undefined,
        fps: round(Number(r.framesPerSecond) || fps),
        kbps: round(kbps),
      };
    });
    return out;
  }

  private async presenterStats(share: Share): Promise<LiveStageStats | null> {
    let width = 0;
    let height = 0;
    let fps = 0;
    let kbps = 0;
    let any = false;
    for (const peer of this.peers.values()) {
      if (!peer.connected) continue;
      const report = await peer.pc.getStats();
      report.forEach((r: Record<string, unknown>) => {
        if (r.type !== "outbound-rtp" || r.kind !== "video") return;
        any = true;
        const rate = this.rate(
          peer.pc,
          String(r.id),
          Number(r.bytesSent) || 0,
          Number(r.framesEncoded) || 0,
          Number(r.timestamp) || Date.now()
        );
        width = Math.max(width, Number(r.frameWidth) || 0);
        height = Math.max(height, Number(r.frameHeight) || 0);
        fps = Math.max(fps, Number(r.framesPerSecond) || rate.fps || 0);
        kbps += rate.kbps || 0;
      });
    }
    if (this.share !== share) return null;
    if (any) {
      return {
        width: width || undefined,
        height: height || undefined,
        fps: round(fps),
        kbps: round(kbps),
      };
    }
    // Nobody connected yet: describe the source itself.
    const s = share.video?.getSettings();
    return {
      width: s?.width || share.fileEl?.videoWidth || undefined,
      height: s?.height || share.fileEl?.videoHeight || undefined,
      fps: round(s?.frameRate),
    };
  }
}

function round(n: number | undefined): number | undefined {
  return n === undefined || !Number.isFinite(n) || n <= 0 ? undefined : Math.round(n);
}

/* ------------------------------------------------------------------- Hook */

export function useLiveStage({
  media,
  selfId,
  onToast,
  self,
}: {
  media: Media | null;
  selfId: string | null;
  onToast: (msg: string) => void;
  /** Who and where, for handing a screen share to the Android app. */
  self: { code: string; name: string; clientId: string } | null;
}): LiveStageApi {
  const detected = useSyncExternalStore(noSubscribe, detectSupport, serverSupport);
  const inApp = useInNativeApp();
  const nativeShare = useNativeShare();
  const native = inApp && nativeShare.phase !== "idle";
  const supported = useMemo(
    () => (inApp ? { ...detected, screen: true } : detected),
    [inApp, detected]
  );
  const [pres, setPres] = useState<PresState | null>(null);
  const [view, setView] = useState<ViewState | null>(null);
  const [viewerCount, setViewerCount] = useState(0);
  const [stats, setStats] = useState<StatsState | null>(null);
  const [cap, setCap] = useState<StageQuality>("auto");
  const [quality, setQuality] = useState<StageQuality>("auto");
  const [engine] = useState(
    () =>
      new StageEngine({ setPres, setView, setViewerCount, setStats, setCap, setQuality })
  );

  useEffect(() => {
    engine.setToast(onToast);
  }, [engine, onToast]);

  useEffect(() => engine.attach(getSocket()), [engine]);
  useEffect(() => onNativeToast(onToast), [onToast]);
  // Leaving the room inside the app ends the phone's share with it.
  const nativeLive = useRef(false);
  useEffect(() => {
    nativeLive.current = native;
  }, [native]);
  useEffect(
    () => () => {
      if (nativeLive.current) stopNativeShare();
    },
    []
  );

  const liveId = media?.kind === "live" ? media.streamId : null;
  const livePresenter = media?.kind === "live" ? media.presenter : null;
  // While the app shares, the share on stage is our own phone's: don't watch it.
  const watching =
    !pres &&
    !native &&
    !!liveId &&
    !!livePresenter &&
    !!selfId &&
    livePresenter !== selfId;

  // selfId changes on every reconnect; a new socket must ask again.
  useEffect(() => {
    if (!watching || !liveId || !livePresenter) return;
    return engine.watch(liveId, livePresenter);
  }, [engine, watching, liveId, livePresenter, selfId]);

  const statsKey = pres
    ? `p:${pres.streamId ?? ""}`
    : watching
      ? `v:${liveId}`
      : null;
  useEffect(() => {
    if (!statsKey) return;
    const id = setInterval(() => {
      engine.collectStats(statsKey).catch(() => {});
    }, STATS_INTERVAL);
    return () => clearInterval(id);
  }, [engine, statsKey]);

  let status: LiveStageApi["status"] = "idle";
  let remoteStream: MediaStream | null = null;
  if (pres) {
    status = pres.phase === "starting" ? "starting" : "live";
  } else if (native) {
    status = nativeShare.phase === "starting" ? "starting" : "live";
  } else if (watching) {
    const mine = view?.streamId === liveId ? view : null;
    status = mine?.status ?? "connecting";
    remoteStream = mine?.stream ?? null;
  }
  const shownStats = statsKey && stats?.key === statsKey ? stats.value : null;

  // In the Android app, "screen" is the app's job; everything else stays here.
  const startShare = useCallback(
    async (source: ShareSource, file?: File, opts?: ShareOpts) => {
      if (source !== "screen" || !inApp) return engine.startShare(source, file, opts);
      if (pres || native) {
        onToast("You're already sharing — stop that first");
        return;
      }
      if (!self) return;
      await startNativeShare({ ...self, title: `${self.name}'s phone`, cap });
    },
    [engine, inApp, pres, native, self, cap, onToast]
  );
  const stopShare = native ? stopNativeShare : engine.stopShare;
  const setShareCap = useCallback(
    (q: StageQuality) => {
      engine.setCap(q);
      if (native) setNativeCap(q);
    },
    [engine, native]
  );

  return useMemo<LiveStageApi>(
    () => ({
      supported,
      isPresenter: !!pres || native,
      native: !pres && native,
      nativeAudio:
        !pres && native
          ? { sound: nativeShare.sound, voice: nativeShare.voice, setVoice: setNativeVoice }
          : null,
      status,
      remoteStream,
      localPreview: pres?.preview ?? null,
      fileUrl: pres?.fileUrl ?? null,
      camera:
        pres?.source === "camera"
          ? { facing: pres.facing ?? "user", canFlip: !!pres.canFlip }
          : null,
      flipCamera: engine.flipCamera,
      setCameraMic: engine.setCameraMic,
      primeFileShare: engine.primeFileShare,
      bindFileVideo: engine.bindFileVideo,
      viewerCount: pres ? viewerCount : native ? nativeShare.viewers : 0,
      stats: shownStats,
      cap,
      setCap: setShareCap,
      quality,
      setQuality: engine.setQuality,
      startShare,
      stopShare,
      retry: engine.retry,
    }),
    [
      supported,
      pres,
      native,
      nativeShare.viewers,
      nativeShare.sound,
      nativeShare.voice,
      status,
      remoteStream,
      engine,
      viewerCount,
      shownStats,
      cap,
      quality,
      startShare,
      stopShare,
      setShareCap,
    ]
  );
}
