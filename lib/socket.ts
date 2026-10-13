"use client";

import { io, type Socket } from "socket.io-client";

let socket: Socket | null = null;

/* Where the realtime server lives. Empty: this same origin (server.js runs
   pages and Socket.IO together). Set NEXT_PUBLIC_SOCKET_URL when the pages
   are hosted somewhere that can't hold WebSockets (e.g. Vercel) and the
   server runs elsewhere (e.g. Render). /api/ice is read from there too. */
export const REALTIME_URL = (process.env.NEXT_PUBLIC_SOCKET_URL ?? "").replace(/\/+$/, "");

export function getSocket(): Socket {
  if (!socket) {
    const opts = { autoConnect: true, transports: ["websocket", "polling"] };
    socket = REALTIME_URL ? io(REALTIME_URL, opts) : io(opts);
  }
  return socket;
}

export type CallState = { mic: boolean; cam: boolean };

/** What this person is currently allowed to do (already resolved by the server). */
export type Perms = { video: boolean; chat: boolean; call: boolean };

export type PlaybackMode = "host" | "everyone";

export type RoomSettings = {
  locked: boolean;
  playback: PlaybackMode;
  /** Suggestions from people without video control wait for the host. */
  approval: boolean;
  /** Up-next order: most votes first, or arranged by hand. */
  order: "votes" | "manual";
  /** Start the next ready video when one ends. */
  autoplay: boolean;
  /** Viewers may call binding skip / replay votes. */
  voteSkip: boolean;
  /** Joining needs a password (people already admitted skip it). */
  hasPassword: boolean;
};

/** Fields every playable video can carry (filled in by the server). */
type VideoInfo = {
  title?: string | null;
  author?: string | null;
  thumb?: string;
  /** Seconds, when the source told us. */
  duration?: number;
  /** The page the link came from, for "open original". */
  source?: string;
};

export type YoutubeMedia = VideoInfo & { kind: "youtube"; id: string };
/** A direct video file (.mp4 / .webm / .mov / .ogv …), played by <video>. */
export type FileMedia = VideoInfo & { kind: "file"; url: string; mime?: string };
/** An HLS stream (.m3u8), played by <video> + hls.js (native on Safari). */
export type HlsMedia = VideoInfo & { kind: "hls"; url: string };
export type VimeoMedia = VideoInfo & { kind: "vimeo"; id: string; hash?: string };
export type DailymotionMedia = VideoInfo & { kind: "dailymotion"; id: string };
/** A past broadcast ("video") or a live channel ("channel"). */
export type TwitchMedia = VideoInfo & {
  kind: "twitch";
  type: "video" | "channel";
  id: string;
};

/** Anything with a shared timeline the room can sync. */
export type VideoMedia =
  | YoutubeMedia
  | FileMedia
  | HlsMedia
  | VimeoMedia
  | DailymotionMedia
  | TwitchMedia;

export type ShareSource = "tab" | "screen" | "file" | "camera";

/** Someone's tab, screen or local file, streamed live over WebRTC. */
export type LiveMedia = {
  kind: "live";
  source: ShareSource;
  /** Fresh per share; every stage:* signal carries it. */
  streamId: string;
  /** Socket id of the presenter. */
  presenter: string;
  title: string;
  /** Presenter's display name. */
  by: string;
};

/** What's on the stage. */
export type Media = VideoMedia | LiveMedia;

/** Stable identity of a piece of media; play/pause/seek/ended carry it.
    Must match server/media.js key(). */
export function mediaKey(m: Media | null | undefined): string | null {
  if (!m) return null;
  switch (m.kind) {
    case "youtube":
      return `yt:${m.id}`;
    case "file":
    case "hls":
      return `${m.kind}:${m.url}`;
    case "vimeo":
      return `vimeo:${m.id}`;
    case "dailymotion":
      return `dm:${m.id}`;
    case "twitch":
      return `twitch:${m.type}:${m.id}`;
    case "live":
      return `live:${m.streamId}`;
  }
}

/** Everything except a live share has a shared timeline (sync, moments,
    queue, history). Some may still be live streams (YouTube live, Twitch
    channels) — the player detects that and never seeks them. */
export function isTimed(m: Media | null | undefined): m is VideoMedia {
  return !!m && m.kind !== "live";
}

/** A thumbnail for any video, or null. */
export function mediaThumb(m: VideoMedia): string | null {
  if (m.thumb) return m.thumb;
  if (m.kind === "youtube") return `https://i.ytimg.com/vi/${m.id}/mqdefault.jpg`;
  return null;
}

/** Human label for where a video comes from. */
export const SOURCE_LABEL: Record<VideoMedia["kind"], string> = {
  youtube: "YouTube",
  file: "Video file",
  hls: "Stream",
  vimeo: "Vimeo",
  dailymotion: "Dailymotion",
  twitch: "Twitch",
};

export type QueueItem = {
  id: string;
  media: VideoMedia;
  by: { name: string; color: string };
  /** Browser tag of whoever suggested it (compare with your selfBrowser). */
  browser: string;
  votes: number;
  /** Browser tags of everyone who voted for it. */
  voters: string[];
  /** "pending" waits for the host to approve. */
  status: "ready" | "pending";
  /** Won a binding "what's next" poll: plays next regardless of votes. */
  next: boolean;
  addedAt: number;
};

