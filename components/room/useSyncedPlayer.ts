"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getSocket,
  isTimed,
  mediaKey,
  type Media,
  type PlayerAction,
  type PlayerTick,
  type RoomSnapshot,
} from "@/lib/socket";

/* The shared YouTube player.

   The server owns the playhead: { media, time, isPlaying, at } where `time`
   was true at server clock `at`. Every snapshot, action and ~3s tick carries
   one; we project it to "now" with the clock offset and steer the local
   player toward it. Local play/pause/seek from someone with video control is
   reported up — but only when it actually differs from the room, so a player
   settling after a correction can never echo back as an action.

   The iframe lives in a div React never renders children into (YouTube swaps
   its target element for an iframe; letting React own that node breaks
   unmounting when the stage clears).

   Only YouTube media has a shared timeline. When the stage holds a live
   share (LiveMedia) or nothing, the YouTube player is torn down and every
   timeline path (ticks, meta, ended, corrections) stays idle. */

let apiLoading: Promise<void> | null = null;
function loadYouTubeApi(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (apiLoading) return apiLoading;
  apiLoading = new Promise<void>((resolve) => {
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    window.onYouTubeIframeAPIReady = () => resolve();
    document.head.appendChild(tag);
  });
  return apiLoading;
}

/** The room's authoritative playhead: `time` was true at server clock `at`. */
type Playhead = { key: string; time: number; isPlaying: boolean; at: number };

// Live streams must never be seeked to an absolute time — that lands
// outside the DVR window ("recording not available"); live viewers are
// already together at the live edge. YouTube's getDuration() for a live
// stream is the time since it started (so a 2h-old stream says 7200), which
// is why liveness is read from getVideoData().isLive or a duration that
// keeps growing (see isLive below). As a fallback, an absurd duration
// (~1e8s for manifestless streams) of a day or more also counts as live.
const MAX_VOD = 86_400;
const isVod = (d: number | null | undefined): d is number =>
  typeof d === "number" && d > 0 && d < MAX_VOD;

type YTExtras = {
  getVideoData?: () => { isLive?: boolean } | undefined;
  getPlaybackRate?: () => number;
};
const extras = (p: YT.Player) => p as unknown as YTExtras;

/** What we last told the player to do; state events matching it are ours. */
type Expect = "playing" | "paused" | null;

const DRIFT_MAX = 1.5; // seconds off before a tick corrects us
const APPLY_DRIFT = 0.6; // explicit remote actions snap tighter
const SETTLE_MS = 2_500; // hands off after a remote action or a local seek
const SEEK_COOLDOWN_MS = 4_000; // between corrective seeks
const ECHO_MS = 800; // state changes this soon after we drove the player are ours
const BUFFER_SHOW_MS = 600;
const CATCH_UP_MS = 2_500;
const SNAP_MS = 1_500; // rate limit for snapping a no-control viewer back
const JUMP = 1.6; // seconds off where playing could have got us = a scrub
const META_STABLE_MS = 2_000; // a duration must hold this long to be reported

export type SyncSignals = {
  buffering: boolean;
  catchingUp: boolean;
  live: boolean;
  isPlaying: boolean;
  /** Local minus room playhead at the last tick, seconds (null = unknown). */
  drift: number | null;
};

type Controller = {
  startPlayback: () => void;
  destroy: () => void;
  getVideoTime: () => number | null;
  seekTo: (t: number) => void;
};

