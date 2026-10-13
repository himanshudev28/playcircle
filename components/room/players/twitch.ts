"use client";

import type { TwitchMedia } from "@/lib/socket";
import type { CreatePlayer, PlayerState } from "./types";

/* Twitch past broadcasts (VODs) and live channels through Twitch's
   "Interactive Frames" embed script (player.twitch.tv/js/embed/v1.js).

   Twitch requires `parent` to list the hostname of every page that embeds
   the player, and that page must be served over https (localhost excepted);
   otherwise the iframe shows Twitch's own error and never reports ready. We
   pass location.hostname, so any https host works without configuration.

   The embed's getters (getCurrentTime, getDuration, isPaused…) are
   synchronous — the script caches what the iframe posts — so no extra
   mirror is needed here beyond our state. */

type TwitchPlayerOptions = {
  width: string | number;
  height: string | number;
  parent: string[];
  autoplay?: boolean;
  muted?: boolean;
  video?: string;
  channel?: string;
  time?: string;
};

interface TwitchPlayer {
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  isPaused(): boolean;
  getEnded(): boolean;
  addEventListener(event: string, callback: (...args: unknown[]) => void): void;
  removeEventListener?(event: string, callback: (...args: unknown[]) => void): void;
}

interface TwitchPlayerConstructor {
  new (target: string | HTMLElement, options: TwitchPlayerOptions): TwitchPlayer;
  READY?: string;
  PLAY?: string;
  PLAYING?: string;
  PAUSE?: string;
  ENDED?: string;
  SEEK?: string;
  ONLINE?: string;
  OFFLINE?: string;
  PLAYBACK_BLOCKED?: string;
}

type TwitchGlobal = { Player: TwitchPlayerConstructor };

const SCRIPT_URL = "https://player.twitch.tv/js/embed/v1.js";
const MSG_LOADER = "Couldn't load Twitch's player — check your connection or ad blocker";
const MSG_INSECURE = "Twitch only plays on secure (https) pages";
const MSG_TIMEOUT = "Twitch's player didn't load — the video may be unavailable or subscriber-only";
const MSG_BAD = "That Twitch link doesn't point to a video or channel";

const READY_TIMEOUT_MS = 20_000;
// Longest getTime() holds a seek's target while the embed's cached time
// still says where we were.
const SEEK_HOLD_MS = 4_000;

function twitchGlobal(): TwitchGlobal | null {
  if (typeof window === "undefined") return null;
  const t = (window as unknown as { Twitch?: Partial<TwitchGlobal> }).Twitch;
  return t && typeof t.Player === "function" ? (t as TwitchGlobal) : null;
}

let scriptLoading: Promise<TwitchGlobal> | null = null;
function loadTwitch(): Promise<TwitchGlobal> {
  const ready = twitchGlobal();
  if (ready) return Promise.resolve(ready);
  if (scriptLoading) return scriptLoading;
  scriptLoading = new Promise<TwitchGlobal>((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = SCRIPT_URL;
    tag.async = true;
    tag.onload = () => {
      const t = twitchGlobal();
      if (t) resolve(t);
      else {
        scriptLoading = null;
        tag.remove();
        reject(new Error("Twitch embed script loaded without Twitch.Player"));
      }
    };
    tag.onerror = () => {
      // Let a later attempt retry (flaky network, ad blocker toggled).
      scriptLoading = null;
      tag.remove();
      reject(new Error("Twitch embed script failed to load"));
    };
    document.head.appendChild(tag);
  });
  return scriptLoading;
}

