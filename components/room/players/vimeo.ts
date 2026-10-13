"use client";

import type VimeoPlayerType from "@vimeo/player";
import type { VimeoMedia } from "@/lib/socket";
import type { CreatePlayer, PlayerState } from "./types";

/* Vimeo through @vimeo/player (loaded on demand).

   We build the iframe ourselves (player.vimeo.com/video/<id>?h=<hash>) and
   hand it to the SDK: that skips the SDK's oEmbed round trip and works for
   unlisted videos, whose private-link hash goes in `h`.

   Every SDK method is async, so the adapter keeps a local copy of time,
   duration, rate and state, fed by the player's events, and answers the
   sync engine synchronously from it. Time is extrapolated between Vimeo's
   ~4 Hz timeupdates so drift checks don't see a sawtooth. */

const MSG_PRIVATE = "This Vimeo video is private or its owner doesn't allow it on other sites";
const MSG_PASSWORD = "This Vimeo video is password-protected and can't be played here";
const MSG_NOT_FOUND = "That Vimeo video couldn't be found — it may have been removed";
const MSG_GENERIC = "Vimeo couldn't play this video";
const MSG_LOADER = "Couldn't load Vimeo's player — check your connection";
const MSG_TIMEOUT = "Vimeo's player didn't load — the video may be private or blocked from embedding";

const READY_TIMEOUT_MS = 25_000;

function messageFor(name: string | undefined): string | null {
  switch (name) {
    case "PrivacyError":
      return MSG_PRIVATE;
    case "PasswordError":
      return MSG_PASSWORD;
    case "NotFoundError":
      return MSG_NOT_FOUND;
    default:
      return null;
  }
}

