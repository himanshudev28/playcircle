"use client";

import type { VideoMedia, YoutubeMedia } from "@/lib/socket";
import type { CreatePlayer, PlayerState } from "./types";

/* YouTube through the IFrame Player API.

   The API script loads once per page. The player is created inside a div of
   our own (YouTube swaps its target element for the iframe), so the mount
   node React handed us is never replaced.

   Besides the StagePlayer interface this adapter can `load` another YouTube
   video into the same iframe (see players/index.ts reusePlayer): that keeps
   the user gesture the iframe may already have, and avoids an iframe reload
   between queue items. */

let apiLoading: Promise<void> | null = null;
function loadYouTubeApi(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (apiLoading) return apiLoading;
  apiLoading = new Promise<void>((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.onerror = () => {
      // Let a later video try again (flaky network, ad blocker toggled).
      apiLoading = null;
      tag.remove();
      reject(new Error("YouTube API failed to load"));
    };
    window.onYouTubeIframeAPIReady = () => resolve();
    document.head.appendChild(tag);
  });
  return apiLoading;
}

// A "duration" of a day or more is a live stream: YouTube reports ~1e8s for
// manifestless streams. (The sync engine also spots a duration that keeps
// growing, which covers ordinary live streams YouTube doesn't flag.)
const MAX_VOD = 86_400;

type YTExtras = {
  getVideoData?: () => { isLive?: boolean } | undefined;
  getPlaybackRate?: () => number;
};
const extras = (p: YT.Player) => p as unknown as YTExtras;

// YouTube's numeric states. CUED (5) is "loaded, showing its thumbnail, never
// started" — the same as unstarted to the sync engine. It must not read as a
// pause: nobody pressed anything.
const STATES: Record<number, PlayerState> = {
  [-1]: "unstarted",
  0: "ended",
  1: "playing",
  2: "paused",
  3: "buffering",
  5: "unstarted",
};

// Errors a reload can't fix: report them straight away.
//   2 bad parameter · 100 removed / private · 101, 150 embedding disabled ·
//   153 the embed was refused (missing referrer / player config).
const FATAL = new Set([2, 100, 101, 150, 153]);

function errorMessage(code: number): string {
  switch (code) {
    case 100:
      return "This YouTube video is private or was removed";
    case 101:
    case 150:
      return "The owner doesn't let this video play on other sites";
    case 2:
      return "YouTube couldn't load that video link";
    case 153:
      return "YouTube refused to play this video here";
    default:
      return "YouTube's player couldn't play this video";
  }
}

export type LoadOptions = { start?: number; autoplay: boolean };

export const createYoutubePlayer: CreatePlayer<YoutubeMedia> = (
  mount,
  media,
  opts
) => {
  const { events } = opts;
  let yt: YT.Player | null = null;
  let ready = false;
  let destroyed = false;
  let videoId = media.id;
  // One recovery reload per video (see onError).
  let recovered = false;
  // Last good readings, so a recovery can resume where we were.
  let lastTime = opts.start ?? 0;
  let lastState: PlayerState = "unstarted";

  const live = (p: YT.Player) => {
    try {
      if (extras(p).getVideoData?.()?.isLive) return true;
    } catch {
      /* noop */
    }
    try {
      return (p.getDuration() || 0) >= MAX_VOD;
    } catch {
      return false;
    }
  };

  const readyPlayer = () => (yt && ready && !destroyed ? yt : null);

  loadYouTubeApi().then(
    () => {
      if (destroyed) return;
      const el = document.createElement("div");
      mount.appendChild(el);
      const start = opts.start && opts.start > 0 ? Math.floor(opts.start) : 0;
      const created: YT.Player = new window.YT!.Player(el, {
        videoId,
        width: "100%",
        height: "100%",
        playerVars: {
          // The sync engine starts playback itself once ready, inside its
          // echo window; autoplay here would race that.
          autoplay: 0,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          ...(start ? { start } : {}),
        },
        events: {
          onReady: () => {
            if (destroyed || yt !== created) return;
            ready = true;
            if (opts.autoplay) {
              try {
                created.playVideo();
              } catch {
                /* noop */
              }
            }
            events.onReady();
          },
          onStateChange: (e) => {
            if (destroyed || yt !== created) return;
            const s = STATES[e.data];
            if (!s) return;
            if (s !== "buffering") lastState = s;
            events.onState(s);
          },
          onError: (e) => {
            if (destroyed || yt !== created) return;
            // A live stream seeked outside its DVR window throws "recording
            // not available", and the HTML5 player sometimes trips on a
            // stream hiccup. Recover once per video by reloading — a live
            // stream at its live edge (no start), anything else where it
            // was, in the state it was in, so the room sees no jump and no
            // play/pause. Guard against reload loops.
            if (!recovered && !FATAL.has(e.data)) {
              recovered = true;
              try {
                if (live(created)) created.loadVideoById(videoId);
                else if (lastState === "playing") {
                  created.loadVideoById(videoId, lastTime || undefined);
                } else created.cueVideoById(videoId, lastTime || undefined);
                return;
              } catch {
                /* fall through to reporting it */
              }
            }
            events.onError(errorMessage(e.data));
          },
        },
      });
      yt = created;
    },
    () => {
      if (destroyed) return;
      events.onError(
        "Couldn't load YouTube's player — check your connection or ad blocker"
      );
    }
  );

  // Built separately: `load` is an extra the StagePlayer type doesn't list.
  const player = {
    play() {
      try {
        readyPlayer()?.playVideo();
      } catch {
        /* noop */
      }
    },
    pause() {
      try {
        readyPlayer()?.pauseVideo();
      } catch {
        /* noop */
      }
    },
    seek(seconds: number) {
      try {
        readyPlayer()?.seekTo(seconds, true);
        lastTime = seconds;
      } catch {
        /* noop */
      }
    },
    getTime() {
      const p = readyPlayer();
      if (!p) return 0;
      try {
        const t = p.getCurrentTime();
        if (Number.isFinite(t)) lastTime = t;
        return Number.isFinite(t) ? t : 0;
      } catch {
        return 0;
      }
    },
    getDuration() {
      try {
        return readyPlayer()?.getDuration() || 0;
      } catch {
        return 0;
      }
    },
    getState() {
      const p = readyPlayer();
      if (!p) return "unstarted";
      try {
        return STATES[p.getPlayerState()] ?? "unstarted";
      } catch {
        return "unstarted";
      }
    },
    isLive() {
      const p = readyPlayer();
      return p ? live(p) : false;
    },
    getRate() {
      try {
        return (yt && extras(yt).getPlaybackRate?.()) || 1;
      } catch {
        return 1;
      }
    },
    destroy() {
      destroyed = true;
      try {
        yt?.destroy();
      } catch {
        /* noop */
      }
      yt = null;
      ready = false;
    },
    /** Swap to another YouTube video in this same iframe. False when it
        can't (not ready yet, or not a YouTube video): recreate instead. */
    load(next: VideoMedia, o: LoadOptions): boolean {
      const p = readyPlayer();
      if (!p || next.kind !== "youtube") return false;
      videoId = next.id;
      recovered = false;
      lastTime = o.start ?? 0;
      lastState = "unstarted";
      try {
        if (o.autoplay) p.loadVideoById(videoId, o.start || undefined);
        else p.cueVideoById(videoId, o.start || undefined);
        return true;
      } catch {
        return false;
      }
    },
  };
  return player;
};