/** Twitch's `time` option: "1h2m3s". */
function twitchTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m${s % 60}s`;
}

let seq = 0;

export const createTwitchPlayer: CreatePlayer<TwitchMedia> = (mount, media, opts) => {
  const { events } = opts;
  const isChannel = media.type === "channel";

  let destroyed = false;
  let failed = false;
  let ready = false;
  let state: PlayerState = "unstarted";
  let player: TwitchPlayer | null = null;
  let pendingSeek: number | null =
    !isChannel && opts.start && opts.start > 0 ? opts.start : null;
  let pendingPlay: boolean | null = null;
  // A seek we asked for that the embed's cached clock hasn't caught up with:
  // its getCurrentTime() keeps answering the old spot for a moment, which
  // looks exactly like a scrub to the sync engine.
  let seekTarget: number | null = null;
  let seekAt = 0;
  const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const listeners: [string, (...args: unknown[]) => void][] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];

  const setState = (next: PlayerState) => {
    if (destroyed || failed || next === state) return;
    state = next;
    try {
      events.onState(next);
    } catch {
      /* ignore */
    }
  };

  const fail = (message: string) => {
    if (destroyed || failed) return;
    failed = true;
    try {
      events.onError(message);
    } catch {
      /* ignore */
    }
  };

  // Twitch replaces nothing, it appends its iframe into this element.
  const host = document.createElement("div");
  host.id = `pc-twitch-${Date.now().toString(36)}-${++seq}`;
  host.style.width = "100%";
  host.style.height = "100%";
  host.style.background = "#000";
  mount.appendChild(host);

  const id = String(media.id);
  const validId = isChannel ? /^[a-z0-9_]{1,25}$/i.test(id) : /^\d+$/.test(id.replace(/^v/i, ""));
  const secure =
    typeof location !== "undefined" &&
    (location.protocol === "https:" ||
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1");

  const later = (fn: () => void) => timers.push(setTimeout(() => !destroyed && fn(), 0));

  if (!validId) later(() => fail(MSG_BAD));
  else if (!secure) later(() => fail(MSG_INSECURE));
  else {
    timers.push(
      setTimeout(() => {
        if (!ready) fail(MSG_TIMEOUT);
      }, READY_TIMEOUT_MS)
    );

    loadTwitch()
      .then(({ Player }) => {
        if (destroyed) return;
        const options: TwitchPlayerOptions = {
          width: "100%",
          height: "100%",
          parent: [location.hostname],
          autoplay: opts.autoplay,
          muted: false,
        };
        if (isChannel) options.channel = id;
        else {
          options.video = `v${id.replace(/^v/i, "")}`;
          if (pendingSeek) options.time = twitchTime(pendingSeek);
        }

        let p: TwitchPlayer;
        try {
          p = new Player(host.id, options);
        } catch {
          fail(MSG_LOADER);
          return;
        }
        player = p;

        // Twitch sizes its iframe from width/height, but make sure.
        const frame = host.querySelector("iframe");
        if (frame) {
          frame.style.width = "100%";
          frame.style.height = "100%";
          frame.style.border = "0";
          frame.style.display = "block";
        }

        const on = (name: string | undefined, fallback: string, fn: (...args: unknown[]) => void) => {
          const ev = name || fallback;
          const guarded = (...args: unknown[]) => {
            if (!destroyed) fn(...args);
          };
          listeners.push([ev, guarded]);
          try {
            p.addEventListener(ev, guarded);
          } catch {
            /* ignore */
          }
        };

        on(Player.READY, "ready", () => {
          if (ready || failed) return;
          ready = true;
          if (pendingSeek != null && pendingSeek > 0) {
            // `time` normally did it; a seek to the same spot is free.
            try {
              p.seek(pendingSeek);
            } catch {
              /* ignore */
            }
          }
          pendingSeek = null;
          try {
            events.onReady();
          } catch {
            /* ignore */
          }
          const asked = pendingPlay;
          pendingPlay = null;
          try {
            if (asked === true) p.play();
            else if (asked === false) p.pause();
          } catch {
            /* ignore */
          }
        });
        on(Player.PLAY, "play", () => setState("playing"));
        on(Player.PLAYING, "playing", () => setState("playing"));
        on(Player.PAUSE, "pause", () => {
          let ended = false;
          try {
            ended = p.getEnded();
          } catch {
            /* ignore */
          }
          if (!ended && state !== "ended") setState("paused");
        });
        on(Player.ENDED, "ended", () => {
          seekTarget = null;
          setState("ended");
        });
        on(Player.SEEK, "seek", () => {
          // Twitch fires no buffering events; a seek while playing resumes
          // on its own and reports PLAYING again.
        });
        // Autoplay was refused (no user gesture yet). Not a pause anyone
        // made: stay as we are and let the engine's tap-to-join gate act.
        on(Player.PLAYBACK_BLOCKED, "playbackBlocked", () => {});
      })
      .catch(() => fail(MSG_LOADER));
  }

  /* ---------- StagePlayer ---------- */

  return {
    play() {
      if (destroyed) return;
      if (!player || !ready) {
        pendingPlay = true;
        return;
      }
      try {
        player.play();
      } catch {
        /* ignore */
      }
    },
    pause() {
      if (destroyed) return;
      if (!player || !ready) {
        pendingPlay = false;
        return;
      }
      try {
        player.pause();
      } catch {
        /* ignore */
      }
    },
    seek(seconds) {
      if (destroyed || isChannel || !Number.isFinite(seconds)) return;
      const t = Math.max(0, seconds);
      if (!player || !ready) {
        pendingSeek = t;
        return;
      }
      try {
        player.seek(t);
        seekTarget = t;
        seekAt = clock();
      } catch {
        /* ignore */
      }
    },
    getTime() {
      let t = 0;
      try {
        const raw = player?.getCurrentTime() ?? 0;
        t = Number.isFinite(raw) && raw > 0 ? raw : 0;
      } catch {
        /* ignore */
      }
      if (seekTarget !== null) {
        const since = clock() - seekAt;
        const want = seekTarget + (state === "playing" ? since / 1000 : 0);
        // Caught up (or given up on): the embed's clock is the truth again.
        if (since >= SEEK_HOLD_MS || (t >= seekTarget - 1 && t <= want + 1)) {
          seekTarget = null;
        } else {
          return want;
        }
      }
      return t;
    },
    getDuration() {
      if (isChannel) return 0;
      let d = 0;
      try {
        d = player?.getDuration() ?? 0;
      } catch {
        /* ignore */
      }
      if (Number.isFinite(d) && d > 0) return d;
      return media.duration && media.duration > 0 ? media.duration : 0;
    },
    getState() {
      return state;
    },
    isLive() {
      return isChannel;
    },
    getRate() {
      // The embed has no playback-rate API; Twitch VODs play at 1×.
      return 1;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const t of timers) clearTimeout(t);
      const p = player;
      player = null;
      if (p?.removeEventListener) {
        for (const [ev, fn] of listeners) {
          try {
            p.removeEventListener(ev, fn);
          } catch {
            /* ignore */
          }
        }
      }
      listeners.length = 0;
      try {
        // Stop audio right away; the iframe goes with the mount's children.
        p?.pause();
      } catch {
        /* ignore */
      }
      mount.replaceChildren();
    },
  };
};
