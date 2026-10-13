"use client";

import { useSyncExternalStore } from "react";
import { prefetchIce } from "./ice";
import { REALTIME_URL } from "./socket";

/* The PlayCircle Android app (android/ in this repo) shows this site in a
   WebView and adds the one thing no phone browser can do: share the whole
   screen. It injects `window.PlayCircleAndroid` and does the capture and the
   WebRTC itself, on a second "companion" connection to the same room under
   this browser's clientId — so it carries this person's rights and viewers
   see an ordinary live share.

   The app reports back with a "playcircle-native" window event whose detail
   is a NativeShareState, plus an optional `message` to show as a toast. */

type Bridge = {
  startScreenShare(json: string): void;
  stopScreenShare(): void;
  setShareCap(level: string): void;
  getShareState(): string;
};

export type NativeShareState = {
  phase: "idle" | "starting" | "live";
  /** Set once the server accepted the share. */
  streamId: string | null;
  viewers: number;
};

const IDLE: NativeShareState = { phase: "idle", streamId: null, viewers: 0 };
const EVENT = "playcircle-native";

function bridge(): Bridge | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { PlayCircleAndroid?: Bridge }).PlayCircleAndroid ?? null;
}

let state: NativeShareState = IDLE;
let started = false;
/** Bumped by a cancel, so a start still fetching ICE servers is dropped. */
let startSeq = 0;
const listeners = new Set<() => void>();
const toastListeners = new Set<(msg: string) => void>();

function set(next: NativeShareState) {
  if (
    next.phase === state.phase &&
    next.streamId === state.streamId &&
    next.viewers === state.viewers
  ) {
    return;
  }
  state = next;
  for (const fn of listeners) fn();
}

function parse(raw: unknown): NativeShareState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const phase = r.phase === "starting" || r.phase === "live" ? r.phase : "idle";
  return {
    phase,
    streamId: typeof r.streamId === "string" ? r.streamId : null,
    viewers: typeof r.viewers === "number" ? r.viewers : 0,
  };
}

// Wired up on first use: the app may already be sharing (the page reloaded
// mid-share), so ask for the current state, then follow its events.
function ensureStarted() {
  if (started || !bridge()) return;
  started = true;
  window.addEventListener(EVENT, (e) => {
    const detail = (e as CustomEvent).detail;
    const next = parse(detail);
    if (next) set(next);
    const msg = detail && typeof detail.message === "string" ? detail.message : "";
    if (msg) for (const fn of toastListeners) fn(msg);
  });
  try {
    const now = parse(JSON.parse(bridge()!.getShareState()));
    if (now) state = now;
  } catch {
    /* an older app: assume idle */
  }
}

function subscribe(fn: () => void) {
  ensureStarted();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const snapshot = () => state;
const serverSnapshot = () => IDLE;
const hasApp = () => !!bridge();
const noApp = () => false;
const noSubscribe = () => () => {};

/** Running inside the Android app? */
export function useInNativeApp(): boolean {
  return useSyncExternalStore(noSubscribe, hasApp, noApp);
}

/** The app's screen share, or IDLE outside the app. */
export function useNativeShare(): NativeShareState {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

/** Messages from the app (e.g. "Screen sharing was cancelled"). */
export function onNativeToast(fn: (msg: string) => void): () => void {
  ensureStarted();
  toastListeners.add(fn);
  return () => toastListeners.delete(fn);
}

export async function startNativeShare(opts: {
  code: string;
  name: string;
  clientId: string;
  title: string;
  cap: string;
}): Promise<void> {
  const b = bridge();
  if (!b) return;
  ensureStarted();
  // Starting right away: the stage is about to go live under the app's
  // connection, and this page must not try to watch it.
  set({ phase: "starting", streamId: null, viewers: 0 });
  const seq = ++startSeq;
  const iceServers = await prefetchIce();
  if (seq !== startSeq) return; // cancelled meanwhile
  // The app connects to the realtime server itself — this origin, or the
  // separate one when pages and sockets are hosted apart.
  const server = REALTIME_URL || window.location.origin;
  b.startScreenShare(JSON.stringify({ ...opts, server, iceServers }));
}

export function stopNativeShare() {
  // Cancelled before the app was even asked: settle it here.
  startSeq++;
  if (state.phase === "starting" && !state.streamId) set(IDLE);
  bridge()?.stopScreenShare();
}

export function setNativeCap(level: string) {
  bridge()?.setShareCap(level);
}
