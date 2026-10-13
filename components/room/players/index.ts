"use client";

import type { VideoMedia } from "@/lib/socket";
import type { PlayerOptions, StagePlayer } from "./types";
import { createYoutubePlayer, type LoadOptions } from "./youtube";
import { createHtml5Player } from "./html5";
import { createVimeoPlayer } from "./vimeo";
import { createDailymotionPlayer } from "./dailymotion";
import { createTwitchPlayer } from "./twitch";

export type { PlayerState, StagePlayer } from "./types";

/** Build the right player for any video. `mount` is an empty element the
    adapter fills. */
export function createPlayer(
  mount: HTMLElement,
  media: VideoMedia,
  opts: PlayerOptions
): StagePlayer {
  switch (media.kind) {
    case "youtube":
      return createYoutubePlayer(mount, media, opts);
    case "file":
    case "hls":
      return createHtml5Player(mount, media, opts);
    case "vimeo":
      return createVimeoPlayer(mount, media, opts);
    case "dailymotion":
      return createDailymotionPlayer(mount, media, opts);
    case "twitch":
      return createTwitchPlayer(mount, media, opts);
  }
}

/** Load `media` into an existing player when its adapter can swap videos in
    place (YouTube → YouTube). False: destroy it and create a fresh one. */
export function reusePlayer(
  player: StagePlayer,
  media: VideoMedia,
  opts: LoadOptions
): boolean {
  const load = (player as StagePlayer & {
    load?: (m: VideoMedia, o: LoadOptions) => boolean;
  }).load;
  if (typeof load !== "function") return false;
  try {
    return load.call(player, media, opts);
  } catch {
    return false;
  }
}