export function useSyncedPlayer({
  serverNow,
  canControl,
  onToast,
  onNoControl,
}: {
  serverNow: () => number;
  canControl: boolean;
  onToast: (msg: string) => void;
  /** Rate-limited "Only the host can control the video". */
  onNoControl: () => void;
}) {
  const [media, setMedia] = useState<Media | null>(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [catchingUp, setCatchingUp] = useState(false);
  const [live, setLive] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [drift, setDrift] = useState<number | null>(null);
  // Known VOD length of the YouTube video on stage (null: live, unknown, or
  // not YouTube at all).
  const [duration, setDuration] = useState<number | null>(null);

  const mountRef = useRef<HTMLDivElement>(null);
  const ctlRef = useRef<Controller | null>(null);
  // Latest props, read from YouTube and socket callbacks.
  const optsRef = useRef({ serverNow, canControl, onToast, onNoControl });
  useEffect(() => {
    optsRef.current = { serverNow, canControl, onToast, onNoControl };
  });

  useEffect(() => {
    const socket = getSocket();
    let disposed = false;

    let player: YT.Player | null = null;
    let ready = false;
    let loadedKey: string | null = null; // what the YouTube player holds
    let stage: Media | null = null; // latest stage from the server
    let head: Playhead | null = null;
    let roomDuration: number | null = null;

    let echoUntil = 0;
    let echoExpect: Expect = null;
    let echoSettled = false; // the player got to echoExpect inside the window
    let remoteAppliedAt = 0;
    let localActionAt = 0;
    let lastFixSeek = 0;
    let lastSnap = 0;
    // The last known playhead, for spotting scrubs: where, when, and
    // whether it was moving then.
    let lastTime = 0;
    let lastTimeAt = 0;
    let lastAdvancing = false;
    let seekOnPlay = false;
    // The video the player has actually played at least once. Before its
    // first PLAYING a fresh player hops around on its own (to 0, then to its
    // start point), so those jumps aren't scrubs.
    let playedKey: string | null = null;
    let tickMisses = 0;
    // Once the user has clicked into the page, browsers allow programmatic
    // playback — so the autoplay gate should never reappear after that.
    let hasInteracted = false;
    let gateShown = false;
    let recoveredKey: string | null = null;
    let metaSentKey: string | null = null;
    let endedSentKey: string | null = null;
    let liveKey: string | null = null; // loadedKey, once known to be live
    let lastDur = 0; // previous sampler duration, to spot one that grows
    let durGrowth = 0;
    let durSeen = { d: 0, at: 0 }; // a duration and since when it has held

    let bufferTimer: ReturnType<typeof setTimeout> | undefined;
    let catchTimer: ReturnType<typeof setTimeout> | undefined;
    let gateTimer: ReturnType<typeof setTimeout> | undefined;

    const now = () => optsRef.current.serverNow();

    // Where the room's playhead is right now.
    const expected = (h: Playhead) =>
      h.time + (h.isPlaying ? Math.max(0, now() - h.at) / 1000 : 0);

    const durationOf = (p: YT.Player) => {
      try {
        return p.getDuration() || 0;
      } catch {
        return 0;
      }
    };

    const rateOf = (p: YT.Player) => {
      try {
        return extras(p).getPlaybackRate?.() || 1;
      } catch {
        return 1;
      }
    };

    const markLive = () => {
      if (!loadedKey) return;
      liveKey = loadedKey;
      setLive(true);
    };

    // Is the loaded video a live stream? YouTube says so directly; failing
    // that, a day-plus duration does (the sampler also catches a duration
    // that keeps growing). Sticky per video once seen.
    const isLive = (p: YT.Player) => {
      if (!loadedKey) return false;
      if (liveKey === loadedKey) return true;
      let live = false;
      try {
        live = !!extras(p).getVideoData?.()?.isLive;
      } catch {
        /* noop */
      }
      if (durationOf(p) >= MAX_VOD) live = true;
      if (live) markLive();
      return live;
    };

    // A length we may seek within, or null for live / not-yet-known. A
    // freshly cued player often reports 0; the room's own duration (only
    // ever set for real VODs) stands in until it knows.
    const seekableLength = (p: YT.Player) => {
      if (isLive(p)) return null;
      const d = durationOf(p);
      if (isVod(d)) return d;
      if (d === 0 && isVod(roomDuration)) return roomDuration;
      return null;
    };

    // Mark the player as driven by us for `ms`. State events consistent
    // with `expect` in that window are ours; null swallows everything.
    const markDriven = (expect: Expect, ms = ECHO_MS) => {
      echoUntil = Date.now() + ms;
      echoExpect = expect;
      echoSettled = false;
      // Already there (e.g. a seek while playing): the opposite state from
      // here on is a person, not us.
      try {
        const s = readyPlayer()?.getPlayerState();
        const S = window.YT!.PlayerState;
        echoSettled =
          (expect === "playing" && s === S.PLAYING) ||
          (expect === "paused" && (s === S.PAUSED || s === S.CUED));
      } catch {
        /* noop */
      }
    };

    const noteTime = (t: number, advancing: boolean) => {
      lastTime = t;
      lastTimeAt = Date.now();
      lastAdvancing = advancing;
    };

    // Is `t` somewhere playback alone couldn't have taken us since the last
    // noted time? Unknown (false) after a long gap, e.g. throttled timers.
    const jumpedTo = (p: YT.Player, t: number) => {
      const elapsed = (Date.now() - lastTimeAt) / 1000;
      if (lastAdvancing && elapsed > 5) return false;
      const ahead = lastAdvancing ? elapsed * Math.max(1, rateOf(p)) : 0;
      return t < lastTime - JUMP || t > lastTime + ahead + JUMP;
    };

    const readyPlayer = () => (player && ready ? player : null);

    const showGate = (v: boolean) => {
      gateShown = v;
      setNeedsGesture(v);
    };

    // Browsers block programmatic autoplay without a user gesture. If the
    // video hasn't actually started shortly after, surface a tap-to-start
    // gate. Buffering gets one more look before we decide.
    const play = (p: YT.Player) => {
      p.playVideo();
      clearTimeout(gateTimer);
      const check = (again: boolean) => {
        if (hasInteracted || player !== p) return;
        // Paused (or swapped) since: not playing is right, so no gate.
        if (!head || !head.isPlaying || head.key !== loadedKey) return;
        try {
          const s = p.getPlayerState();
          if (s === window.YT!.PlayerState.PLAYING) return;
          if (s === window.YT!.PlayerState.BUFFERING && again) {
            gateTimer = setTimeout(() => check(false), 1300);
            return;
          }
          showGate(true);
        } catch {
          /* noop */
        }
      };
      gateTimer = setTimeout(() => check(true), 1200);
    };

    const flashCatchingUp = () => {
      setCatchingUp(true);
      clearTimeout(catchTimer);
      catchTimer = setTimeout(() => setCatchingUp(false), CATCH_UP_MS);
    };

    // `playing`: the state the room wants the player in around this seek.
    const syncSeek = (p: YT.Player, t: number, playing: boolean) => {
      markDriven(playing ? "playing" : "paused");
      p.seekTo(t, true);
      noteTime(t, playing);
      flashCatchingUp();
    };

    // Duration is learned lazily: report it once per video (the server only
    // trusts it from people with video control) and spot live streams. Never
    // for live, and only once it has held still a moment — a live stream's
    // "duration" keeps growing, in case YouTube didn't say it was live.
    const noteLength = (p: YT.Player) => {
      const d = durationOf(p);
      if (d <= 0) return;
      const live = isLive(p);
      setLive(live);
      const t0 = Date.now();
      if (Math.abs(d - durSeen.d) > 0.01) durSeen = { d, at: t0 };
      const stable = !live && isVod(d) && t0 - durSeen.at >= META_STABLE_MS;
      if (live) setDuration(null);
      else if (stable) setDuration(d);
      if (stable && loadedKey && metaSentKey !== loadedKey) {
        metaSentKey = loadedKey;
        socket.emit("player:meta", { key: loadedKey, duration: d });
      }
    };

    const trackBuffering = (isBuffering: boolean) => {
      if (isBuffering) {
        if (!bufferTimer) {
          bufferTimer = setTimeout(() => setBuffering(true), BUFFER_SHOW_MS);
        }
        return;
      }
      clearTimeout(bufferTimer);
      bufferTimer = undefined;
      setBuffering(false);
    };

    /* ---- Room → player ---- */

    // Snap the player to the head (a snapshot or an explicit action).
    const applyHead = () => {
      const p = readyPlayer();
      const h = head;
      if (!p || !h || h.key !== loadedKey) return;
      remoteAppliedAt = Date.now();
      markDriven(h.isPlaying ? "playing" : "paused");
      try {
        const t = expected(h);
        const len = seekableLength(p);
        // A paused room on a player that hasn't played yet: leave it on its
        // thumbnail (it was created at the right start point). Seeking now
        // would load a black, unstarted frame; the first play snaps instead.
        const untouched = !h.isPlaying && playedKey !== loadedKey;
        if (len !== null && !untouched) {
          seekOnPlay = false;
          if (t < len && Math.abs(p.getCurrentTime() - t) > APPLY_DRIFT) {
            syncSeek(p, t, h.isPlaying);
          }
        } else {
          // Length unknown yet (fresh player): seek once it starts playing.
          // Live: never — it plays at its live edge.
          seekOnPlay = !isLive(p) && durationOf(p) === 0 && t > APPLY_DRIFT;
        }
        if (h.isPlaying) play(p);
        else {
          clearTimeout(gateTimer);
          p.pauseVideo();
        }
      } catch {
        /* player not fully ready */
      }
    };

    // Gentle steering on each tick. Never emits anything.
    const correct = () => {
      const p = readyPlayer();
      const h = head;
      if (!p || !h || h.key !== loadedKey) return;
      noteLength(p);
      if (gateShown) return;
      const t0 = Date.now();
      if (t0 - remoteAppliedAt < SETTLE_MS || t0 - localActionAt < SETTLE_MS) {
        return;
      }
      const len = durationOf(p);
      if (!isVod(len) || isLive(p)) return; // live, or not loaded yet
      try {
        const S = window.YT!.PlayerState;
        const state = p.getPlayerState();
        if (
          h.isPlaying &&
          (state === S.PAUSED || state === S.CUED || state === S.UNSTARTED)
        ) {
          markDriven("playing");
          play(p);
        } else if (
          !h.isPlaying &&
          (state === S.PLAYING || state === S.BUFFERING)
        ) {
          markDriven("paused");
          clearTimeout(gateTimer);
          p.pauseVideo();
        }
        const exp = Math.min(expected(h), len);
        const off = p.getCurrentTime() - exp;
        setDrift(Math.round(off * 10) / 10);
        if (
          Math.abs(off) > DRIFT_MAX &&
          t0 - lastFixSeek > SEEK_COOLDOWN_MS &&
          exp < len - 0.5
        ) {
          lastFixSeek = t0;
          syncSeek(p, exp, h.isPlaying);
        }
      } catch {
        /* noop */
      }
    };

    // Take on a new authoritative state from the server.
    const adopt = (m: Media | null, time: number, playing: boolean, at: number) => {
      const changed = mediaKey(m) !== mediaKey(stage);
      // Only timed (YouTube) media has a playhead; a live share has none.
      const key = isTimed(m) ? mediaKey(m) : null;
      stage = m;
      head = key ? { key, time, isPlaying: playing, at } : null;
      tickMisses = 0;
      setIsPlaying(!!key && playing);
      if (changed) {
        setLive(false);
        setDrift(null);
        setBuffering(false);
        setCatchingUp(false);
        setDuration(null);
        if (!key) {
          showGate(false);
          metaSentKey = null;
          endedSentKey = null;
        }
      }
      setMedia(m);
      if (key && key === loadedKey) applyHead();
      // Otherwise build / swap / clear the player; the head is applied once
      // it's ready. (Called here, not from an effect on `media`, so a stage
      // that React already shows — e.g. after a hot reload — still loads.)
      else void loadStage();
    };

    /* ---- Player → room ---- */

    const userDid = (type: "play" | "pause" | "seek", t: number) => {
      const key = loadedKey;
      if (!key) return;
      if (type === "seek" && liveKey === key) return; // live has no position
      const h = head && head.key === key ? head : null;
      if (h) {
        if (type === "play" && h.isPlaying) return;
        if (type === "pause" && !h.isPlaying) return;
        if (type === "seek" && Math.abs(t - expected(h)) <= DRIFT_MAX) return;
      }
      if (!optsRef.current.canControl) {
        // Viewers can still use volume, captions and fullscreen, but a
        // pause/seek of their own is undone by snapping back to the room.
        // Rate-limited so a browser autoplay block can't loop it.
        const t0 = Date.now();
        if (t0 - lastSnap < SNAP_MS) return;
        lastSnap = t0;
        socket.emit("player:request-sync");
        // Pressing play (e.g. past an autoplay block) just syncs quietly.
        if (type !== "play") optsRef.current.onNoControl();
        return;
      }
      localActionAt = Date.now();
      socket.emit("player:action", { type, time: t, key });
      // Optimistic: this is the room's state now (the server only tells the
      // others). Ticks older than this are ignored.
      const playing =
        type === "play" ? true : type === "pause" ? false : !!h?.isPlaying;
      head = { key, time: t, isPlaying: playing, at: now() };
      setIsPlaying(playing);
    };

    const onStateChange = (e: { target: YT.Player; data: number }) => {
      const p = e.target;
      if (p !== player) return;
      const S = window.YT!.PlayerState;
      trackBuffering(e.data === S.BUFFERING);
      if (e.data === S.PLAYING || e.data === S.CUED) noteLength(p);

      // A live stream "ending" is the broadcast stopping, not the room's
      // video running out — never report it.
      if (
        e.data === S.ENDED &&
        loadedKey &&
        endedSentKey !== loadedKey &&
        !isLive(p)
      ) {
        endedSentKey = loadedKey;
        socket.emit("player:ended", { key: loadedKey });
      }

      if (e.data === S.PLAYING && gateShown) {
        // They pressed play inside the iframe: the gate's job is done.
        hasInteracted = true;
        showGate(false);
        socket.emit("player:request-sync");
      }

      // A deferred late-join seek: now that it plays, the length is known.
      if (e.data === S.PLAYING && seekOnPlay) {
        seekOnPlay = false;
        const h = head;
        const len = seekableLength(p);
        if (h && h.key === loadedKey && len !== null) {
          const t = expected(h);
          try {
            if (t < len && Math.abs(p.getCurrentTime() - t) > APPLY_DRIFT) {
              syncSeek(p, t, h.isPlaying);
              return;
            }
          } catch {
            /* noop */
          }
        }
      }

      let t: number;
      try {
        t = p.getCurrentTime();
      } catch {
        return;
      }
      // Detect a scrub: a jump playback alone couldn't explain.
      const firstRun = playedKey !== loadedKey;
      const jumped = !firstRun && jumpedTo(p, t);
      noteTime(t, e.data === S.PLAYING || e.data === S.BUFFERING);
      if (firstRun && e.data === S.PLAYING) {
        playedKey = loadedKey;
        // First play of a fresh player: start from the room's playhead, not
        // wherever the player happened to land.
        const h = head;
        const len = seekableLength(p);
        if (h && h.key === loadedKey && len !== null) {
          const want = expected(h);
          if (want < len && Math.abs(t - want) > APPLY_DRIFT) {
            syncSeek(p, want, true);
            if (!h.isPlaying) userDid("play", want);
            return;
          }
        }
      }

      if (Date.now() < echoUntil) {
        // We drove the player a moment ago: drop the state we sent it to and
        // anything on the way there. Only the opposite state, after it got
        // there (a pause while we made it play, or vice versa), is a person.
        const reached =
          (echoExpect === "playing" && e.data === S.PLAYING) ||
          (echoExpect === "paused" &&
            (e.data === S.PAUSED || e.data === S.CUED));
        if (reached) {
          echoSettled = true;
          return;
        }
        const contrary =
          (echoExpect === "playing" && e.data === S.PAUSED) ||
          (echoExpect === "paused" && e.data === S.PLAYING);
        if (!echoSettled || !contrary) return;
        echoUntil = 0;
        userDid(e.data === S.PLAYING ? "play" : "pause", t);
        return;
      }
      if (jumped && !isLive(p)) userDid("seek", t);
      if (e.data === S.PLAYING) userDid("play", t);
      if (e.data === S.PAUSED) userDid("pause", t);
    };

    /* ---- The stage ---- */

    const destroyPlayer = () => {
      clearTimeout(gateTimer);
      clearTimeout(bufferTimer);
      bufferTimer = undefined;
      try {
        player?.destroy();
      } catch {
        /* noop */
      }
      player = null;
      ready = false;
      loadedKey = null;
      mountRef.current?.replaceChildren();
    };

    const loadStage = async () => {
      const m = stage;
      // A live share (or an empty stage) has no YouTube player at all.
      if (!isTimed(m)) {
        destroyPlayer();
        return;
      }
      const key = mediaKey(m);
      if (key === loadedKey) return;
      if (!key) return;
      await loadYouTubeApi();
      if (disposed || mediaKey(stage) !== key || key === loadedKey) return;

      const h = head && head.key === key ? head : null;
      // Start mid-video only for a known VOD length; a live stream must start
      // at its live edge (no startSeconds at all).
      const at = h ? expected(h) : 0;
      const start = isVod(roomDuration) && at > 1 && at < roomDuration ? at : 0;
      seekOnPlay = !!h && start === 0 && at > APPLY_DRIFT;
      noteTime(start, false);
      recoveredKey = null;
      lastDur = 0;
      durGrowth = 0;
      durSeen = { d: 0, at: 0 };

      const existing = readyPlayer();
      if (existing) {
        loadedKey = key;
        remoteAppliedAt = Date.now();
        markDriven(!h || h.isPlaying ? "playing" : "paused");
        echoSettled = false; // that was the old video's state, not this one's
        try {
          if (!h || h.isPlaying) {
            existing.loadVideoById(m.id, start || undefined);
            play(existing);
          } else {
            existing.cueVideoById(m.id, start || undefined);
          }
        } catch {
          /* noop */
        }
        return;
      }

      // No player yet (or one still booting with the old video): start fresh.
      destroyPlayer();
      const mount = mountRef.current;
      if (!mount) return;
      const el = document.createElement("div");
      mount.appendChild(el);
      loadedKey = key;
      const created: YT.Player = new window.YT!.Player(el, {
        videoId: m.id,
        width: "100%",
        height: "100%",
        playerVars: {
          autoplay: 0,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          ...(start ? { start: Math.floor(start) } : {}),
        },
        events: {
          onReady: () => {
            if (player !== created) return;
            ready = true;
            applyHead();
          },
          onError: (e) => {
            // A live stream seeked outside its DVR window throws "recording
            // not available". Recover once per video by reloading at the
            // live edge (no seek). Guard against reload loops.
            if (player !== created || !loadedKey || recoveredKey === loadedKey) {
              return;
            }
            recoveredKey = loadedKey;
            markDriven(null, 1000);
            try {
              e.target.loadVideoById(isTimed(stage) ? stage.id : m.id);
            } catch {
              /* noop */
            }
          },
          onStateChange,
        },
      });
      player = created;
    };

    /* ---- Socket ---- */

    const onState = (s: RoomSnapshot) => {
      roomDuration = isTimed(s.media) ? s.duration : null;
      adopt(s.media, s.time, s.isPlaying, s.at);
      setDuration(isVod(roomDuration) ? roomDuration : null);
    };

    const onAction = (a: PlayerAction) => {
      const { onToast, onNoControl } = optsRef.current;
      if (a.denied) onNoControl();
      // `load` comes back to whoever sent it too — no toast for yourself.
      const mine = !!a.byId && a.byId === socket.id;
      if (a.by && !mine) onToast(`${a.by} ${labelFor(a)}`);
      if (a.type === "load") {
        // A fresh load — even of the same video (a replay) — wants its
        // length and its end reported again.
        roomDuration = null;
        metaSentKey = null;
        endedSentKey = null;
        durSeen = { d: 0, at: 0 };
        setDuration(null);
      }
      const m = a.media === undefined ? stage : a.media;
      adopt(
        m,
        a.time ?? 0,
        a.isPlaying ?? a.type === "play",
        a.at ?? now()
      );
    };

    const onTick = (t: PlayerTick) => {
      // Ticks are only meaningful for timed media. One arriving while we
      // hold a live share (or nothing) means we missed a change: same
      // recovery as a disagreeing key.
      if (!head || t.key !== head.key) {
        // We seem to have missed a change; after two disagreeing ticks, ask.
        if (++tickMisses >= 2) {
          tickMisses = 0;
          socket.emit("player:request-sync");
        }
        return;
      }
      tickMisses = 0;
      // Our own action may still be in flight: a tick the server sent before
      // processing it would flip us back, so hold off until it has settled.
      if (Date.now() - localActionAt < SETTLE_MS) return;
      // Older than what we know (e.g. sent before our own action landed).
      if (t.at < head.at) return;
      head = { key: t.key, time: t.time, isPlaying: t.isPlaying, at: t.at };
      setIsPlaying(t.isPlaying);
      correct();
    };

    // Title / thumbnail arrive a moment after the video starts.
    const onMediaMeta = (m: Media) => {
      if (!isTimed(stage) || !isTimed(m) || mediaKey(m) !== mediaKey(stage)) {
        return;
      }
      stage = { ...stage, ...m };
      setMedia(stage);
    };

    // Back from a hidden tab: timers were throttled, so ask where we are.
    const onVisible = () => {
      if (
        document.visibilityState === "visible" &&
        socket.connected &&
        isTimed(stage)
      ) {
        socket.emit("player:request-sync");
      }
    };

    socket.on("room:state", onState);
    socket.on("player:action", onAction);
    socket.on("player:tick", onTick);
    socket.on("room:media", onMediaMeta);
    document.addEventListener("visibilitychange", onVisible);

    // Sample current time so seek detection has a reference point — and
    // catch scrubs that fire no state event of their own (scrubbing while
    // paused) or land before it does, instead of silently overwriting them.
    const sampler = setInterval(() => {
      const p = readyPlayer();
      if (!p) return;
      try {
        // A "duration" that keeps growing is a live stream.
        const d = durationOf(p);
        if (lastDur > 0 && d > lastDur + 0.5 && ++durGrowth >= 2) markLive();
        lastDur = d;

        const S = window.YT!.PlayerState;
        const state = p.getPlayerState();
        // Mid-transition: leave the reference for the state event to judge.
        if (state === S.BUFFERING || state === S.UNSTARTED) return;
        const t = p.getCurrentTime();
        const jumped = jumpedTo(p, t);
        noteTime(t, state === S.PLAYING);
        // Our own seeks and remote applies sit inside the echo window.
        if (!jumped || Date.now() < echoUntil || isLive(p)) return;
        if (playedKey !== loadedKey) return; // still settling on first load
        userDid("seek", t);
      } catch {
        /* noop */
      }
    }, 900);

    ctlRef.current = {
      // User gesture to unblock playback for a late joiner, then snap to the room.
      startPlayback: () => {
        hasInteracted = true;
        showGate(false);
        // Only when the room is playing: a controller tapping the gate must
        // never resume a paused room by itself.
        if (head && head.isPlaying && head.key === loadedKey) {
          try {
            player?.playVideo();
          } catch {
            /* noop */
          }
        }
        socket.emit("player:request-sync");
      },
      // Outside the room (removed / ended / password): drop everything,
      // React state included, so nothing downstream — the live stage in
      // particular — keeps acting on the old media.
      destroy: () => {
        stage = null;
        head = null;
        tickMisses = 0;
        showGate(false);
        destroyPlayer();
        setMedia(null);
        setIsPlaying(false);
        setLive(false);
        setDrift(null);
        setBuffering(false);
        setCatchingUp(false);
        setDuration(null);
      },
      // The YouTube playhead right now, or null when nothing timed is loaded.
      getVideoTime: () => {
        const p = readyPlayer();
        if (!p || !isTimed(stage) || loadedKey !== mediaKey(stage)) return null;
        try {
          const t = p.getCurrentTime();
          return Number.isFinite(t) ? t : null;
        } catch {
          return null;
        }
      },
      // Jump the room to `t` (timestamps, moments). Viewers without video
      // control get the usual "only the host" nudge instead.
      seekTo: (target: number) => {
        if (!isTimed(stage) || !Number.isFinite(target)) return;
        if (!optsRef.current.canControl) {
          optsRef.current.onNoControl();
          return;
        }
        const key = mediaKey(stage);
        if (!key || liveKey === key) return; // a live stream has no position
        const p = readyPlayer();
        const len = p && loadedKey === key ? seekableLength(p) : null;
        const known = len ?? (isVod(roomDuration) ? roomDuration : null);
        let t = Math.max(0, target);
        if (known !== null) t = Math.min(t, Math.max(0, known - 0.5));
        const playing = !!(head && head.key === key && head.isPlaying);
        if (p && loadedKey === key) {
          try {
            // Our own seek: inside the echo window so it isn't re-reported.
            markDriven(playing ? "playing" : "paused");
            p.seekTo(t, true);
            noteTime(t, playing);
          } catch {
            /* noop */
          }
        }
        localActionAt = Date.now();
        socket.emit("player:action", { type: "seek", time: t, key });
        head = { key, time: t, isPlaying: playing, at: now() };
      },
    };

    return () => {
      disposed = true;
      socket.off("room:state", onState);
      socket.off("player:action", onAction);
      socket.off("player:tick", onTick);
      socket.off("room:media", onMediaMeta);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(sampler);
      clearTimeout(catchTimer);
      destroyPlayer();
      ctlRef.current = null;
    };
  }, []);

  const startPlayback = useCallback(() => ctlRef.current?.startPlayback(), []);
  const destroy = useCallback(() => ctlRef.current?.destroy(), []);
  const resync = useCallback(() => getSocket().emit("player:request-sync"), []);
  const getVideoTime = useCallback(
    () => ctlRef.current?.getVideoTime() ?? null,
    []
  );
  const seekTo = useCallback((t: number) => ctlRef.current?.seekTo(t), []);

  const sync: SyncSignals = { buffering, catchingUp, live, isPlaying, drift };
  return {
    media,
    mountRef,
    needsGesture,
    startPlayback,
    resync,
    destroy,
    sync,
    duration,
    getVideoTime,
    seekTo,
  };
}

function labelFor({ type, media }: PlayerAction) {
  if (type === "load" && media?.kind === "live") return "started a live share";
  if (type === "load" && media === null) return "cleared the stage";
  switch (type) {
    case "play":
      return "pressed play";
    case "pause":
      return "paused";
    case "seek":
      return "skipped ahead";
    case "load":
      return "changed the video";
  }
}
