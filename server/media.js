// What's on the stage, and how to describe it.
//   youtube — { kind: "youtube", id, title?, author?, thumb?, duration? },
//             synced through the IFrame API
//   live    — { kind: "live", source, streamId, presenter, title, by },
//             someone's tab, screen or local file streamed over WebRTC
// The server normalises everything a client proposes; clients never get to
// put arbitrary fields on the room. Clients can only ever propose YouTube:
// live media is created by the server itself (server/stage.js).

const YT_ID = /^[a-zA-Z0-9_-]{11}$/;

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

// A link or id someone pasted → stage media, or null.
function parseInput(input) {
  const id = youtubeId(input);
  return id ? { kind: "youtube", id } : null;
}

// Media a client sent as an object ({ kind, id }) → stage media, or null.
// Only YouTube: a client can't put a "live" share on stage this way.
function fromClient(m) {
  if (!m || typeof m !== "object") return null;
  if (m.kind === "youtube" && YT_ID.test(String(m.id))) {
    return { kind: "youtube", id: String(m.id) };
  }
  return null;
}

// Stable identity; play/pause/seek/ended carry it.
function key(media) {
  if (!media) return null;
  if (media.kind === "youtube") return `yt:${media.id}`;
  if (media.kind === "live") return `live:${media.streamId}`;
  return null;
}

// Only YouTube has a shared timeline (sync ticks, ended, moments, history).
function isTimed(media) {
  return !!media && media.kind === "youtube";
}

/* ---- Titles and thumbnails via YouTube's oEmbed (no API key). Cached,
   and never allowed to block anything. */

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

// Fill in title / author / thumbnail in place. Resolves even on failure.
async function enrich(media) {
  if (!isTimed(media)) return media;
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

module.exports = { parseInput, fromClient, key, isTimed, enrich, youtubeId };