export const createVimeoPlayer: CreatePlayer<VimeoMedia> = (mount, media, opts) => {
  const { events } = opts;

  let destroyed = false;
  let failed = false;
  let ready = false;
  let player: VimeoPlayerType | null = null;

  // Local mirror of the player.
  let state: PlayerState = "unstarted";
  let time = 0;
  let timeAt = 0; // performance.now() when `time` was last set
  let duration = media.duration && media.duration > 0 ? media.duration : 0;
  let paused = true;
  let rate = 1;

  // Commands that arrived before the SDK finished loading.
  let pendingSeek: number | null = opts.start && opts.start > 0 ? opts.start : null;
  let pendingPlay: boolean | null = null;

  const timers: ReturnType<typeof setTimeout>[] = [];
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  const setTime = (t: unknown) => {
    if (typeof t === "number" && Number.isFinite(t) && t >= 0) {
      time = t;
      timeAt = now();
    }
  };
  const setDuration = (d: unknown) => {
    if (typeof d === "number" && Number.isFinite(d) && d > 0) duration = d;
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

  // Rejections from play()/setCurrentTime(): only privacy-type ones are
  // fatal; NotAllowedError (autoplay blocked) and range errors are not.
  const onCallError = (err: unknown) => {
    const name = (err as { name?: string } | null)?.name;
    const msg = messageFor(name);
    if (msg) fail(msg);
  };

  /* ---------- iframe ---------- */

  const id = String(media.id);
  const iframe = document.createElement("iframe");
  if (/^\d+$/.test(id)) {
    const params = new URLSearchParams();
    if (media.hash && /^[0-9a-z]+$/i.test(media.hash)) params.set("h", media.hash);
    params.set("dnt", "1");
    params.set("playsinline", "1");
    params.set("autopause", "0");
    params.set("title", "0");
    params.set("byline", "0");
    params.set("portrait", "0");
    // Autoplay is requested through play() once ready instead of the URL
    // param: on a blocked autoplay Vimeo would silently start muted.
    iframe.src = `https://player.vimeo.com/video/${id}?${params.toString()}`;
  }
  iframe.title = media.title ? `Vimeo: ${media.title}` : "Vimeo video player";
  iframe.allow = "autoplay; fullscreen; picture-in-picture; encrypted-media";
  iframe.allowFullscreen = true;
  iframe.setAttribute("frameborder", "0");
  iframe.style.width = "100%";
  iframe.style.height = "100%";
  iframe.style.border = "0";
  iframe.style.display = "block";
  iframe.style.background = "#000";
  mount.appendChild(iframe);

  if (!iframe.src) {
    timers.push(setTimeout(() => fail(MSG_NOT_FOUND), 0));
  } else {
    timers.push(
      setTimeout(() => {
        if (!ready) fail(MSG_TIMEOUT);
      }, READY_TIMEOUT_MS)
    );

    import("@vimeo/player")
      .then(({ default: Player }) => {
        if (destroyed) return;
        let p: VimeoPlayerType;
        try {
          p = new Player(iframe);
        } catch {
          fail(MSG_GENERIC);
          return;
        }
        player = p;

        p.on("play", (d) => {
          paused = false;
          setTime(d?.seconds);
          setState("playing");
        });
        p.on("playing", (d) => {
          paused = false;
          setTime(d?.seconds);
          setState("playing");
        });
        p.on("pause", (d) => {
          paused = true;
          setTime(d?.seconds);
          if (state !== "ended") setState("paused");
        });
        p.on("ended", (d) => {
          paused = true;
          setTime(d?.duration ?? d?.seconds);
          setState("ended");
        });
        p.on("timeupdate", (d) => {
          setTime(d?.seconds);
          setDuration(d?.duration);
        });
        p.on("seeking", (d) => {
          setTime(d?.seconds);
          if (!paused) setState("buffering");
        });
        p.on("seeked", (d) => {
          setTime(d?.seconds);
          if (!paused) setState("playing");
          else if (state === "ended") setState("paused");
        });
        p.on("bufferstart", () => {
          if (!paused) setState("buffering");
        });
        p.on("bufferend", () => {
          setState(paused ? (state === "unstarted" ? "unstarted" : "paused") : "playing");
        });
        p.on("durationchange", (d) => setDuration(d?.duration));
        p.on("loaded", () => {
          p.getDuration().then(setDuration, () => {});
        });
        p.on("playbackratechange", (d) => {
          const r = d?.playbackRate;
          if (typeof r === "number" && r > 0) rate = r;
        });
        p.on("error", (d) => {
          const msg = messageFor(d?.name);
          if (msg) fail(msg);
        });

        p.ready().then(
          async () => {
            if (destroyed || failed) return;
            try {
              setDuration(await p.getDuration());
            } catch {
              /* ignore */
            }
            if (destroyed) return;
            if (pendingSeek != null && pendingSeek > 0) {
              const t = duration > 0 ? Math.min(pendingSeek, Math.max(0, duration - 0.5)) : pendingSeek;
              setTime(t);
              try {
                await p.setCurrentTime(t);
              } catch (err) {
                onCallError(err);
              }
            }
            pendingSeek = null;
            if (destroyed || failed) return;
            ready = true;
            try {
              events.onReady();
            } catch {
              /* ignore */
            }
            const wantPlay = pendingPlay ?? opts.autoplay;
            pendingPlay = null;
            if (wantPlay) p.play().catch(onCallError);
          },
          (err: unknown) => fail(messageFor((err as { name?: string })?.name) ?? MSG_GENERIC)
        );
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
      player.play().catch(onCallError);
    },
    pause() {
      if (destroyed) return;
      if (!player || !ready) {
        pendingPlay = false;
        return;
      }
      player.pause().catch(() => {});
    },
    seek(seconds) {
      if (destroyed || !Number.isFinite(seconds)) return;
      const t = Math.max(0, duration > 0 ? Math.min(seconds, duration) : seconds);
      if (!player || !ready) {
        pendingSeek = t;
        return;
      }
      // Optimistic: report the target until Vimeo confirms.
      setTime(t);
      player.setCurrentTime(t).catch(onCallError);
    },
    getTime() {
      if (paused || state !== "playing" || !timeAt) return time;
      const t = time + ((now() - timeAt) / 1000) * rate;
      return duration > 0 ? Math.min(t, duration) : t;
    },
    getDuration() {
      return duration;
    },
    getState() {
      return state;
    },
    isLive() {
      // Vimeo live events embed through a different (event) player.
      return false;
    },
    getRate() {
      return rate;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const t of timers) clearTimeout(t);
      const p = player;
      player = null;
      if (p) {
        try {
          for (const name of [
            "play",
            "playing",
            "pause",
            "ended",
            "timeupdate",
            "seeking",
            "seeked",
            "bufferstart",
            "bufferend",
            "durationchange",
            "loaded",
            "playbackratechange",
            "error",
          ] as const) {
            p.off(name);
          }
          // Also removes the iframe and the SDK's window listener.
          p.destroy().catch(() => {});
        } catch {
          /* ignore */
        }
      }
      mount.replaceChildren();
    },
  };
};
