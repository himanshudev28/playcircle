"use client";

import { useEffect, useSyncExternalStore } from "react";

/* Picture-in-picture in the Android app (android/, MainActivity).

   The page tells the app when a call is on (`setCallPip`), and the app then
   drops into Android's picture-in-picture window when you leave it — home
   button, gesture, switching apps. While it's in that small window the app
   fires a "playcircle-pip" window event ({ on: boolean }) and the page shows
   the call's cameras only (CallFloat's "pip" layout).

   In a plain browser none of this exists; useAndroidPip() is then always
   false and setCallPip does nothing. */

type PipBridge = { setCallPip?(on: boolean): void };

function bridge(): PipBridge | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { PlayCircleAndroid?: PipBridge }).PlayCircleAndroid ?? null;
}

let inPip = false;
const listeners = new Set<() => void>();
const closeListeners = new Set<() => void>();

if (typeof window !== "undefined") {
  window.addEventListener("playcircle-pip", (e) => {
    const detail = (e as CustomEvent<{ on?: boolean; closed?: boolean }>).detail;
    // Swiped away: Android has cut the camera, so the call shouldn't linger.
    if (detail?.closed) closeListeners.forEach((l) => l());
    const on = !!detail?.on;
    if (on === inPip) return;
    inPip = on;
    listeners.forEach((l) => l());
  });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** True while the Android app is showing its picture-in-picture window. */
export function useAndroidPip(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => inPip,
    () => false
  );
}

/** Runs `fn` when the Android PiP window is swiped away (closed, not reopened). */
export function useAndroidPipClosed(fn: () => void) {
  useEffect(() => {
    closeListeners.add(fn);
    return () => {
      closeListeners.delete(fn);
    };
  }, [fn]);
}

/** Lets the Android app pop into picture-in-picture while `on` (in a call). */
export function useCallPip(on: boolean) {
  useEffect(() => {
    const b = bridge();
    if (!b?.setCallPip) return;
    b.setCallPip(on);
    return () => b.setCallPip?.(false);
  }, [on]);
}
