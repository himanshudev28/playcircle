"use client";

import type HlsType from "hls.js";
import type { FileMedia, HlsMedia } from "@/lib/socket";
import type { CreatePlayer, PlayerState } from "./types";

/* Direct video files and HLS streams, played by a plain <video>.

   HLS plays natively where the browser can (Safari, iOS, recent Chrome);
   everywhere else hls.js is loaded on demand, so it's code-split out of the
   main bundle and never evaluated on the server.

   Native controls stay on: a pause or seek made with them fires the same
   media events as one we make, and the sync engine reads those. */

const MSG_STREAM = "This stream can't be played here — the site may block other players";
const MSG_FORMAT = "This video format isn't supported by your browser";
const MSG_NETWORK = "Couldn't load that video — the site may block playing it elsewhere";
const MSG_INSECURE = "This video uses an insecure (http) link and can't play on a secure page";
const MSG_LOADER = "Couldn't load the video player — check your connection";

export const createHtml5Player: CreatePlayer<FileMedia | HlsMedia> = (
  mount,
  media,
  opts
) => {
  const { events } = opts;

  let destroyed = false;
  let failed = false;
  let ready = false;
  let state: PlayerState = "unstarted";
  let hls: HlsType | null = null;
  let hlsLive = false;
  // A seek asked for before metadata arrived; applied once it does.
  let pendingSeek: number | null =
    opts.start && opts.start > 0 ? opts.start : null;
  const timers: ReturnType<typeof setTimeout>[] = [];

  const video = document.createElement("video");
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  video.preload = "auto";
  video.controls = true;
  // The room's own Full screen button (on the player box, so reactions and
  // call bubbles stay visible) is the primary one; hide the native one where
  // element fullscreen exists. iOS Safari has none, so keep it there.
  if (typeof document !== "undefined" && document.fullscreenEnabled) {
    video.setAttribute("controlslist", "nofullscreen");
  }
  video.style.width = "100%";
  video.style.height = "100%";
  video.style.background = "#000";
  video.style.display = "block";
  mount.appendChild(video);

  const setState = (next: PlayerState) => {
    if (destroyed || failed || next === state) return;
    state = next;
    try {
      events.onState(next);
    } catch {
      /* the engine's problem, not ours */
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

  // Fire after create returns, so the caller has its handle on us first.
  const later = (fn: () => void) => {
    timers.push(setTimeout(() => !destroyed && fn(), 0));
  };

  const live = () => hlsLive || video.duration === Infinity;

  const safePlay = () => {
    try {
      const p = video.play();
      // NotAllowedError (no user gesture yet) is expected: the engine shows
      // its own tap-to-join gate. Anything else surfaces as an error event.
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      /* ignore */
    }
  };

  const insecure =
    typeof location !== "undefined" &&
    location.protocol === "https:" &&
    /^http:\/\//i.test(media.url);
  // An http:// file on an https page: browsers auto-upgrade mixed-content
  // <video> to https anyway, so ask for that directly and let the normal
  // error path speak if the host has no https. HLS can't do that — hls.js
  // fetches playlists and segments with XHR, which is blocked, not upgraded.
  const upgraded = insecure && media.kind === "file";
  const src = upgraded ? media.url.replace(/^http:/i, "https:") : media.url;

  /* ---------- media events ---------- */

  const onLoadedMetadata = () => {
    if (ready) return;
    ready = true;
    if (pendingSeek != null && !live()) {
      const d = video.duration;
      const t = Number.isFinite(d) && d > 0 ? Math.min(pendingSeek, Math.max(0, d - 0.5)) : pendingSeek;
      try {
        video.currentTime = t;
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
    if (opts.autoplay) safePlay();
  };

  const onPlaying = () => setState("playing");
  const onPause = () => {
    // The spec fires pause right before ended; report just the end.
    if (video.ended) return;
    setState("paused");
  };
  const onWaiting = () => {
    if (!video.paused) setState("buffering");
  };
  const onStalled = () => {
    // `stalled` only means the download paused; it matters only once the
    // buffer is actually too short to keep playing.
    if (!video.paused && video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
      setState("buffering");
    }
  };
  const onSeeking = () => {
    if (!video.paused) setState("buffering");
  };
  const onResume = () => {
    // A seek inside the buffer can finish without a fresh `playing` event.
    if (!video.paused && !video.ended && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      setState("playing");
    } else if (video.paused && !video.ended && state === "buffering") {
      setState("paused");
    }
  };
  const onEnded = () => setState("ended");

  const onVideoError = () => {
    // hls.js reports its own (recoverable) media errors through its events.
    if (hls) return;
    const err = video.error;
    if (!err) return;
    switch (err.code) {
      case MediaError.MEDIA_ERR_ABORTED:
        return;
      case MediaError.MEDIA_ERR_NETWORK:
        fail(media.kind === "hls" ? MSG_STREAM : upgraded ? MSG_INSECURE : MSG_NETWORK);
        return;
      case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED: {
        if (media.kind === "hls") {
          fail(MSG_STREAM);
          return;
        }
        // An http link we asked for over https: most likely the host has
        // no https at all.
        if (upgraded) {
          fail(MSG_INSECURE);
          return;
        }
        // Also what a 403/404 or a blocked hotlink looks like. When the
        // server told us a type this browser does play, blame the network.
        const mime = media.kind === "file" ? media.mime : undefined;
        const playable = !!mime && video.canPlayType(mime) !== "";
        fail(playable ? MSG_NETWORK : MSG_FORMAT);
        return;
      }
      default:
        fail(media.kind === "hls" ? MSG_STREAM : MSG_FORMAT);
    }
  };

  const listeners: [string, () => void][] = [
    ["loadedmetadata", onLoadedMetadata],
    ["playing", onPlaying],
    ["pause", onPause],
    ["waiting", onWaiting],
    ["stalled", onStalled],
    ["seeking", onSeeking],
    ["seeked", onResume],
    ["canplay", onResume],
    ["ended", onEnded],
    ["error", onVideoError],
  ];
  for (const [name, fn] of listeners) video.addEventListener(name, fn);

  /* ---------- source ---------- */

  if (insecure && media.kind === "hls") {
    later(() => fail(MSG_INSECURE));
  } else if (
    media.kind === "file" ||
    video.canPlayType("application/vnd.apple.mpegurl") !== ""
  ) {
    // Plain src rather than <source type>: browsers under-report what they
    // can play (Chrome says "" for video/quicktime yet plays H.264 .mov).
    video.src = src;
  } else {
    import("hls.js")
      .then(({ default: Hls }) => {
        if (destroyed) return;
        if (!Hls.isSupported()) {
          fail(MSG_FORMAT);
          return;
        }
        const h = new Hls({
          lowLatencyMode: false,
          capLevelToPlayerSize: true,
          enableWorker: true,
          backBufferLength: 90,
        });
        hls = h;
        let triedNetwork = false;
        let triedMedia = false;

        h.on(Hls.Events.LEVEL_LOADED, (_evt, data) => {
          if (data.details.live) hlsLive = true;
        });
        h.on(Hls.Events.ERROR, (_evt, data) => {
          if (destroyed || !data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !triedNetwork) {
            triedNetwork = true;
            try {
              h.startLoad();
              return;
            } catch {
              /* fall through to fail */
            }
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !triedMedia) {
            triedMedia = true;
            try {
              h.recoverMediaError();
              return;
            } catch {
              /* fall through to fail */
            }
          }
          fail(MSG_STREAM);
        });

        h.loadSource(media.url);
        h.attachMedia(video);
      })
      .catch(() => fail(MSG_LOADER));
  }

  /* ---------- StagePlayer ---------- */

  return {
    play() {
      if (destroyed) return;
      safePlay();
    },
    pause() {
      if (destroyed) return;
      try {
        video.pause();
      } catch {
        /* ignore */
      }
    },
    seek(seconds) {
      if (destroyed || !Number.isFinite(seconds)) return;
      const t = Math.max(0, seconds);
      if (!ready) {
        pendingSeek = t;
        return;
      }
      if (live()) return;
      try {
        video.currentTime = t;
      } catch {
        /* ignore */
      }
    },
    getTime() {
      try {
        const t = video.currentTime;
        return Number.isFinite(t) ? t : 0;
      } catch {
        return 0;
      }
    },
    getDuration() {
      try {
        const d = video.duration;
        return Number.isFinite(d) && d > 0 ? d : 0;
      } catch {
        return 0;
      }
    },
    getState() {
      return state;
    },
    isLive() {
      return live();
    },
    getRate() {
      const r = video.playbackRate;
      return Number.isFinite(r) && r > 0 ? r : 1;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const t of timers) clearTimeout(t);
      for (const [name, fn] of listeners) video.removeEventListener(name, fn);
      try {
        hls?.destroy();
      } catch {
        /* ignore */
      }
      hls = null;
      try {
        video.pause();
        // Drop the source so the browser stops downloading right away.
        video.removeAttribute("src");
        video.load();
      } catch {
        /* ignore */
      }
      mount.replaceChildren();
    },
  };
};
