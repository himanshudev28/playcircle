// Minimal ambient types for the YouTube IFrame Player API.
export {};

declare global {
  interface Window {
    YT?: typeof YT;
    onYouTubeIframeAPIReady?: () => void;
  }

  namespace YT {
    const PlayerState: {
      UNSTARTED: -1;
      ENDED: 0;
      PLAYING: 1;
      PAUSED: 2;
      BUFFERING: 3;
      CUED: 5;
    };

    class Player {
      constructor(el: HTMLElement | string, options: PlayerOptions);
      playVideo(): void;
      pauseVideo(): void;
      seekTo(seconds: number, allowSeekAhead: boolean): void;
      loadVideoById(id: string, startSeconds?: number): void;
      cueVideoById(id: string, startSeconds?: number): void;
      getCurrentTime(): number;
      getPlayerState(): number;
      getDuration(): number;
      destroy(): void;
    }

    interface PlayerOptions {
      videoId?: string;
      width?: string | number;
      height?: string | number;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (e: { target: Player }) => void;
        onStateChange?: (e: { target: Player; data: number }) => void;
        onError?: (e: { target: Player; data: number }) => void;
      };
    }
  }
}
