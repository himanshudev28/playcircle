// What's on the stage, and how to describe it (shapes: lib/socket.ts).
//   youtube     — { kind, id }                synced through the IFrame API
//   file        — { kind, url, mime? }        a direct video file, <video>
//   hls         — { kind, url }               an .m3u8 stream, <video> + hls.js
//   vimeo       — { kind, id, hash? }         Vimeo player SDK
//   dailymotion — { kind, id }                Dailymotion player
//   twitch      — { kind, type: "video" | "channel", id }
//   … each may carry title, author, thumb, duration, source.
//   live        — { kind: "live", source, streamId, presenter, title, by },
//                 someone's tab, screen or local file streamed over WebRTC
// The server normalises everything a client proposes; clients never get to
// put arbitrary fields on the room. Pasted links are turned into media by
// server/resolve.js; live media is created by the server itself
// (server/stage.js) and can never come from a client.

const net = require("net");
const { isBlockedAddress } = require("./safeFetch");

const YT_ID = /^[a-zA-Z0-9_-]{11}$/;
const VIMEO_ID = /^\d{1,15}$/;
const VIMEO_HASH = /^[0-9a-f]{6,40}$/i;
const DM_ID = /^[a-zA-Z0-9]{5,20}$/;
const TWITCH_VIDEO = /^\d{1,15}$/;
const TWITCH_CHANNEL = /^[a-zA-Z0-9_]{3,25}$/;
const VIDEO_MIME = /^video\/[a-z0-9.+-]{1,40}$/;
const MAX_URL = 2000;

function youtubeId(input) {
  const s = String(input || "").trim();
  if (YT_ID.test(s)) return s;
  if (s.length > 2000) return null;
  let url;
  try {
    url = new URL(s.includes("://") ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  if (host === "youtu.be") {
    const id = url.pathname.slice(1, 12);
    return YT_ID.test(id) ? id : null;
  }
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const v = url.searchParams.get("v");
    if (v && YT_ID.test(v)) return v;
    const m = url.pathname.match(/\/(embed|shorts|v|live)\/([a-zA-Z0-9_-]{11})/);
    if (m) return m[2];
  }
  return null;
}

// A YouTube link or id someone pasted → stage media, or null. The sync fast
// path; anything else goes through server/resolve.js.
function parseInput(input) {
  const id = youtubeId(input);
  return id ? { kind: "youtube", id } : null;
}

// An absolute http(s) URL of sane length, normalised; else null.
function webUrl(v, max = MAX_URL) {
  if (typeof v !== "string" || !v || v.length > max) return null;
  let u;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  return u.href.length <= max ? u.href : null;
}

const isStr = (v) => typeof v === "string";

/* May every viewer's browser be sent to this URL's host? A file / HLS link
   is fetched by each person in the room, so it must not point at a private,
   loopback or link-local address (192.168.x, 127.0.0.1, 169.254.169.254 …),
   at localhost, or at a single-label intranet name. (Names are not looked
   up here; the server's own fetches are guarded by safeFetch.) */
function publicHost(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  const bare = host.replace(/^\[|\]$/g, "");
  if (net.isIP(bare)) return !isBlockedAddress(bare);
  if (!host || host === "localhost" || host.endsWith(".localhost")) return false;
  return host.includes(".");
}

const FILE_HOST_ERROR = "That link can't be opened";

/* Why media a client proposes for the stage or the queue (by identity)
   must be refused even though it's well-formed, or null. */
function refusal(m, { allowPrivate = false } = {}) {
  if (!m || typeof m !== "object") return null;
  if ((m.kind === "file" || m.kind === "hls") && webUrl(m.url) && !allowPrivate && !publicHost(m.url)) {
    return FILE_HOST_ERROR;
  }
  return null;
}

/* Media a client sent as an object → stage media with only the fields that
   identify it, or null. Every VideoMedia kind is checked strictly; "live"
   (or anything else) never gets through, nor does a file / HLS link on a
   private host (unless `allowPrivate`, for tests). Display info is not
   taken from clients (see infoFrom). */
function fromClient(m, { allowPrivate = false } = {}) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  switch (m.kind) {
    case "youtube":
      return isStr(m.id) && YT_ID.test(m.id) ? { kind: "youtube", id: m.id } : null;
    case "file": {
      const url = webUrl(m.url);
      if (!url || (!allowPrivate && !publicHost(url))) return null;
      const out = { kind: "file", url };
      if (isStr(m.mime) && VIDEO_MIME.test(m.mime.toLowerCase())) out.mime = m.mime.toLowerCase();
      return out;
    }
    case "hls": {
      const url = webUrl(m.url);
      return url && (allowPrivate || publicHost(url)) ? { kind: "hls", url } : null;
    }
    case "vimeo": {
      if (!isStr(m.id) || !VIMEO_ID.test(m.id)) return null;
      const out = { kind: "vimeo", id: m.id };
      if (m.hash !== undefined && m.hash !== null && m.hash !== "") {
        if (!isStr(m.hash) || !VIMEO_HASH.test(m.hash)) return null;
        out.hash = m.hash;
      }
      return out;
    }
    case "dailymotion":
      return isStr(m.id) && DM_ID.test(m.id) ? { kind: "dailymotion", id: m.id } : null;
    case "twitch": {
      if (!isStr(m.id)) return null;
      if (m.type === "video" && TWITCH_VIDEO.test(m.id)) {
        return { kind: "twitch", type: "video", id: m.id };
      }
      if (m.type === "channel" && TWITCH_CHANNEL.test(m.id)) {
        return { kind: "twitch", type: "channel", id: m.id.toLowerCase() };
      }
      return null;
    }
    default:
      return null;
  }
}

