"use client";

import { useEffect, useState } from "react";
import type { SyncSignals } from "./useSyncedPlayer";

/* A small, calm readout of how this player relates to the room. Changes are
   debounced so a 300ms buffer blip or a quick correction doesn't flicker. */

export type SyncState =
  | "reconnecting"
  | "buffering"
  | "catching"
  | "live"
  | "share"
  | "sync"
  | "paused";

const DEBOUNCE_MS = 400;

/** `liveShare`: the stage is someone's live tab/screen/file share, which has
    no shared timeline — so there is nothing to be in or out of sync with. */
export function syncStateOf(
  connected: boolean,
  s: SyncSignals,
  liveShare = false
): SyncState {
  if (!connected) return "reconnecting";
  if (liveShare) return "share";
  if (s.buffering) return "buffering";
  if (s.catchingUp) return "catching";
  if (s.live) return "live";
  return s.isPlaying ? "sync" : "paused";
}

const LOOK: Record<SyncState, { label: string; dot: string }> = {
  reconnecting: { label: "Reconnecting…", dot: "bg-dim animate-pulse" },
  buffering: { label: "Buffering…", dot: "bg-tungsten animate-pulse" },
  catching: { label: "Catching up…", dot: "bg-tungsten" },
  live: { label: "Live", dot: "bg-signal rec-dot" },
  share: { label: "Live share", dot: "bg-signal rec-dot" },
  sync: { label: "In sync", dot: "bg-emerald-400" },
  paused: { label: "In sync · paused", dot: "bg-emerald-400/60" },
};

export function SyncStatus({
  state,
  drift,
}: {
  state: SyncState;
  drift: number | null;
}) {
  const [shown, setShown] = useState(state);
  useEffect(() => {
    if (state === shown) return;
    const t = setTimeout(() => setShown(state), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [state, shown]);

  const look = LOOK[shown];
  const inSync = shown === "sync" || shown === "paused";
  const title =
    inSync && drift !== null
      ? `Within ±${Math.abs(drift).toFixed(1)}s of the room`
      : shown === "live"
        ? "Watching the live edge with everyone"
        : shown === "share"
          ? "Streaming live from the presenter"
          : undefined;

  return (
    <span
      role="status"
      aria-live="polite"
      title={title}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-edge bg-ink/60 px-2.5 py-1 text-xs font-medium text-smoke"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${look.dot}`} aria-hidden />
      {look.label}
    </span>
  );
}
