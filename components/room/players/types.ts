import type { VideoMedia } from "@/lib/socket";

/* One interface over every embeddable player (YouTube, <video> for files and
   HLS, Vimeo, Dailymotion, Twitch), so the sync engine in useSyncedPlayer
   never cares which site a video came from.

   Contract for adapters:
   - Never throw from a method: swallow and return a neutral value.
   - Times are seconds. getDuration() is 0 while unknown.
   - Emit onState for every state change, including ones we caused; the sync
     engine filters its own echoes.
   - isLive() is true for live streams (YouTube live, Twitch channels, HLS
     without an end), which the engine never seeks. */

export type PlayerState =
  | "unstarted"
  | "playing"
  | "paused"
  | "buffering"
  | "ended";

export type PlayerEvents = {
  onReady: () => void;
  onState: (state: PlayerState) => void;
  /** Fatal for this video (blocked embed, not found, unsupported…).
      `message` is human-readable and safe to toast. */
  onError: (message: string) => void;
};

export type PlayerOptions = {
  /** Start position (seconds) for a fresh load; ignored for live. */
  start?: number;
  /** Try to start playing as soon as it's ready. */
  autoplay: boolean;
  events: PlayerEvents;
};

export interface StagePlayer {
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  getTime(): number;
  getDuration(): number;
  getState(): PlayerState;
  isLive(): boolean;
  getRate(): number;
  destroy(): void;
}

/** Each adapter module exports one of these. `mount` is an empty element the
    adapter fills (iframe / video); it must size its content to 100%. */
export type CreatePlayer<M extends VideoMedia = VideoMedia> = (
  mount: HTMLElement,
  media: M,
  opts: PlayerOptions
) => StagePlayer;
