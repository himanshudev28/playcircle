/* Single source of truth for anything that has to agree across
   <head>, JSON-LD, the sitemap, robots.txt, and the OG image. When these
   drift apart search engines quietly pick one and ignore the rest. */

export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://playcircle.app"
).replace(/\/$/, "");

export const SITE_NAME = "PlayCircle";

export const SITE_TAGLINE = "Watch YouTube Together, Perfectly in Sync";

export const SITE_DESCRIPTION =
  "PlayCircle is a free watch party app. Create a private room, paste a YouTube link, and everyone sees the same frame at the same time — synced playback, live chat, and instant invites, right in the browser.";

/* Short form for cards, where anything past ~160 characters is truncated. */
export const SITE_DESCRIPTION_SHORT =
  "Create a private room, paste a YouTube link, and watch together in perfect sync — with live chat and instant invites. Free, no downloads.";

export const SITE_KEYWORDS = [
  "PlayCircle",
  "watch party app",
  "youtube watch party",
  "watch videos together online",
  "sync youtube with friends",
  "long distance date night",
  "online watch room",
  "free watch party app",
  "virtual movie night",
];
