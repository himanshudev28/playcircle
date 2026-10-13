import { Icon } from "@/components/Icon";
import { SOURCE_LABEL, mediaThumb, type VideoMedia } from "@/lib/socket";

/* How a video of any kind is named, linked and pictured in the room UI. */

/** The file name at the end of a URL ("Big_Buck_Bunny.mp4"), or null. */
function fileNameOf(url: string): string | null {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : null;
  } catch {
    return null;
  }
}

/** A title to show: the server's, else a file name for direct links, else
    `fallback`. */
export function mediaTitle(m: VideoMedia, fallback = "Untitled video"): string {
  if (m.title) return m.title;
  if (m.kind === "file" || m.kind === "hls") return fileNameOf(m.url) ?? fallback;
  return fallback;
}

/** Where the video lives outside the room, for "Open original". */
export function mediaUrl(m: VideoMedia): string {
  if (m.source) return m.source;
  switch (m.kind) {
    case "youtube":
      return `https://www.youtube.com/watch?v=${encodeURIComponent(m.id)}`;
    case "file":
    case "hls":
      return m.url;
    case "vimeo":
      return `https://vimeo.com/${encodeURIComponent(m.id)}${
        m.hash ? `/${encodeURIComponent(m.hash)}` : ""
      }`;
    case "dailymotion":
      return `https://www.dailymotion.com/video/${encodeURIComponent(m.id)}`;
    case "twitch":
      return m.type === "video"
        ? `https://www.twitch.tv/videos/${encodeURIComponent(m.id)}`
        : `https://www.twitch.tv/${encodeURIComponent(m.id)}`;
  }
}

/** A small tag naming where a video comes from. YouTube is the default and
    goes unlabelled unless `always`. */
export function SourceBadge({
  media,
  always = false,
  className = "",
}: {
  media: VideoMedia;
  always?: boolean;
  className?: string;
}) {
  if (media.kind === "youtube" && !always) return null;
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border border-edge bg-bone/5 px-1.5 py-px text-[10px] font-semibold leading-4 tracking-wide text-smoke ${className}`}
    >
      {SOURCE_LABEL[media.kind]}
    </span>
  );
}

/** A 16:9 thumbnail, or a quiet placeholder when the source gave none. */
export function MediaThumb({
  media,
  width,
  dim = false,
}: {
  media: VideoMedia;
  width: number;
  dim?: boolean;
}) {
  const src = mediaThumb(media);
  return (
    <span
      className="relative grid aspect-video shrink-0 place-items-center overflow-hidden rounded-lg bg-ink text-dim"
      style={{ width }}
    >
      {src ? (
        // Tiny, many, from any host — the optimizer adds nothing (and would
        // need every host allow-listed).
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className={`h-full w-full object-cover ${dim ? "opacity-70" : ""}`}
        />
      ) : (
        <Icon name="film" size={Math.max(14, Math.round(width / 5))} />
      )}
    </span>
  );
}