/* The display fields of a video (title, author, thumb, duration, source),
   each cleaned and capped; anything unusable is left out. For what the
   server itself found out (resolve.js, the snapshot on disk, a room's own
   queue / history) — never for what a client claims. */
function infoFrom(x) {
  const out = {};
  if (!x || typeof x !== "object") return out;
  const text = (v, max) => {
    if (!isStr(v)) return null;
    const t = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
    return t || null;
  };
  const title = text(x.title, 120);
  const author = text(x.author, 60);
  const thumb = webUrl(x.thumb, 500);
  const source = webUrl(x.source);
  const d = typeof x.duration === "number" ? x.duration : Number.NaN;
  if (title) out.title = title;
  if (author) out.author = author;
  if (thumb) out.thumb = thumb;
  if (Number.isFinite(d) && d >= 1 && d < 86_400) out.duration = d;
  if (source) out.source = source;
  return out;
}

// Stable identity; play/pause/seek/ended carry it. Must match lib/socket.ts
// mediaKey().
function key(media) {
  if (!media) return null;
  switch (media.kind) {
    case "youtube":
      return `yt:${media.id}`;
    case "file":
    case "hls":
      return `${media.kind}:${media.url}`;
    case "vimeo":
      return `vimeo:${media.id}`;
    case "dailymotion":
      return `dm:${media.id}`;
    case "twitch":
      return `twitch:${media.type}:${media.id}`;
    case "live":
      return `live:${media.streamId}`;
    default:
      return null;
  }
}

// Everything but a live share has a shared timeline (sync ticks, ended,
// moments, queue, history).
function isTimed(media) {
  return !!media && typeof media === "object" && media.kind !== "live" && key(media) !== null;
}

// A readable title from a file's URL: ".../big_buck_bunny.mp4" →
// "big_buck_bunny"; a generic HLS name ("index", "master") → the host.
function fileTitle(url) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
    const name = last.replace(/\.[a-z0-9]{2,5}$/i, "").trim();
    if (!name || /^(index|playlist|master|manifest|video|stream|chunklist|media)$/i.test(name)) {
      return u.hostname.replace(/^www\./, "").slice(0, 120);
    }
    return name.slice(0, 120);
  } catch {
    return null;
  }
}

/* ---- Titles and thumbnails via YouTube's oEmbed (no API key). Cached,
   and never allowed to block anything. Other kinds arrive from
   server/resolve.js already described. */

const metaCache = new Map();

async function youtubeMeta(id) {
  if (metaCache.has(id)) return metaCache.get(id);
  const watch = `https://www.youtube.com/watch?v=${id}`;
  const res = await fetch(
    `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`,
    { signal: AbortSignal.timeout(4000) }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const meta = {
    title: String(data.title || "").slice(0, 120) || null,
    author: String(data.author_name || "").slice(0, 60) || null,
  };
  metaCache.set(id, meta);
  if (metaCache.size > 2000) metaCache.delete(metaCache.keys().next().value);
  return meta;
}

// Is there anything enrich() would add?
function needsEnrich(media) {
  if (!media || media.title) return false;
  return media.kind === "youtube" || media.kind === "file" || media.kind === "hls";
}

// Fill in title / author / thumbnail in place. Resolves even on failure.
async function enrich(media) {
  if (!media) return media;
  if (media.kind === "file" || media.kind === "hls") {
    if (!media.title) {
      const t = fileTitle(media.url);
      if (t) media.title = t;
    }
    return media;
  }
  if (media.kind !== "youtube") return media;
  media.thumb = `https://i.ytimg.com/vi/${media.id}/mqdefault.jpg`;
  if (media.title || process.env.OFFLINE_META === "1") return media;
  try {
    const meta = await youtubeMeta(media.id);
    media.title = meta.title;
    media.author = meta.author;
  } catch {
    /* untitled is fine */
  }
  return media;
}

module.exports = {
  parseInput,
  fromClient,
  refusal,
  publicHost,
  FILE_HOST_ERROR,
  infoFrom,
  key,
  isTimed,
  needsEnrich,
  enrich,
  youtubeId,
  fileTitle,
};