export type QueueState = {
  items: QueueItem[];
  /** Recently played, newest first. */
  history: { media: VideoMedia; playedAt: number }[];
};

/** Reply to queue:add / queue:skip. */
export type QueueReply = {
  ok: boolean;
  error?: string;
  status?: QueueItem["status"];
  duplicate?: boolean;
};

export type RoomUser = {
  id: string;
  name: string;
  color: string;
  /** Opaque per-browser tag: equal for two tabs of the same browser. */
  browser: string;
  /** The room's creator — permanent first right and admin power. */
  owner: boolean;
  perms: Perms;
  /** Present when this person is in the room's voice/video call. */
  call: CallState | null;
};

export type DeniedReason =
  | "removed"
  | "locked"
  | "ended"
  | "full"
  | "invalid"
  /** Needs a password: re-send room:join with `password`. `wrong` when one
      was sent and didn't match. */
  | "password"
  /** A companion (the Android app's share link) whose person isn't in the room. */
  | "missing";

/* A random id per browser, kept in localStorage. Socket ids change on every
   reconnect; this is what lets a host refresh without losing the crown, and
   what a removal is keyed on. */
let pageClientId: string | null = null;

export function getClientId(): string {
  const KEY = "wnp-cid";
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return saved;
  } catch {
    /* storage blocked — fall through to a per-page id */
  }
  // Generated once per page load, so even without storage two browsers never
  // share an id (a shared id would mean shared host rights and shared bans).
  if (!pageClientId) {
    pageClientId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  try {
    localStorage.setItem(KEY, pageClientId);
  } catch {
    /* fine — this page keeps using pageClientId */
  }
  return pageClientId;
}

/** Reactions on a chat message (server enforces this list). */
export const CHAT_REACTIONS = ["👍", "😂", "❤️", "🔥", "😮", "😢"] as const;
/** Floating reactions over the video (server enforces this list). */
export const LIVE_REACTIONS = ["😂", "❤️", "🔥", "😮", "👏", "😭", "💀", "🎉"] as const;

export type ChatMessage = {
  id: string;
  name?: string;
  color?: string;
  /** Sender's browser tag (absent on system lines) — for block / "you". */
  browser?: string;
  text: string;
  ts: number;
  system?: boolean;
  /** Host announcement: styled prominently. */
  announce?: boolean;
  replyTo?: { id: string; name?: string; text: string };
  /** emoji → browser tags of who reacted. */
  reactions?: Record<string, string[]>;
};

/** A floating reaction; `t` is the video time it landed on (null when
    nothing timed is playing). */
export type LiveReaction = {
  emoji: string;
  name: string;
  color: string;
  byId: string;
  t: number | null;
};

/** One reaction on the current video's timeline. */
export type Moment = { t: number; e: string };

export type PollKind = "custom" | "next" | "skip" | "replay";

export type Poll = {
  id: string;
  kind: PollKind;
  question: string;
  /** For "next" polls `ref` is the QueueItem id. */
  options: { label: string; ref?: string; count: number }[];
  total: number;
  /** Browser tags of who voted (never what they picked). */
  voters: string[];
  /** Server clock ms. */
  endsAt: number;
  /** A binding result is acted on (skip / replay / play next). */
  binding: boolean;
  by: { name: string; color: string };
  /** skip / replay: yes-votes needed to pass early (majority). */
  needed: number | null;
};

export type PollClosed = {
  poll: Poll;
  winner: number | null;
  /** skip / replay only. */
  passed: boolean;
  cancelled: boolean;
};

/** Ack for poll:create, chat:report, stage:start. */
export type Reply = { ok: boolean; error?: string };

export type StageQuality = "auto" | "1080" | "720" | "480";

/** Server → client. Client → server sends { type, time, key } for
    play/pause/seek and { type: "load", media } to change the video. */
export type PlayerAction = {
  type: "load" | "play" | "pause" | "seek";
  time?: number;
  media?: Media | null;
  isPlaying?: boolean;
  /** Server clock (ms) when `time` was true. */
  at?: number;
  by?: string;
  /** Socket id of whoever did it. */
  byId?: string;
  /** Server refused this viewer's action and is snapping them back. */
  denied?: boolean;
};

/** Every ~3s: the authoritative playhead, for drift correction. */
export type PlayerTick = {
  key: string;
  time: number;
  isPlaying: boolean;
  /** Server clock (ms) when `time` was true. */
  at: number;
};

/** Full snapshot sent on room:join. */
export type RoomSnapshot = {
  media: Media | null;
  isPlaying: boolean;
  time: number;
  duration: number | null;
  at: number;
  hostId: string | null;
  settings: RoomSettings;
  users: RoomUser[];
  messages: ChatMessage[];
  queue: QueueState;
  pinned: ChatMessage | null;
  moments: Moment[];
  poll: Poll | null;
  selfBrowser: string;
};

export type LobbyRoom = {
  code: string;
  title: string;
  videoId: string | null;
  nowPlaying: string | null;
  isPlaying: boolean;
  count: number;
  hosts: { name: string; color: string }[];
};

export type Vent = {
  id: string;
  alias: string;
  emoji: string;
  text: string;
  ts: number;
};
