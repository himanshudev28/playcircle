"use client";

import type { DailymotionMedia } from "@/lib/socket";
import type { CreatePlayer, PlayerState } from "./types";

/* Dailymotion, best effort.

   Dailymotion's only documented way to control its current player is the
   Web SDK, and that SDK is served per "Player ID" (a configuration created
   in a Dailymotion partner account): geo.dailymotion.com/libs/player/<id>.js.
   The legacy www.dailymotion.com/embed/video/<id>?api=postMessage endpoint
   now 301-redirects to geo.dailymotion.com/player.html?video=<id> and drops
   every query parameter except startTime / mute / loop / ads_params.

   So: we embed geo.dailymotion.com/player.html?video=<id> (which plays for
   everyone), and still speak the player's postMessage protocol — commands
   are JSON `{command, parameters}` posted into the iframe, events come back
   as JSON (or, from older builds, query strings) carrying `event` — in case
   the player answers. If it does (`apiready`), play/pause/seek/time work
   like any other adapter. If it stays silent, the video still plays but the
   room can't drive it; we report ready anyway so the stage isn't stuck on a
   spinner, and the cached clock stays at its last known value. */

const PLAYER_ORIGIN = "https://geo.dailymotion.com";
const MSG_GENERIC = "Dailymotion couldn't play this video — it may be private, removed or blocked in your region";
const MSG_BAD_ID = "That Dailymotion link doesn't point to a video";

// Without an `apiready` this long after the iframe loaded, assume the
// player won't talk to us and go uncontrolled.
const API_GRACE_MS = 6_000;

type DmMessage = { event?: string; id?: string } & Record<string, unknown>;

