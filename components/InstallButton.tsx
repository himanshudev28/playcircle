"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Icon } from "@/components/Icon";

/* PWA plumbing: registers the service worker (production only — in dev it
   would fight hot reload) and offers "Install app" where the browser
   supports an install prompt (Chrome / Edge, Android and desktop). The
   prompt event can fire before any button mounts, so it's caught here at
   module load and kept in a tiny store. */

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // show our button instead of the mini-infobar
    deferred = e as InstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    notify();
  });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
const getPrompt = () => deferred;
const getServerPrompt = () => null;

/** Mounted once in the root layout. */
export function PwaSetup() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  }, []);
  return null;
}

export function InstallButton({ className = "" }: { className?: string }) {
  const prompt = useSyncExternalStore(subscribe, getPrompt, getServerPrompt);
  if (!prompt) return null;

  async function install() {
    const e = deferred;
    if (!e) return;
    deferred = null; // a prompt can only be shown once
    notify();
    await e.prompt().catch(() => {});
  }

  return (
    <button
      type="button"
      onClick={install}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-smoke transition-colors hover:text-bone ${className}`}
    >
      <Icon name="download" size={16} />
      Install app
    </button>
  );
}
