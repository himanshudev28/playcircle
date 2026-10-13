"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Logo } from "@/components/Logo";
import { Icon } from "@/components/Icon";
import {
  getClientId,
  getSocket,
  type ChatMessage,
  type DeniedReason,
  type PlayerAction,
  type RoomUser,
} from "@/lib/socket";
import { parseYouTubeId } from "@/lib/youtube";
import { useCall } from "./useCall";
import { Avatar, CallPanel } from "./CallPanel";
import { PeoplePanel } from "./PeoplePanel";

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

// Leaving is deferred a tick so React's dev-mode double mount (unmount +
// immediate remount) doesn't bounce you out of the room and back in.
let leaveTimer: ReturnType<typeof setTimeout> | undefined;

export function RoomClient({ code }: { code: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [name, setName] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [users, setUsers] = useState<RoomUser[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [selfBrowser, setSelfBrowser] = useState<string | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [denied, setDenied] = useState<{
    reason: DeniedReason;
    wasHost: boolean;
  } | null>(null);
  const deniedRef = useRef(false);
  const hostIdRef = useRef<string | null>(null);

  const playerRef = useRef<YT.Player | null>(null);
  const playerReadyRef = useRef(false);
  const applyingRemote = useRef(false);
  const pendingAction = useRef<PlayerAction | null>(null);
  const lastTimeRef = useRef(0);
  // Once the user has clicked into the page, browsers allow programmatic
  // playback — so the autoplay gate should never reappear after that.
  const hasInteractedRef = useRef(false);
  const recoveredRef = useRef(false);

  // Resolve display name (or bounce to /join).
  useEffect(() => {
    const saved =
      typeof window !== "undefined" ? localStorage.getItem("wnp-name") : null;
    if (!saved) {
      router.replace(`/join?next=${encodeURIComponent(code)}`);
      return;
    }
    setName(saved);
  }, [code, router]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  }, []);

  const call = useCall(showToast);

  // ---- Apply an incoming remote action to the local player ----
  const applyRemote = useCallback((a: PlayerAction) => {
    const p = playerRef.current;
    if (!p || !playerReadyRef.current) {
      pendingAction.current = a;
      return;
    }
    applyingRemote.current = true;
    try {
      if (a.videoId && a.type === "load") {
        // No startSeconds: VOD starts at 0, live streams start at the live edge
        // (seeking a live stream to 0 throws "recording not available").
        p.loadVideoById(a.videoId);
      } else {
        if (typeof a.time === "number") {
          // Never seek a live/manifestless stream to an absolute timestamp —
          // it lands outside the DVR window ("recording not available"). Live
          // viewers are already synced at the live edge. YouTube reports an
          // absurd duration (~1e8s) for these, so treat anything longer than a
          // sane video (24h) as non-seekable. Only catch up real VODs.
          let dur = 0;
          try {
            dur = p.getDuration();
          } catch {
            /* noop */
          }
          const isSeekable = dur > 0 && dur < 86400; // ≤ 24h ⇒ a real VOD
          const drift = Math.abs(p.getCurrentTime() - a.time);
          if (isSeekable && a.time < dur && drift > 0.6) {
            p.seekTo(a.time, true);
          }
        }
        if (a.type === "play" || a.isPlaying) {
          p.playVideo();
          // Browsers block programmatic autoplay without a user gesture. If the
          // video hasn't actually started shortly after, surface a tap-to-start gate.
          setTimeout(() => {
            if (hasInteractedRef.current) return;
            try {
              if (p.getPlayerState() !== window.YT!.PlayerState.PLAYING) {
                setNeedsGesture(true);
              }
            } catch {
              /* noop */
            }
          }, 1200);
        }
        if (a.type === "pause") p.pauseVideo();
      }
    } catch {
      /* player not fully ready */
    }
    setTimeout(() => (applyingRemote.current = false), 800);
  }, []);

  // User gesture to unblock playback for a late joiner, then snap to the room.
  function startPlayback() {
    hasInteractedRef.current = true;
    setNeedsGesture(false);
    const p = playerRef.current;
    try {
      p?.playVideo();
    } catch {
      /* noop */
    }
    getSocket().emit("player:request-sync");
  }

  // ---- Socket wiring ----
  useEffect(() => {
    if (!name) return;
    const socket = getSocket();
    clearTimeout(leaveTimer);

    const onConnect = () => {
      setConnected(true);
      setSelfId(socket.id ?? null);
      // Removed / ended: don't let a reconnect quietly walk back in.
      if (deniedRef.current) return;
      socket.emit("room:join", {
        code,
        name,
        clientId: getClientId(),
        title: searchParams.get("title") || undefined,
        isPublic: searchParams.get("public") === "1",
      });
    };
    const onState = (s: {
      videoId: string | null;
      isPlaying: boolean;
      time: number;
      hostId: string | null;
      locked: boolean;
      selfBrowser: string;
      users: RoomUser[];
      messages: ChatMessage[];
    }) => {
      setUsers(s.users);
      setSelfBrowser(s.selfBrowser);
      setHostId(s.hostId);
      hostIdRef.current = s.hostId;
      setLocked(!!s.locked);
      setMessages(s.messages || []);
      if (s.videoId) {
        setVideoId(s.videoId);
        pendingAction.current = {
          type: s.isPlaying ? "play" : "pause",
          time: s.time,
          videoId: s.videoId,
          isPlaying: s.isPlaying,
        };
      }
    };
    const onUsers = (u: RoomUser[]) => setUsers(u);
    const onChat = (m: ChatMessage) =>
      setMessages((prev) => [...prev.slice(-199), m]);
    const onAction = (a: PlayerAction) => {
      if (a.videoId && a.videoId !== videoId) setVideoId(a.videoId);
      if (a.by) showToast(`${a.by} ${labelFor(a.type)}`);
      applyRemote(a);
    };

    const onHost = (id: string | null) => {
      setHostId(id);
      hostIdRef.current = id;
      if (id && id === socket.id) showToast("You're the host now");
    };
    const onLocked = (l: boolean) => setLocked(l);
    const onDenied = ({ reason }: { reason: DeniedReason }) => {
      deniedRef.current = true;
      call.teardown();
      try {
        playerRef.current?.destroy();
      } catch {
        /* noop */
      }
      playerRef.current = null;
      playerReadyRef.current = false;
      setDenied({ reason, wasHost: hostIdRef.current === socket.id });
    };
    const onDisconnect = () => setConnected(false);

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("room:state", onState);
    socket.on("room:users", onUsers);
    socket.on("room:host", onHost);
    socket.on("room:locked", onLocked);
    socket.on("room:denied", onDenied);
    socket.on("chat:message", onChat);
    socket.on("player:action", onAction);

    if (socket.connected) onConnect();

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("room:state", onState);
      socket.off("room:users", onUsers);
      socket.off("room:host", onHost);
      socket.off("room:locked", onLocked);
      socket.off("room:denied", onDenied);
      socket.off("chat:message", onChat);
      socket.off("player:action", onAction);
      // Client-side navigation away from the room: free our seat right away
      // instead of waiting for the socket to drop.
      if (!deniedRef.current) {
        leaveTimer = setTimeout(() => socket.emit("room:leave", { code }), 150);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, code]);

  // ---- Build / rebuild the YouTube player when a video is set ----
  useEffect(() => {
    if (!videoId) return;
    let cancelled = false;

    loadYouTubeApi().then(() => {
      if (cancelled) return;

      const emit = (type: PlayerAction["type"], time: number) => {
        if (applyingRemote.current) return;
        getSocket().emit("player:action", { type, time, videoId });
      };

      if (playerRef.current) {
        applyingRemote.current = true;
        playerRef.current.loadVideoById(videoId);
        setTimeout(() => (applyingRemote.current = false), 800);
        return;
      }

      playerRef.current = new window.YT!.Player("yt-player", {
        videoId,
        playerVars: {
          autoplay: 0,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
        },
        events: {
          onReady: () => {
            playerReadyRef.current = true;
            if (pendingAction.current) {
              applyRemote(pendingAction.current);
              pendingAction.current = null;
            }
          },
          onError: (e) => {
            // A live stream seeked outside its DVR window throws
            // "recording not available". Recover once by reloading at the
            // live edge (no seek). Guard against reload loops.
            if (recoveredRef.current) return;
            recoveredRef.current = true;
            applyingRemote.current = true;
            try {
              e.target.loadVideoById(videoId);
            } catch {
              /* noop */
            }
            setTimeout(() => (applyingRemote.current = false), 1000);
          },
          onStateChange: (e) => {
            const p = e.target;
            const t = p.getCurrentTime();
            // Detect a scrub: large jump from last sampled time.
            if (
              !applyingRemote.current &&
              Math.abs(t - lastTimeRef.current) > 1.6
            ) {
              emit("seek", t);
            }
            lastTimeRef.current = t;
            if (e.data === window.YT!.PlayerState.PLAYING) emit("play", t);
            if (e.data === window.YT!.PlayerState.PAUSED) emit("pause", t);
          },
        },
      });
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  // Sample current time so seek detection has a reference point.
  useEffect(() => {
    const id = setInterval(() => {
      const p = playerRef.current;
      if (p && playerReadyRef.current) {
        try {
          lastTimeRef.current = p.getCurrentTime();
        } catch {
          /* noop */
        }
      }
    }, 900);
    return () => clearInterval(id);
  }, []);

  function loadVideo() {
    const id = parseYouTubeId(urlInput);
    if (!id) {
      showToast("That doesn't look like a YouTube link");
      return;
    }
    setUrlInput("");
    setVideoId(id);
    getSocket().emit("player:action", { type: "load", videoId: id, time: 0 });
  }

  function resync() {
    getSocket().emit("player:request-sync");
    showToast("Re-syncing to the room…");
  }

  function copyLink() {
    navigator.clipboard?.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  if (!name) return null;
  if (denied) return <RoomClosed {...denied} />;

  return (
    <div className="flex min-h-screen flex-col">
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
        <div className="flex flex-col gap-4">
          <div className="relative aspect-video w-full overflow-hidden rounded-panel border border-edge bg-ink">
            {videoId ? (
              <div id="yt-player" className="h-full w-full" />
            ) : (
              <EmptyStage />
            )}
            {videoId && needsGesture && (
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
          </div>

          <div className="flex flex-col gap-2 rounded-panel border border-edge bg-film p-3 sm:flex-row">
            <input
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadVideo()}
              placeholder="Paste a YouTube link to play for everyone…"
              className="w-full rounded-card border border-edge bg-ink px-4 py-3 text-sm outline-none transition focus:border-signal/60"
            />
            <div className="flex gap-2">
              <button
                onClick={loadVideo}
                className="flex-1 whitespace-nowrap rounded-card bg-signal px-5 py-3 text-sm font-semibold transition hover:bg-signal-hot active:scale-95 sm:flex-none"
              >
                Play for all
              </button>
              <button
                onClick={resync}
                title="Snap to the room's current position"
                className="rounded-card border border-edge bg-bone/5 px-4 py-3 text-sm font-medium transition hover:bg-bone/10"
              >
                Resync
              </button>
            </div>
          </div>

          <CallPanel call={call} users={users} selfId={selfId} />
        </div>

        <SidePanel
          users={users}
          selfId={selfId}
          selfBrowser={selfBrowser}
          hostId={hostId}
          locked={locked}
          messages={messages}
        />
      </div>

      {toast && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full border border-edge bg-film-2/95 px-5 py-2.5 text-sm shadow-xl backdrop-blur">
          {toast}
        </div>
      )}
    </div>
  );
}

function labelFor(type: PlayerAction["type"]) {
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

function EmptyStage() {
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
          Paste a YouTube link below and it starts for everyone in the room.
        </p>
      </div>
    </div>
  );
}

type SideTab = "chat" | "people";

function SidePanel({
  users,
  selfId,
  selfBrowser,
  hostId,
  locked,
  messages,
}: {
  users: RoomUser[];
  selfId: string | null;
  selfBrowser: string | null;
  hostId: string | null;
  locked: boolean;
  messages: ChatMessage[];
}) {
  const [tab, setTab] = useState<SideTab>("chat");
  const isHost = !!selfId && selfId === hostId;
  const tabs: { id: SideTab; label: string; count?: number }[] = [
    { id: "chat", label: "Chat" },
    { id: "people", label: isHost ? "People · Manage" : "People", count: users.length },
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
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 pb-2.5 pt-1 text-sm font-semibold transition ${
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
            {t.id === "people" && locked && (
              <Icon name="lock" size={12} className="text-tungsten" />
            )}
          </button>
        ))}
      </div>
      {tab === "chat" ? (
        <Chat
          messages={messages}
          onSend={(t) => getSocket().emit("chat:message", { text: t })}
        />
      ) : (
        <PeoplePanel
          users={users}
          selfId={selfId}
          selfBrowser={selfBrowser}
          hostId={hostId}
          locked={locked}
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

function Chat({
  messages,
  onSend,
}: {
  messages: ChatMessage[];
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function send() {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <p className="mt-6 text-center text-sm text-faint">
            No messages yet. Whatever you type shows up for everyone instantly.
          </p>
        )}
        {messages.map((m) =>
          m.system ? (
            <p
              key={m.id}
              className="text-center text-xs italic text-faint"
            >
              {m.text}
            </p>
          ) : (
            <div key={m.id} className="flex items-start gap-2.5">
              <span
                className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold text-black"
                style={{ background: m.color }}
              >
                {m.name?.[0]?.toUpperCase()}
              </span>
              <div className="min-w-0">
                <span
                  className="text-xs font-semibold"
                  style={{ color: m.color }}
                >
                  {m.name}
                </span>
                <p className="break-words text-sm text-bone/90">{m.text}</p>
              </div>
            </div>
          )
        )}
        <div ref={endRef} />
      </div>
      <div className="flex gap-2 border-t border-edge p-3">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Message the room…"
          maxLength={500}
          className="w-full rounded-card border border-edge bg-ink px-4 py-2.5 text-sm outline-none transition focus:border-signal/60"
        />
        <button
          onClick={send}
          className="rounded-card bg-signal px-4 py-2.5 text-sm font-semibold transition hover:bg-signal-hot active:scale-95"
        >
          Send
        </button>
      </div>
    </div>
  );
}