function parseMessage(data: unknown): DmMessage | null {
  if (data && typeof data === "object") return data as DmMessage;
  if (typeof data !== "string" || !data) return null;
  if (data.charAt(0) === "{") {
    try {
      const parsed: unknown = JSON.parse(data);
      return parsed && typeof parsed === "object" ? (parsed as DmMessage) : null;
    } catch {
      return null;
    }
  }
  if (!data.includes("event=")) return null;
  try {
    return Object.fromEntries(new URLSearchParams(data)) as DmMessage;
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function truthy(v: unknown): boolean {
  return v === true || v === "true" || v === "1" || v === 1;
}

let seq = 0;

export const createDailymotionPlayer: CreatePlayer<DailymotionMedia> = (mount, media, opts) => {
  const { events } = opts;

  let destroyed = false;
  let failed = false;
  let ready = false;
  let apiReady = false;
  let targetOrigin = PLAYER_ORIGIN;

  let state: PlayerState = "unstarted";
  let time = opts.start && opts.start > 0 ? opts.start : 0;
  let timeAt = 0;
  let duration = media.duration && media.duration > 0 ? media.duration : 0;
  let paused = true;
  let live = false;
  let rate = 1;
  let inAd = false;

  let pendingSeek: number | null = opts.start && opts.start > 0 ? opts.start : null;
  let pendingPlay: boolean | null = null;

  const timers: ReturnType<typeof setTimeout>[] = [];
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const frameId = `pc-dm-${Date.now().toString(36)}-${++seq}`;

  const setTime = (t: unknown) => {
    const n = num(t);
    if (n != null && n >= 0) {
      time = n;
      timeAt = now();
    }
  };

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

  const markReady = () => {
    if (ready || destroyed || failed) return;
    ready = true;
    try {
      events.onReady();
    } catch {
      /* ignore */
    }
  };

  /* ---------- iframe ---------- */

  const iframe = document.createElement("iframe");
  const validId = /^[a-z0-9]+$/i.test(media.id);
  if (validId) {
    const params = new URLSearchParams();
    params.set("video", media.id);
    if (pendingSeek) params.set("startTime", String(Math.floor(pendingSeek)));
    // Ignored by the current player unless it's configured for it; kept so
    // that builds which still honour the classic API parameters answer us.
    params.set("api", "postMessage");
    params.set("apimode", "json");
    params.set("id", frameId);
    if (typeof location !== "undefined") params.set("origin", location.origin);
    if (opts.autoplay) params.set("autoplay", "1");
    iframe.src = `${PLAYER_ORIGIN}/player.html?${params.toString()}`;
  }
  iframe.title = media.title ? `Dailymotion: ${media.title}` : "Dailymotion video player";
  iframe.allow = "autoplay; fullscreen; picture-in-picture; web-share";
  iframe.allowFullscreen = true;
  iframe.setAttribute("frameborder", "0");
  iframe.style.width = "100%";
  iframe.style.height = "100%";
  iframe.style.border = "0";
  iframe.style.display = "block";
  iframe.style.background = "#000";

  const send = (command: string, ...parameters: unknown[]) => {
    if (destroyed) return;
    try {
      iframe.contentWindow?.postMessage(JSON.stringify({ command, parameters }), targetOrigin);
    } catch {
      /* ignore */
    }
  };

  const onApiReady = () => {
    if (apiReady) return;
    apiReady = true;
    if (pendingSeek != null && pendingSeek > 0) {
      // startTime usually did it already; a seek to the same spot is free.
      send("seek", pendingSeek);
    }
    pendingSeek = null;
    markReady();
    const asked = pendingPlay;
    pendingPlay = null;
    if (asked ?? opts.autoplay) send("play");
    else if (asked === false) send("pause");
  };

  const handle = (msg: DmMessage) => {
    const ev = typeof msg.event === "string" ? msg.event : "";
    if (!ev) return;
    // Some builds tag events with the id we passed; ignore other players'.
    if (typeof msg.id === "string" && msg.id && msg.id !== frameId && msg.id.startsWith("pc-dm-")) return;

    switch (ev) {
      case "apiready":
        onApiReady();
        break;
      case "loadedmetadata":
      case "playback_ready":
      case "videochange":
        if (num(msg.duration)) duration = num(msg.duration) ?? duration;
        if (!apiReady) onApiReady();
        break;
      case "durationchange": {
        const d = num(msg.duration);
        if (d != null && d > 0) duration = d;
        break;
      }
      case "timeupdate":
        if (!inAd) setTime(msg.time);
        break;
      case "progress":
        break;
      case "video_start":
      case "start":
        inAd = false;
        if (truthy(msg.isLive) || truthy(msg.live)) live = true;
        break;
      case "play":
      case "playing":
        inAd = false;
        paused = false;
        setTime(msg.time);
        setState("playing");
        break;
      case "pause":
        paused = true;
        setTime(msg.time);
        if (state !== "ended") setState("paused");
        break;
      case "waiting":
        if (!paused) setState("buffering");
        break;
      case "rebuffer":
        if (truthy(msg.rebuffering)) {
          if (!paused) setState("buffering");
        } else if (!paused) setState("playing");
        break;
      case "seeking":
        setTime(msg.time);
        if (!paused) setState("buffering");
        break;
      case "seeked":
        setTime(msg.time);
        if (!paused) setState("playing");
        break;
      case "end":
      case "video_end":
        paused = true;
        if (duration > 0) setTime(duration);
        setState("ended");
        break;
      case "playbackspeedchange": {
        const r = num(msg.speed ?? msg.playbackSpeed ?? msg.rate);
        if (r != null && r > 0) rate = r;
        break;
      }
      // Ads: the content clock is frozen; to the room that's buffering.
      case "ad_start":
      case "ad_play":
        inAd = true;
        setState("buffering");
        break;
      case "ad_end":
        inAd = false;
        break;
      case "error":
        // Errors before the video ever played mean it can't be embedded.
        if (state === "unstarted") fail(MSG_GENERIC);
        break;
    }
  };

  const onMessage = (e: MessageEvent) => {
    if (destroyed || e.source !== iframe.contentWindow) return;
    if (!/^https:\/\/([a-z0-9-]+\.)*dailymotion\.com$/i.test(e.origin)) return;
    targetOrigin = e.origin;
    const msg = parseMessage(e.data);
    if (msg) handle(msg);
  };

  const onLoad = () => {
    if (destroyed) return;
    // Ask, in case the player came up before our listener (harmless if not).
    send("playerstate");
    timers.push(
      setTimeout(() => {
        if (!apiReady) markReady();
      }, API_GRACE_MS)
    );
  };

  if (typeof window !== "undefined") window.addEventListener("message", onMessage);
  iframe.addEventListener("load", onLoad);
  mount.appendChild(iframe);

  if (!validId) {
    timers.push(setTimeout(() => fail(MSG_BAD_ID), 0));
  }

  /* ---------- StagePlayer ---------- */

  return {
    play() {
      if (destroyed) return;
      if (!apiReady) {
        pendingPlay = true;
        return;
      }
      send("play");
    },
    pause() {
      if (destroyed) return;
      if (!apiReady) {
        pendingPlay = false;
        return;
      }
      send("pause");
    },
    seek(seconds) {
      if (destroyed || !Number.isFinite(seconds) || live) return;
      const t = Math.max(0, duration > 0 ? Math.min(seconds, duration) : seconds);
      if (!apiReady) {
        pendingSeek = t;
        return;
      }
      setTime(t);
      send("seek", t);
    },
    getTime() {
      if (paused || state !== "playing" || !timeAt) return time;
      const t = time + ((now() - timeAt) / 1000) * rate;
      return duration > 0 ? Math.min(t, duration) : t;
    },
    getDuration() {
      return live ? 0 : duration;
    },
    getState() {
      return state;
    },
    isLive() {
      return live;
    },
    getRate() {
      return rate;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const t of timers) clearTimeout(t);
      if (typeof window !== "undefined") window.removeEventListener("message", onMessage);
      iframe.removeEventListener("load", onLoad);
      try {
        iframe.src = "about:blank";
      } catch {
        /* ignore */
      }
      mount.replaceChildren();
    },
  };
};
