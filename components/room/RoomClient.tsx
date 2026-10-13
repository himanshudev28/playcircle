"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Logo } from "@/components/Logo";
import { Icon } from "@/components/Icon";
import {
  getClientId,
  getSocket,
  isTimed,
  type ChatMessage,
  type DeniedReason,
  type LiveReaction,
  type Media,
  type Moment,
  type Perms,
  type PlayerAction,
  type Poll,
  type PollClosed,
  type QueueReply,
  type QueueState,
  type Reply,
  type RoomSettings,
  type RoomSnapshot,
  type RoomUser,
  type VideoMedia,
} from "@/lib/socket";
import { prefetchIce } from "@/lib/ice";
import { useCall } from "./useCall";
import { Avatar, CallPanel } from "./CallPanel";
import { Chat } from "./Chat";
import { LiveStageView } from "./LiveStageView";
import { PeoplePanel } from "./PeoplePanel";
import { PollCard, PollComposer, VoteButtons } from "./Polls";
import { QueuePanel } from "./QueuePanel";
import { MomentsTimeline, ReactionBar, ReactionOverlay } from "./Reactions";
import { ShareMenu } from "./ShareMenu";
import { useClockOffset } from "./useClockOffset";
import { useLiveStage } from "./useLiveStage";
import { useSyncedPlayer } from "./useSyncedPlayer";
import { SyncStatus, syncStateOf } from "./SyncStatus";
import { SourceBadge, mediaTitle, mediaUrl } from "./mediaInfo";

const ACK_TIMEOUT = 8000;
/** A pasted link is resolved on the server (it may fetch the page), which
    can take up to ~12 s — leave headroom so a slow resolve isn't reported
    as unreachable while the server still loads / queues it. */
const LOAD_TIMEOUT = 20000;

// Leaving is deferred a tick so React's dev-mode double mount (unmount +
// immediate remount) doesn't bounce you out of the room and back in.
let leaveTimer: ReturnType<typeof setTimeout> | undefined;

// The display name lives in localStorage. "" = none saved (go to /join);
// null = not on the client yet (server render / hydration).
const noSubscribe = () => () => {};
function readSavedName(): string {
  try {
    return localStorage.getItem("wnp-name") ?? "";
  } catch {
    return "";
  }
}

const EMPTY_QUEUE: QueueState = { items: [], history: [] };
/** How long a closed poll's result stays on screen. */
const POLL_RESULT_MS = 8000;
/** Local cap on the reactions timeline (the server sends its own list). */
const MAX_MOMENTS = 500;

export function RoomClient({ code }: { code: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const name = useSyncExternalStore(noSubscribe, readSavedName, () => null);
  const [connected, setConnected] = useState(false);
  const [users, setUsers] = useState<RoomUser[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [queue, setQueue] = useState<QueueState>(EMPTY_QUEUE);
  const [urlInput, setUrlInput] = useState("");
  // A pasted link being resolved by the server: which button sent it.
  const [finding, setFinding] = useState<"play" | "queue" | null>(null);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [selfBrowser, setSelfBrowser] = useState<string | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [settings, setSettings] = useState<RoomSettings>({
    locked: false,
    playback: "host",
    approval: true,
    order: "votes",
    autoplay: true,
    voteSkip: false,
    hasPassword: false,
  });
  const [pinned, setPinned] = useState<ChatMessage | null>(null);
  const [moments, setMoments] = useState<Moment[]>([]);
  const [poll, setPoll] = useState<Poll | null>(null);
  const [lastClosed, setLastClosed] = useState<PollClosed | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [denied, setDenied] = useState<{
    reason: DeniedReason;
    wasHost: boolean;
  } | null>(null);
  // Password rooms: the gate shows instead of the room until one is accepted.
  const [passwordGate, setPasswordGate] = useState<{
    wrong: boolean;
    /** Too many attempts: the server stopped checking for a minute. */
    limited: boolean;
    checking: boolean;
  } | null>(null);
  // Kept in memory only (never the URL or storage), so a reconnect during
  // this page session can rejoin without asking again.
  const passwordRef = useRef<string | null>(null);
  const deniedRef = useRef(false);
  const lastClosedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const mediaRef = useRef<Media | null>(null);
  const lastNoControlToastRef = useRef(0);
  const hostIdRef = useRef<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );

  // No saved name: pick one first, then come back.
  useEffect(() => {
    if (name === "") router.replace(`/join?next=${encodeURIComponent(code)}`);
  }, [name, code, router]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    clearTimeout(toastTimerRef.current);
    // Long messages (why a link can't play, what to do instead) stay up
    // long enough to read.
    const ms = Math.min(7000, Math.max(2200, msg.length * 60));
    toastTimerRef.current = setTimeout(() => setToast(null), ms);
  }, []);

  const call = useCall(showToast);

  const self = users.find((u) => u.id === selfId);
  const perms: Perms = self?.perms ?? { video: false, chat: true, call: true };
  const selfIsAdmin = !!self && (self.id === hostId || self.owner);
  // Room-wide switches: the creator, or the host standing in while they're away.
  const ownerHere = users.some((u) => u.owner);
  const canRunRoom = !!self?.owner || (!!selfId && selfId === hostId && !ownerHere);
  const readyCount = queue.items.filter((q) => q.status === "ready").length;

  const noControlToast = useCallback(() => {
    const now = Date.now();
    if (now - lastNoControlToastRef.current < 4000) return;
    lastNoControlToastRef.current = now;
    showToast("Only the host can control the video");
  }, [showToast]);

  const serverNow = useClockOffset();
  const {
    media,
    mountRef,
    needsGesture,
    startPlayback,
    resync: requestSync,
    destroy: destroyPlayer,
    sync,
    duration,
    error: playerError,
    getVideoTime,
    seekTo,
  } = useSyncedPlayer({
    serverNow,
    canControl: perms.video,
    onToast: showToast,
    onNoControl: noControlToast,
  });
  useEffect(() => {
    mediaRef.current = media;
  }, [media]);

  // The player box (stage, reactions, error overlay) is what goes full
  // screen — not the embed's iframe — so reactions and the floating call
  // bubbles (portalled into the fullscreen element) stay visible.
  const playerBoxRef = useRef<HTMLDivElement>(null);
  const boxFull = useBoxFullscreen(playerBoxRef);

  // Relay credentials ready before anyone calls or shares.
  useEffect(() => {
    void prefetchIce();
  }, []);
  const shareAs = useMemo(
    () => (name ? { code, name, clientId: getClientId() } : null),
    [code, name]
  );
  const stage = useLiveStage({ media, selfId, onToast: showToast, self: shareAs });
  // A camera share's mic would double your voice for anyone in the call.
  const { setCameraMic } = stage;
  const sharingCamera = !!stage.camera;
  useEffect(() => {
    if (sharingCamera) setCameraMic(!call.inCall);
  }, [sharingCamera, call.inCall, setCameraMic]);

  // Join (or rejoin) the room, with the remembered password if there is one.
  const emitJoin = useCallback(() => {
    if (!name) return;
    getSocket().emit("room:join", {
      code,
      name,
      clientId: getClientId(),
      title: searchParams.get("title") || undefined,
      isPublic: searchParams.get("public") === "1",
      password: passwordRef.current ?? undefined,
    });
  }, [code, name, searchParams]);

  function submitPassword(password: string) {
    passwordRef.current = password;
    // Let joins through again: this one, and a reconnect's if the socket
    // drops before the answer arrives.
    deniedRef.current = false;
    setPasswordGate({ wrong: false, limited: false, checking: true });
    if (getSocket().connected) emitJoin();
  }

  // ---- Socket wiring (playback events live in useSyncedPlayer) ----
  useEffect(() => {
    if (!name) return;
    const socket = getSocket();
    clearTimeout(leaveTimer);

    const onConnect = () => {
      setConnected(true);
      setSelfId(socket.id ?? null);
      // Removed / ended / waiting on a password: don't let a reconnect
      // quietly walk back in (or loop on the password prompt).
      if (deniedRef.current) return;
      // A reconnect rejoins; the room:state reply resyncs the player.
      emitJoin();
    };
    const onState = (s: RoomSnapshot) => {
      setPasswordGate(null);
      setUsers(s.users);
      setSelfBrowser(s.selfBrowser);
      setHostId(s.hostId);
      hostIdRef.current = s.hostId;
      setSettings(s.settings);
      setMessages(s.messages || []);
      setQueue(s.queue || EMPTY_QUEUE);
      setPinned(s.pinned ?? null);
      setMoments(s.moments ?? []);
      setPoll(s.poll ?? null);
    };
    const onUsers = (u: RoomUser[]) => setUsers(u);
    const onChat = (m: ChatMessage) =>
      setMessages((prev) => [...prev.slice(-199), m]);
    // Reactions on a message changed: replace it in place.
    const onChatUpdate = (m: ChatMessage) => {
      setMessages((prev) => prev.map((x) => (x.id === m.id ? m : x)));
      setPinned((p) => (p && p.id === m.id ? m : p));
    };
    const onChatRemoved = (id: string) => {
      setMessages((prev) => prev.filter((x) => x.id !== id));
      setPinned((p) => (p && p.id === id ? null : p));
    };
    const onChatPinned = (m: ChatMessage | null) => setPinned(m);
    const onQueue = (q: QueueState) => setQueue(q);

    // Floating reactions land on the video's timeline (videos only — a live
    // share has none).
    const onReaction = (r: LiveReaction) => {
      const t = r.t;
      if (t === null || !isTimed(mediaRef.current)) return;
      setMoments((prev) => [...prev.slice(-(MAX_MOMENTS - 1)), { t, e: r.emoji }]);
    };
    // Any load (new video, replay, live share, cleared stage) starts a fresh
    // timeline.
    const onPlayerAction = (a: PlayerAction) => {
      if (a.type === "load") setMoments([]);
    };
    const onPollUpdate = (p: Poll | null) => setPoll(p);
    const onPollClosed = (c: PollClosed) => {
      setLastClosed(c);
      setPoll((p) => (p && p.id === c.poll.id ? null : p));
      clearTimeout(lastClosedTimerRef.current);
      lastClosedTimerRef.current = setTimeout(
        () => setLastClosed(null),
        POLL_RESULT_MS
      );
    };

    const onHost = (id: string | null) => {
      setHostId(id);
      hostIdRef.current = id;
      if (id && id === socket.id) showToast("You're the host now");
    };
    const onSettings = (next: RoomSettings) => setSettings(next);
    const onNotice = (text: string) => showToast(text);
    const onDenied = ({
      reason,
      wrong,
      limited,
    }: {
      reason: DeniedReason;
      wrong?: boolean;
      /** Password attempts are rate-limited; this one wasn't checked. */
      limited?: boolean;
    }) => {
      // Either way we're outside the room now: no auto-rejoin on reconnect
      // and no room:leave on unmount. (useLiveStage hears this too and
      // stops any share / viewing locally; destroyPlayer clears `media`.)
      deniedRef.current = true;
      call.teardown();
      destroyPlayer();
      if (reason === "password") {
        if (limited) {
          // Not a verdict on the password: keep it for the next try.
          setPasswordGate({ wrong: false, limited: true, checking: false });
          return;
        }
        // A remembered password that stopped working (changed by the host)
        // is forgotten, so the next reconnect doesn't retry it.
        if (wrong) passwordRef.current = null;
        setPasswordGate({ wrong: !!wrong, limited: false, checking: false });
        return;
      }
      setPasswordGate(null);
      setDenied({ reason, wasHost: hostIdRef.current === socket.id });
    };
    const onDisconnect = () => setConnected(false);

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("room:state", onState);
    socket.on("room:users", onUsers);
    socket.on("room:host", onHost);
    socket.on("room:settings", onSettings);
    socket.on("room:notice", onNotice);
    socket.on("room:denied", onDenied);
    socket.on("chat:message", onChat);
    socket.on("chat:update", onChatUpdate);
    socket.on("chat:removed", onChatRemoved);
    socket.on("chat:pinned", onChatPinned);
    socket.on("queue:update", onQueue);
    socket.on("reaction", onReaction);
    socket.on("player:action", onPlayerAction);
    socket.on("poll:update", onPollUpdate);
    socket.on("poll:closed", onPollClosed);

    if (socket.connected) onConnect();

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("room:state", onState);
      socket.off("room:users", onUsers);
      socket.off("room:host", onHost);
      socket.off("room:settings", onSettings);
      socket.off("room:notice", onNotice);
      socket.off("room:denied", onDenied);
      socket.off("chat:message", onChat);
      socket.off("chat:update", onChatUpdate);
      socket.off("chat:removed", onChatRemoved);
      socket.off("chat:pinned", onChatPinned);
      socket.off("queue:update", onQueue);
      socket.off("reaction", onReaction);
      socket.off("player:action", onPlayerAction);
      socket.off("poll:update", onPollUpdate);
      socket.off("poll:closed", onPollClosed);
      clearTimeout(lastClosedTimerRef.current);
      // Client-side navigation away from the room: free our seat right away
      // instead of waiting for the socket to drop.
      if (!deniedRef.current) {
        leaveTimer = setTimeout(() => socket.emit("room:leave", { code }), 150);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, code]);

  // Clear the box after a link landed — unless they've typed something new
  // while the server was resolving it.
  function clearInput(sent: string) {
    setUrlInput((v) => (v.trim() === sent ? "" : v));
  }

  // Play now: straight onto the stage. Any link goes to the server, which
  // works out what video it is (YouTube, Vimeo, a file, a page with a video…)
  // and echoes the load back to everyone (us included) — that's what
  // actually swaps the video. The ack only says whether it worked.
  function playNow() {
    if (!perms.video) {
      noControlToast();
      return;
    }
    const input = urlInput.trim();
    if (!input || finding) return;
    setFinding("play");
    getSocket()
      .timeout(LOAD_TIMEOUT)
      .emit(
        "player:action",
        { type: "load", input },
        (err: Error | null, res?: Reply) => {
          setFinding(null);
          if (err || !res) return showToast("Couldn't reach the room — try again");
          if (!res.ok) return showToast(res.error || "Couldn't play that link");
          clearInput(input);
        }
      );
  }

  function addToQueue() {
    const input = urlInput.trim();
    if (!input || finding) return;
    if (!perms.chat) {
      showToast("The host turned off your suggestions");
      return;
    }
    setFinding("queue");
    getSocket()
      .timeout(LOAD_TIMEOUT)
      .emit("queue:add", { input }, (err: Error | null, res?: QueueReply) => {
        setFinding(null);
        if (err || !res) return showToast("Couldn't reach the room — try again");
        if (!res.ok) return showToast(res.error || "Couldn't add that video");
        clearInput(input);
        if (res.status === "pending") {
          showToast(
            res.duplicate
              ? "Already suggested — waiting for the host"
              : "Sent to the host for approval"
          );
        } else {
          showToast(
            res.duplicate ? "Already queued — counted your vote" : "Added to Up next"
          );
        }
      });
  }

  function skip() {
    getSocket()
      .timeout(ACK_TIMEOUT)
      .emit("queue:skip", {}, (err: Error | null, res?: QueueReply) => {
        if (err || !res) return showToast("Couldn't reach the room — try again");
        if (!res.ok) showToast(res.error || "Couldn't skip right now");
      });
  }

  function resync() {
    requestSync();
    showToast("Re-syncing to the room…");
  }

  function copyLink() {
    // A clean link: no ?title/&public leftovers from when the room was made.
    navigator.clipboard?.writeText(`${window.location.origin}/room/${code}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  if (!name) return null;
  if (denied) return <RoomClosed {...denied} />;

  const timed = isTimed(media);
  const liveMedia = media?.kind === "live" ? media : null;
  const syncState = syncStateOf(connected, sync, !!liveMedia);
  const hasLink = urlInput.trim().length > 0;
  const canCallVote = selfIsAdmin || (settings.voteSkip && perms.chat);

  // The password gate covers the room rather than replacing it: the player's
  // mount node has to exist the moment the accepted join's room:state lands.
  return (
    <>
      <div
        className="flex min-h-screen flex-col"
        inert={!!passwordGate}
        aria-hidden={passwordGate ? true : undefined}
      >
        <RoomHeader
          code={code}
          users={users}
          hostId={hostId}
          connected={connected}
          copied={copied}
          onCopy={copyLink}
        />

        <div className="mx-auto grid w-full max-w-7xl flex-1 gap-4 px-4 py-4 lg:grid-cols-[1fr_360px]">
          {/* Player column */}
          <div className="flex min-w-0 flex-col gap-4">
            <div>
              <div
                ref={playerBoxRef}
                className={`group/box relative w-full overflow-hidden bg-ink ${
                  boxFull.full
                    ? "grid h-screen w-screen place-items-center"
                    : "aspect-video rounded-panel border border-edge"
                }`}
              >
                {/* The player owns everything inside this div; React never renders into it. */}
                <div
                  ref={mountRef}
                  className={`absolute inset-0 ${timed ? "" : "hidden"}`}
                />
                {liveMedia && (
                  <LiveStageView
                    api={stage}
                    media={liveMedia}
                    isAdmin={selfIsAdmin}
                  />
                )}
                {!media && <EmptyStage canControl={perms.video} />}
                {timed && playerError && (
                  <PlayerError media={media} message={playerError} />
                )}
                {timed && needsGesture && !playerError && (
                  <button
                    onClick={startPlayback}
                    className="absolute inset-0 z-10 grid place-items-center bg-ink/80 backdrop-blur-sm transition"
                  >
                    <span className="flex flex-col items-center gap-4">
                      <span className="grid h-20 w-20 place-items-center rounded-full bg-signal shadow-[0_0_50px_-8px_rgba(244,67,60,0.85)] transition hover:scale-105">
                        <svg width={30} height={30} viewBox="0 0 24 24" fill="white">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      </span>
                      <span className="text-sm font-semibold">
                        Tap to join the watch party
                      </span>
                      <span className="text-xs text-smoke">
                        Your browser paused autoplay — this syncs you to everyone else
                      </span>
                    </span>
                  </button>
                )}
                <ReactionOverlay />
                {timed && boxFull.full && (
                  // In full screen the title row is gone: a way back out,
                  // shown on hover (always on touch screens) so it doesn't
                  // sit over the embed's own controls the whole time.
                  <div className="absolute right-3 top-3 z-20 opacity-0 transition-opacity focus-within:opacity-100 group-hover/box:opacity-100 [@media(hover:none)]:opacity-100">
                    <PlayerFullscreenButton full onToggle={boxFull.toggle} />
                  </div>
                )}
              </div>

              {timed && (
                <MomentsTimeline
                  moments={moments}
                  duration={duration}
                  currentTime={getVideoTime}
                  onSeek={seekTo}
                />
              )}

              {(media || !connected) && (
                <NowPlayingRow media={media}>
                  <div className="flex shrink-0 items-center gap-2">
                    <SyncStatus state={syncState} drift={sync.drift} />
                    {timed && boxFull.supported && (
                      <PlayerFullscreenButton
                        full={boxFull.full}
                        onToggle={boxFull.toggle}
                      />
                    )}
                  </div>
                </NowPlayingRow>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 px-1 pt-2.5">
                <ReactionBar disabled={!perms.chat} />
                {timed && (
                  <VoteButtons
                    canCall={canCallVote}
                    hasNext={readyCount > 0}
                    pollRunning={!!poll}
                    onToast={showToast}
                  />
                )}
              </div>
            </div>

            <div className="flex flex-col gap-2 rounded-panel border border-edge bg-film p-3 sm:flex-row">
              <input
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  if (perms.video) playNow();
                  else addToQueue();
                }}
                disabled={!perms.video && !perms.chat}
                placeholder={
                  perms.video || perms.chat
                    ? "Paste a link — YouTube, Vimeo, Twitch, a video file, or any page with a video…"
                    : "The host turned off your suggestions"
                }
                aria-label="Video link"
                aria-busy={!!finding}
                maxLength={2000}
                className="w-full min-w-0 rounded-card border border-edge bg-ink px-4 py-3 text-sm outline-none transition focus:border-signal/60 disabled:cursor-not-allowed disabled:opacity-60"
              />
              <div className="flex flex-wrap gap-2 sm:flex-nowrap">
                <button
                  onClick={playNow}
                  disabled={!perms.video || !hasLink || !!finding}
                  title={
                    perms.video
                      ? "Start this video for everyone now"
                      : "Only the host can change the video"
                  }
                  className="flex-1 whitespace-nowrap rounded-card bg-signal px-4 py-3 text-sm font-semibold transition hover:bg-signal-hot active:scale-95 disabled:pointer-events-none disabled:opacity-40 sm:flex-none"
                >
                  {finding === "play" ? "Finding the video…" : "Play now"}
                </button>
                <button
                  onClick={addToQueue}
                  disabled={!perms.chat || !hasLink || !!finding}
                  title="Add it to Up next"
                  className="flex-1 whitespace-nowrap rounded-card border border-edge bg-bone/5 px-4 py-3 text-sm font-medium transition hover:bg-bone/10 active:scale-95 disabled:pointer-events-none disabled:opacity-40 sm:flex-none"
                >
                  {finding === "queue" ? "Finding the video…" : "Add to queue"}
                </button>
                {perms.video && readyCount > 0 && (
                  <button
                    onClick={skip}
                    title="Play the next video in Up next"
                    className="whitespace-nowrap rounded-card border border-edge bg-bone/5 px-4 py-3 text-sm font-medium transition hover:bg-bone/10 active:scale-95"
                  >
                    Skip
                  </button>
                )}
                {!liveMedia && (
                  <button
                    onClick={resync}
                    title="Snap to the room's current position"
                    className="whitespace-nowrap rounded-card border border-edge bg-bone/5 px-4 py-3 text-sm font-medium transition hover:bg-bone/10 active:scale-95"
                  >
                    Resync
                  </button>
                )}
                <ShareMenu api={stage} canShare={perms.video} inCall={call.inCall} />
              </div>
            </div>

            <CallPanel
              call={call}
              users={users}
              selfId={selfId}
              canCall={perms.call}
            />
          </div>

          <SidePanel
            users={users}
            selfId={selfId}
            selfBrowser={selfBrowser}
            hostId={hostId}
            settings={settings}
            selfIsAdmin={selfIsAdmin}
            canRunRoom={canRunRoom}
            perms={perms}
            messages={messages}
            queue={queue}
            media={media}
            pinned={pinned}
            poll={poll}
            lastClosed={lastClosed}
            serverNow={serverNow}
            getVideoTime={getVideoTime}
            onSeek={seekTo}
            onNewPoll={() => setComposerOpen(true)}
            onToast={showToast}
          />
        </div>

        {selfIsAdmin && (
          <PollComposer
            open={composerOpen}
            onClose={() => setComposerOpen(false)}
            queue={queue}
            onToast={showToast}
          />
        )}

        {toast && (
          <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full border border-edge bg-film-2/95 px-5 py-2.5 text-sm shadow-xl backdrop-blur">
            {toast}
          </div>
        )}
      </div>
      {passwordGate && (
        <PasswordGate
          code={code}
          wrong={passwordGate.wrong}
          limited={passwordGate.limited}
          checking={passwordGate.checking}
          connected={connected}
          onSubmit={submitPassword}
        />
      )}
    </>
  );
}

// Slim row under the player: what's on, and how we're doing against the room.
/* ------------------------------------------------- player full screen */

// Element fullscreen exists (iOS Safari only has the <video>'s own, which an
// embed handles itself). Read on the client only, so SSR renders no button.
const fullscreenSupported = () =>
  typeof document !== "undefined" && !!document.fullscreenEnabled;

function useBoxFullscreen(boxRef: RefObject<HTMLDivElement | null>) {
  const supported = useSyncExternalStore(noSubscribe, fullscreenSupported, () => false);
  const [full, setFull] = useState(false);

  useEffect(() => {
    const onChange = () =>
      setFull(!!boxRef.current && document.fullscreenElement === boxRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [boxRef]);

  const toggle = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (typeof box.requestFullscreen === "function") {
      box.requestFullscreen().catch(() => {});
    }
  }, [boxRef]);

  return { supported, full, toggle };
}

function PlayerFullscreenButton({
  full,
  onToggle,
}: {
  full: boolean;
  onToggle: () => void;
}) {
  const label = full ? "Exit full screen" : "Full screen";
  return (
    <button
      type="button"
      onClick={onToggle}
      title={label}
      aria-label={label}
      className="grid h-8 w-8 place-items-center rounded-full border border-edge bg-ink/70 text-bone backdrop-blur-sm transition hover:bg-film-2"
    >
      <svg
        width={15}
        height={15}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {full ? (
          <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
        ) : (
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
        )}
      </svg>
    </button>
  );
}

function NowPlayingRow({
  media,
  children,
}: {
  media: Media | null;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-1 pt-2.5">
      <div className="min-w-0">
        {media?.kind === "live" ? (
          <>
            <p className="truncate text-sm font-semibold text-bone">
              {media.title || "Live share"}
            </p>
            <p className="truncate text-xs text-smoke">Live share by {media.by}</p>
          </>
        ) : media?.kind === "youtube" && !media.title ? (
          // No title (yet, or the lookup failed): the id still says what it is.
          <p className="truncate font-mono text-xs text-dim">youtu.be/{media.id}</p>
        ) : media ? (
          <>
            <p className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-semibold text-bone">
                {mediaTitle(media)}
              </span>
              <SourceBadge media={media} />
            </p>
            {media.author && (
              <p className="truncate text-xs text-smoke">{media.author}</p>
            )}
          </>
        ) : null}
      </div>
      {children}
    </div>
  );
}

// The player couldn't play this video (embedding blocked, removed, a format
// the browser can't decode…). Point at the original, and at sharing it live.
function PlayerError({
  media,
  message,
}: {
  media: VideoMedia;
  message: string;
}) {
  return (
    <div
      role="alert"
      className="absolute inset-0 z-10 grid place-items-center overflow-y-auto bg-ink/90 px-6 py-4 text-center backdrop-blur-sm"
    >
      <div className="max-w-sm">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-full border border-edge bg-film text-dim">
          <Icon name="film" size={24} />
        </div>
        <h2 className="mt-4 font-display text-lg font-bold text-bone">
          This video can&apos;t play here
        </h2>
        <p className="mt-2 text-sm text-smoke">{message}</p>
        <a
          href={mediaUrl(media)}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-5 inline-flex items-center gap-2 rounded-card border border-edge bg-bone/5 px-4 py-2.5 text-sm font-semibold text-bone transition hover:bg-bone/10 active:scale-95"
        >
          Open original
          <Icon name="arrowRight" size={15} />
        </a>
        <p className="mt-4 text-xs text-dim">
          Or share it live: open it in another tab, then use Share → Browser
          tab so everyone watches with you.
        </p>
      </div>
    </div>
  );
}

function RoomHeader({
  code,
  users,
  hostId,
  connected,
  copied,
  onCopy,
}: {
  code: string;
  users: RoomUser[];
  hostId: string | null;
  connected: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-edge bg-ink/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
        <div className="flex items-center gap-4">
          <Logo size="sm" />
          <Link
            href="/lobby"
            className="hidden items-center gap-1.5 text-sm text-smoke transition hover:text-bone sm:flex"
          >
            <Icon name="arrowLeft" size={15} />
            Lobby
          </Link>
          <span className="hidden items-center gap-2 rounded-full border border-edge bg-film px-3 py-1.5 font-mono text-sm tracking-wider sm:flex">
            {code}
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                connected ? "bg-emerald-400" : "bg-dim"
              }`}
            />
          </span>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex -space-x-2">
            {users.slice(0, 5).map((u) => (
              <span key={u.id} className="relative">
                <Avatar user={u} size={32} ring="border-film" />
                {u.id === hostId && (
                  <span className="absolute -top-1.5 left-1/2 -translate-x-1/2 text-tungsten">
                    <Icon name="crown" size={11} />
                  </span>
                )}
              </span>
            ))}
            {users.length > 5 && (
              <span className="grid h-8 w-8 place-items-center rounded-full border-2 border-film bg-film-2 text-xs">
                +{users.length - 5}
              </span>
            )}
          </div>
          <span className="hidden text-sm text-smoke sm:block">
            {users.length} watching
          </span>
          <button
            onClick={onCopy}
            className="rounded-card bg-signal px-4 py-2 text-sm font-semibold transition hover:bg-signal-hot active:scale-95"
          >
            {copied ? "Copied!" : "Invite"}
          </button>
        </div>
      </div>
    </header>
  );
}

function EmptyStage({ canControl }: { canControl: boolean }) {
  return (
    <div className="grid h-full place-items-center bg-[radial-gradient(60%_60%_at_50%_40%,rgba(244,67,60,0.12),transparent_70%)] text-center">
      <div className="px-6">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-full border border-edge bg-film text-dim">
          <Icon name="film" size={26} />
        </div>
        <h2 className="mt-5 font-display text-xl font-bold text-bone">
          Nothing playing yet
        </h2>
        <p className="mt-2 text-sm text-smoke">
          {canControl
            ? "Paste a link below — YouTube, Vimeo, Twitch, a video file or a page with a video — and it starts for everyone in the room."
            : "The host picks what plays. Sit tight — it starts for you automatically."}
        </p>
      </div>
    </div>
  );
}

type SideTab = "chat" | "queue" | "people";

function SidePanel({
  users,
  selfId,
  selfBrowser,
  hostId,
  settings,
  selfIsAdmin,
  canRunRoom,
  perms,
  messages,
  queue,
  media,
  pinned,
  poll,
  lastClosed,
  serverNow,
  getVideoTime,
  onSeek,
  onNewPoll,
  onToast,
}: {
  users: RoomUser[];
  selfId: string | null;
  selfBrowser: string | null;
  hostId: string | null;
  settings: RoomSettings;
  selfIsAdmin: boolean;
  canRunRoom: boolean;
  perms: Perms;
  messages: ChatMessage[];
  queue: QueueState;
  media: Media | null;
  pinned: ChatMessage | null;
  poll: Poll | null;
  lastClosed: PollClosed | null;
  serverNow: () => number;
  getVideoTime: () => number | null;
  onSeek: (t: number) => void;
  onNewPoll: () => void;
  onToast: (msg: string) => void;
}) {
  const [tab, setTab] = useState<SideTab>("chat");
  const locked = settings.locked;
  const ready = queue.items.filter((q) => q.status === "ready").length;
  // Suggestions waiting on a decision — only the people who decide see them.
  const pending = selfIsAdmin
    ? queue.items.filter((q) => q.status === "pending").length
    : 0;
  const tabs: { id: SideTab; label: string; count?: number }[] = [
    { id: "chat", label: "Chat" },
    { id: "queue", label: "Up next", count: ready },
    { id: "people", label: "People", count: users.length },
  ];

  return (
    <div className="flex h-[60vh] min-h-0 flex-col rounded-panel border border-edge bg-film lg:h-[calc(100vh-6.5rem)] lg:sticky lg:top-[5.25rem]">
      <div role="tablist" className="flex gap-1 border-b border-edge px-2 pt-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 pb-2.5 pt-1 text-sm font-semibold transition ${
              tab === t.id
                ? "border-signal text-bone"
                : "border-transparent text-smoke hover:text-bone"
            }`}
          >
            {t.label}
            {t.count !== undefined && (
              <span className="rounded-full bg-bone/8 px-1.5 text-[11px] tabular-nums text-smoke">
                {t.count}
              </span>
            )}
            {t.id === "queue" && pending > 0 && (
              <span
                title={`${pending} waiting for approval`}
                className="rounded-full bg-tungsten/15 px-1.5 text-[11px] font-semibold tabular-nums text-tungsten"
              >
                <span className="sr-only">, waiting for approval: </span>
                {pending}
              </span>
            )}
            {t.id === "people" && locked && (
              <Icon name="lock" size={12} className="text-tungsten" />
            )}
          </button>
        ))}
        {selfIsAdmin && (
          <button
            onClick={onNewPoll}
            disabled={!!poll}
            title={poll ? "A poll is already running" : "Ask the room something"}
            aria-label="New poll"
            className="mb-1.5 ml-auto flex shrink-0 items-center whitespace-nowrap gap-1.5 self-center rounded-full border border-edge bg-bone/5 px-2.5 py-1 text-xs font-semibold text-smoke transition hover:bg-bone/10 hover:text-bone active:scale-95 disabled:pointer-events-none disabled:opacity-40"
          >
            <svg
              width={12}
              height={12}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M5 20V12M12 20V5M19 20v-5" />
            </svg>
            Poll
          </button>
        )}
      </div>
      {tab === "chat" && (
        <Chat
          messages={messages}
          pinned={pinned}
          selfBrowser={selfBrowser}
          canChat={perms.chat}
          isAdmin={selfIsAdmin}
          getVideoTime={getVideoTime}
          onSeek={onSeek}
          onToast={onToast}
          header={
            <PollCard
              poll={poll}
              lastClosed={lastClosed}
              selfBrowser={selfBrowser}
              isAdmin={selfIsAdmin}
              serverNow={serverNow}
              onToast={onToast}
            />
          }
        />
      )}
      {tab === "queue" && (
        <QueuePanel
          queue={queue}
          media={media}
          settings={settings}
          selfBrowser={selfBrowser}
          canControl={perms.video}
          canSuggest={perms.chat}
          isAdmin={selfIsAdmin}
          canRunRoom={canRunRoom}
          onToast={onToast}
          onStartPoll={poll ? undefined : onNewPoll}
        />
      )}
      {tab === "people" && (
        <PeoplePanel
          users={users}
          selfId={selfId}
          selfBrowser={selfBrowser}
          hostId={hostId}
          settings={settings}
          selfIsAdmin={selfIsAdmin}
        />
      )}
    </div>
  );
}

const CLOSED_COPY: Record<
  DeniedReason,
  { title: string; body: string; hostBody?: string }
> = {
  removed: {
    title: "You were removed from this room",
    body: "The host took you out of this watch party, so this link won't let you back in.",
  },
  locked: {
    title: "This room is locked",
    body: "The host isn't letting new people in right now. Ask them to unlock it, then try the link again.",
  },
  ended: {
    title: "This room has ended",
    body: "The host closed the room for everyone. Start your own or find another in the lobby.",
    hostBody: "You ended the room — everyone has been sent out.",
  },
  full: {
    title: "This room is full",
    body: "It has hit its limit of people. Try again later or start your own.",
  },
  invalid: {
    title: "That room link isn't valid",
    body: "Check the code and try again, or start a new room.",
  },
  // Normally handled by the password form; here for completeness.
  password: {
    title: "This room is protected",
    body: "It needs a password to join. Ask the host for it, then try the link again.",
  },
  // Only the Android app's share link gets this; a browser never should.
  missing: {
    title: "You're not in this room",
    body: "Join the room first, then start sharing from it.",
  },
};

function RoomClosed({
  reason,
  wasHost,
}: {
  reason: DeniedReason;
  wasHost: boolean;
}) {
  const copy = CLOSED_COPY[reason];
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-edge">
        <div className="mx-auto flex max-w-7xl items-center px-4 py-3">
          <Logo size="sm" />
        </div>
      </header>
      <main className="grid flex-1 place-items-center px-4">
        <div className="max-w-md text-center">
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-full border border-edge bg-film text-dim">
            <Icon name={reason === "locked" ? "lock" : "door"} size={26} />
          </div>
          <h1 className="mt-6 font-display text-2xl font-bold">{copy.title}</h1>
          <p className="mt-3 text-sm text-smoke">
            {wasHost && copy.hostBody ? copy.hostBody : copy.body}
          </p>
          <div className="mt-8 flex justify-center gap-3">
            <Link
              href="/lobby"
              className="rounded-card bg-signal px-5 py-3 text-sm font-semibold transition hover:bg-signal-hot active:scale-95"
            >
              Go to the lobby
            </Link>
            <Link
              href="/"
              className="rounded-card border border-edge bg-bone/5 px-5 py-3 text-sm font-medium transition hover:bg-bone/10"
            >
              Home
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}

function PasswordGate({
  code,
  wrong,
  limited,
  checking,
  connected,
  onSubmit,
}: {
  code: string;
  wrong: boolean;
  limited: boolean;
  checking: boolean;
  connected: boolean;
  onSubmit: (password: string) => void;
}) {
  const [value, setValue] = useState("");
  const busy = checking;
  const error = limited
    ? "Too many attempts — wait a minute and try again"
    : wrong
      ? "Wrong password"
      : null;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col overflow-y-auto bg-ink">
      <header className="border-b border-edge">
        <div className="mx-auto flex max-w-7xl items-center px-4 py-3">
          <Logo size="sm" />
        </div>
      </header>
      <main className="grid flex-1 place-items-center px-4">
        <form
          className="w-full max-w-sm text-center"
          onSubmit={(e) => {
            e.preventDefault();
            if (!value || busy) return;
            onSubmit(value);
          }}
        >
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-full border border-edge bg-film text-dim">
            <Icon name="lock" size={26} />
          </div>
          <p className="mt-6 font-mono text-sm tracking-wider text-smoke">{code}</p>
          <h1 className="mt-1 font-display text-2xl font-bold">
            This room is protected
          </h1>
          <p className="mt-3 text-sm text-smoke">
            Enter the password the host shared with you.
          </p>
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            autoComplete="current-password"
            maxLength={64}
            aria-label="Room password"
            aria-invalid={wrong && !limited}
            aria-describedby={error ? "room-password-error" : undefined}
            placeholder="Password"
            className={`mt-6 w-full rounded-card border bg-ink px-4 py-3 text-sm outline-none transition focus:border-signal/60 ${
              error ? "border-signal/60" : "border-edge"
            }`}
          />
          {error && (
            <p
              id="room-password-error"
              role="alert"
              className="mt-2 text-left text-xs text-signal-hot"
            >
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={!value || busy}
            className="mt-4 w-full rounded-card bg-signal px-5 py-3 text-sm font-semibold transition hover:bg-signal-hot active:scale-95 disabled:pointer-events-none disabled:opacity-40"
          >
            {busy ? (connected ? "Joining…" : "Reconnecting…") : "Join"}
          </button>
          <Link
            href="/lobby"
            className="mt-4 inline-block text-sm text-smoke transition hover:text-bone"
          >
            Back to the lobby
          </Link>
        </form>
      </main>
    </div>
  );
}
