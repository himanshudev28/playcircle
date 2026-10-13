// "Paste any link": turn whatever someone pasted into VideoMedia the room
// can sync (lib/socket.ts), or a human error message.
//
//   1. Trim; it must be an http(s) URL (scheme optional) or a bare YouTube id.
//   2. Known by its shape, no fetch: YouTube, Vimeo, Dailymotion, Twitch,
//      direct .mp4/.webm/.mov/.ogv/.m3u8 links. Copy-protected services and
//      Twitch clips get their own explanation here. A file / HLS link must
//      be on a public host: every viewer's browser will fetch it.
//   3. Providers with a public API: Streamable, Internet Archive, PeerTube.
//   4. Any other page: fetch it (server/safeFetch.js) and read what it
//      shares — og:video, twitter:player:stream, JSON-LD VideoObject,
//      <video>/<source>, oEmbed discovery, provider <iframe>s. A candidate
//      with no telling extension is HEAD-probed for its Content-Type.
//   5. Title / author / thumbnail when they come cheap. Never blocking.
//
// Page JavaScript is never run, and nothing is bypassed: if a site doesn't
// hand out its video, we say so.

const { safeFetch, classifyType, createLru, FetchError } = require("./safeFetch");
const media = require("./media");

const ERR = {
  notLink: "That doesn't look like a video link",
  notFound:
    "Couldn't find a video on that page — the site doesn't share it. Try Share → Browser tab instead.",
  blocked: "That link can't be opened",
  unreachable: "Couldn't reach that site",
  twitchClip: "Twitch clips can't be synced — paste the video or channel link",
  protected: (service) =>
    `${service} is copy-protected and can't be played here — each person needs to watch it on their own account.`,
};

const MAX_INPUT = 2000;
const MAX_PROBES = 3;
const META_TIMEOUT_MS = 2_500;
const RESOLVE_BUDGET_MS = 12_000;

/* ---- Small helpers ---- */

const VIDEO_EXT = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
  ogg: "video/ogg",
};

function extOf(u) {
  const m = u.pathname.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  return m ? m[1] : "";
}

// A direct video file or HLS playlist, judged by the URL alone. (Whether its
// host is one every viewer may be sent to is checked in resolve().)
function byExtension(u) {
  const ext = extOf(u);
  if (ext === "m3u8") return { kind: "hls", url: u.href };
  if (VIDEO_EXT[ext]) return { kind: "file", url: u.href, mime: VIDEO_EXT[ext] };
  return null;
}

function hostOf(u) {
  return u.hostname.toLowerCase().replace(/\.$/, "").replace(/^(www|m)\./, "");
}

function isHost(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function toUrl(s, base) {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (!t || t.length > MAX_INPUT) return null;
  try {
    const u = base ? new URL(t, base) : new URL(t);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

// Add `info` fields `m` doesn't have yet (what's already there wins).
function fill(m, info) {
  for (const [k, v] of Object.entries(info)) if (m[k] === undefined) m[k] = v;
  return m;
}

/* ---- 2. Known providers by URL shape ---- */

const PROTECTED = [
  ["netflix.com", "Netflix"],
  ["primevideo.com", "Prime Video"],
  ["disneyplus.com", "Disney+"],
  ["hotstar.com", "Hotstar"],
  ["jiohotstar.com", "Hotstar"],
  ["crunchyroll.com", "Crunchyroll"],
  ["max.com", "Max"],
  ["hbomax.com", "Max"],
  ["hulu.com", "Hulu"],
  ["tv.apple.com", "Apple TV"],
];

function protectedService(u) {
  const host = hostOf(u);
  for (const [domain, name] of PROTECTED) if (isHost(host, domain)) return name;
  // amazon.com / amazon.co.uk / amazon.in … — only their video section.
  if (/(^|\.)amazon\.[a-z.]{2,6}$/.test(host) && /^\/(gp\/video|prime-?video)/i.test(u.pathname)) {
    return "Prime Video";
  }
  return null;
}

const VIMEO_ID = /^\d{1,15}$/;
const VIMEO_HASH = /^[0-9a-f]{6,40}$/i;
const DM_ID = /^[a-zA-Z0-9]{5,20}$/;
const TWITCH_VIDEO = /^\d{1,15}$/;
const TWITCH_CHANNEL = /^[a-zA-Z0-9_]{3,25}$/;
// twitch.tv/<these> aren't channels.
const TWITCH_RESERVED = new Set([
  "directory", "settings", "search", "downloads", "jobs", "login", "signup",
  "subscriptions", "inventory", "wallet", "friends", "messages", "turbo",
  "prime", "store", "p", "videos", "user", "following", "drops", "broadcast",
  "moderator", "popout", "embed", "products", "team", "privacy", "legal",
]);

function vimeo(u) {
  const host = hostOf(u);
  if (host === "player.vimeo.com") {
    const m = u.pathname.match(/^\/video\/(\d{1,15})/);
    if (!m) return null;
    const h = u.searchParams.get("h");
    return { kind: "vimeo", id: m[1], ...(h && VIMEO_HASH.test(h) ? { hash: h } : {}) };
  }
  if (host !== "vimeo.com") return null;
  const parts = u.pathname.split("/").filter(Boolean);
  // vimeo.com/123[/hash], /channels/x/123, /groups/x/videos/123,
  // /showcase/x/video/123, /album/x/video/123
  let i = parts.findIndex((p) => VIMEO_ID.test(p));
  if (i < 0) return null;
  if (i > 0 && !["channels", "groups", "videos", "video", "staffpicks"].some((w) => parts.includes(w))) {
    return null;
  }
  const id = parts[i];
  const next = parts[i + 1];
  const h = next && VIMEO_HASH.test(next) ? next : u.searchParams.get("h");
  return { kind: "vimeo", id, ...(h && VIMEO_HASH.test(h) ? { hash: h } : {}) };
}

function dailymotion(u) {
  const host = hostOf(u);
  let id = null;
  if (host === "dai.ly") id = u.pathname.split("/")[1];
  else if (host === "geo.dailymotion.com") id = u.searchParams.get("video");
  else if (host === "dailymotion.com") {
    const m = u.pathname.match(/^\/(?:embed\/)?video\/([^/?#]+)/);
    id = m ? m[1] : u.searchParams.get("video");
  }
  if (!id) return null;
  id = id.split("_")[0]; // old URLs: x7tgad0_some-title
  return DM_ID.test(id) ? { kind: "dailymotion", id } : null;
}

// Twitch: { media } | { clip: true } | null
function twitch(u) {
  const host = hostOf(u);
  if (host === "clips.twitch.tv") return { clip: true };
  if (host === "player.twitch.tv") {
    const v = (u.searchParams.get("video") || "").replace(/^v/, "");
    if (TWITCH_VIDEO.test(v)) return { media: { kind: "twitch", type: "video", id: v } };
    const c = u.searchParams.get("channel") || "";
    if (TWITCH_CHANNEL.test(c)) return { media: { kind: "twitch", type: "channel", id: c.toLowerCase() } };
    if (u.searchParams.get("clip")) return { clip: true };
    return null;
  }
  if (host !== "twitch.tv") return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts[0] === "videos" && TWITCH_VIDEO.test(parts[1] || "")) {
    return { media: { kind: "twitch", type: "video", id: parts[1] } };
  }
  if (parts[1] === "clip" || parts[0] === "clip") return { clip: true };
  if (parts[1] === "v" && TWITCH_VIDEO.test(parts[2] || "")) {
    return { media: { kind: "twitch", type: "video", id: parts[2] } };
  }
  const ch = parts[0] || "";
  if (parts.length <= 2 && TWITCH_CHANNEL.test(ch) && !TWITCH_RESERVED.has(ch.toLowerCase())) {
    // twitch.tv/<channel> or twitch.tv/<channel>/videos etc.
    if (parts.length === 1 || ["videos", "about", "schedule"].includes(parts[1])) {
      return { media: { kind: "twitch", type: "channel", id: ch.toLowerCase() } };
    }
  }
  return null;
}

/* Everything recognisable from the URL alone.
   → { media } | { error } | null (needs a fetch) */
function matchKnown(u) {
  const service = protectedService(u);
  if (service) return { error: ERR.protected(service) };
  const yt = media.youtubeId(u.href);
  if (yt) return { media: { kind: "youtube", id: yt } };
  const v = vimeo(u);
  if (v) return { media: v };
  const d = dailymotion(u);
  if (d) return { media: d };
  const t = twitch(u);
  if (t && t.clip) return { error: ERR.twitchClip, clip: true };
  if (t) return { media: t.media };
  const f = byExtension(u);
  if (f) return { media: f };
  return null;
}

/* ---- Tiny HTML reading (no DOM, no scripts) ---- */

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s) {
  return String(s).replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, (all, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? all : v;
  });
}

// Drop <!-- comments --> (linear: no regex backtracking on a huge page).
function stripComments(html) {
  let out = "";
  let i = 0;
  for (;;) {
    const start = html.indexOf("<!--", i);
    if (start < 0) return out + html.slice(i);
    out += html.slice(i, start);
    const end = html.indexOf("-->", start + 4);
    if (end < 0) return out;
    i = end + 3;
  }
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(s))) {
    const name = m[1].toLowerCase();
    if (name in attrs) continue;
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

const MAX_TAG = 8 * 1024;
const MAX_TAGS = 2000;
const TAG_END = /[\s/>]/;
const SPACE = /\s/;

/* find(p) → the first index ≥ p of what `search(p)` looks for (or the
   string's length). Remembers its last answer, so queries that only move
   forward (as a scan does) look at each character once overall. */
function forwardFinder(length, search) {
  let from = -1;
  let at = -1;
  return (p) => {
    if (p >= from && p <= at) return at;
    const i = search(p);
    from = p;
    at = i < 0 ? length : i;
    return at;
  };
}

/* Every <name …> start tag: [{ attrs, index, end }]. A linear scan, never a
   backtracking regex over the page: each character is looked at about once
   (native searches that only move forward), so a page full of unclosed or
   oversized tags can't stall the server. A quote only counts when it opens
   an attribute value (right after "="), so a stray apostrophe can't
   swallow the rest. A tag longer than MAX_TAG is skipped, and scanning
   carries on after it. `lower` is html.toLowerCase(), passed in when the
   caller has it. */
function tags(html, name, lower = html.toLowerCase()) {
  const special = /[>"']/g;
  const nextSpecial = forwardFinder(html.length, (p) => {
    special.lastIndex = p;
    const m = special.exec(html);
    return m ? m.index : -1;
  });
  const nextQuote = {
    '"': forwardFinder(html.length, (p) => html.indexOf('"', p)),
    "'": forwardFinder(html.length, (p) => html.indexOf("'", p)),
  };
  // Index of the ">" ending the tag whose attributes start at `from`, or -1.
  const closeOf = (from, limit) => {
    for (let k = from; ; ) {
      const at = nextSpecial(k);
      if (at >= limit) return -1;
      const ch = html[at];
      if (ch === ">") return at;
      let b = at - 1;
      while (b >= from && SPACE.test(html[b])) b--;
      if (b < from || html[b] !== "=") {
        k = at + 1; // a stray quote, not an attribute value
        continue;
      }
      const shut = nextQuote[ch](at + 1);
      if (shut >= limit) return -1;
      k = shut + 1;
    }
  };

  const open = `<${name}`;
  const out = [];
  let i = 0;
  while (out.length < MAX_TAGS) {
    const start = lower.indexOf(open, i);
    if (start < 0) break;
    const from = start + open.length;
    if (from < html.length && !TAG_END.test(html[from])) {
      i = from; // <metadata …> isn't <meta>
      continue;
    }
    const limit = Math.min(html.length, start + MAX_TAG);
    const close = closeOf(from, limit);
    if (close < 0) {
      i = limit; // unterminated or too long: move on past it
      continue;
    }
    out.push({ attrs: parseAttrs(html.slice(from, close)), index: start, end: close + 1 });
    i = close + 1;
  }
  return out;
}

// Every index of `needle` in `hay`, in order (one pass).
function positions(hay, needle) {
  const out = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

function readPage(rawHtml) {
  const html = stripComments(rawHtml);
  const lower = html.toLowerCase();
  const meta = new Map(); // lowercased property/name → [content…]
  for (const { attrs } of tags(html, "meta", lower)) {
    const k = (attrs.property || attrs.name || attrs.itemprop || "").toLowerCase();
    if (!k || attrs.content === undefined) continue;
    if (!meta.has(k)) meta.set(k, []);
    meta.get(k).push(attrs.content);
  }
  const links = tags(html, "link", lower).map((t) => t.attrs);

  // JSON-LD blocks.
  const ld = [];
  const scriptCloses = positions(lower, "</script");
  let sc = 0;
  for (const t of tags(html, "script", lower)) {
    while (sc < scriptCloses.length && scriptCloses[sc] < t.end) sc++;
    if (!/ld\+json/i.test(t.attrs.type || "")) continue;
    if (sc >= scriptCloses.length) break;
    const text = html.slice(t.end, scriptCloses[sc]).replace(/^\s*(\/\/)?\s*<!\[CDATA\[|\]\]>\s*$/g, "");
    try {
      ld.push(JSON.parse(text));
    } catch {
      /* broken JSON-LD is common; skip it */
    }
  }

  // <video src poster> and the <source>s inside each <video>: every tag is
  // read once, and each <source> goes to the nearest <video> before it
  // whose </video> comes after it.
  const videoTags = tags(html, "video", lower);
  const videoCloses = positions(lower, "</video");
  const videos = [];
  let vc = 0;
  for (const t of videoTags) {
    while (vc < videoCloses.length && videoCloses[vc] < t.end) vc++;
    videos.push({
      src: t.attrs.src || null,
      poster: t.attrs.poster || null,
      sources: [],
      start: t.end,
      close: vc < videoCloses.length ? videoCloses[vc] : -1,
    });
  }
  let vi = -1;
  for (const s of videoTags.length ? tags(html, "source", lower) : []) {
    while (vi + 1 < videos.length && videos[vi + 1].start <= s.index) vi++;
    const v = videos[vi];
    if (v && s.index < v.close && s.attrs.src) v.sources.push({ src: s.attrs.src, type: s.attrs.type || "" });
  }
  for (const v of videos) {
    delete v.start;
    delete v.close;
  }

  const iframes = tags(html, "iframe", lower)
    .map((t) => t.attrs.src || t.attrs["data-src"])
    .filter(Boolean);

  // The first <title>…</title> (plain text, at most 500 characters).
  let title = null;
  const [titleTag] = tags(html, "title", lower).slice(0, 1);
  if (titleTag) {
    const close = lower.indexOf("</title", titleTag.end);
    const text = close >= 0 && close - titleTag.end <= 500 ? html.slice(titleTag.end, close) : "";
    if (text && !text.includes("<")) title = decodeEntities(text);
  }
  return { meta, links, ld, videos, iframes, title };
}

const first = (page, ...keys) => {
  for (const k of keys) {
    const v = page.meta.get(k);
    if (v && v.length) return v[0];
  }
  return null;
};
const all = (page, ...keys) => keys.flatMap((k) => page.meta.get(k) || []);

// Every VideoObject in the JSON-LD (incl. @graph and nested "video").
function videoObjects(ld) {
  const out = [];
  let budget = 2000;
  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 8 || --budget < 0) return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x, depth + 1);
      return;
    }
    const type = node["@type"];
    const types = Array.isArray(type) ? type : [type];
    if (types.some((t) => typeof t === "string" && /VideoObject$/i.test(t))) out.push(node);
    for (const v of Object.values(node)) if (v && typeof v === "object") walk(v, depth + 1);
  };
  walk(ld, 0);
  return out;
}

function ldString(v) {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return ldString(v[0]);
  if (v && typeof v === "object") return ldString(v.url || v.contentUrl || v["@id"]);
  return null;
}

/* ---- Candidate → media ---- */

const probeCache = createLru(500, 10 * 60_000);

/* HEAD the URL (a one-byte ranged GET if HEAD isn't supported) and read its
   Content-Type → { kind: "file", mime } | { kind: "hls" } | null; throws
   FetchError. Both requests share one deadline (the probe's own, never past
   the whole resolve's), so a slow HEAD doesn't buy the GET more time. */
async function probe(url, ctx) {
  const cacheKey = `${ctx.opts.allowPrivate ? 1 : 0}|${url}`;
  const hit = ctx.opts.cache === false ? undefined : probeCache.get(cacheKey);
  if (hit !== undefined) return hit;
  const deadline = Math.min(ctx.deadline, Date.now() + META_TIMEOUT_MS * 2);
  const left = () => Math.max(1, deadline - Date.now());
  let res = await safeFetch(url, { ...ctx.fetchOpts(left()), method: "HEAD" });
  if (res.status === 405 || res.status === 501 || res.status === 403 || !res.headers["content-type"]) {
    if (Date.now() >= deadline) throw new FetchError("network", "timeout");
    res = await safeFetch(url, {
      ...ctx.fetchOpts(left()),
      method: "GET",
      headers: { range: "bytes=0-0" },
      readBody: () => false,
    });
  }
  const out = res.status < 400 ? classifyType(res.headers["content-type"]) : null;
  if (ctx.opts.cache !== false) probeCache.set(cacheKey, out);
  return out;
}

// A file / HLS URL every viewer's browser may be sent to (see
// media.publicHost); tests serve fixtures from 127.0.0.1 (allowPrivate).
function hostAllowed(m, opts) {
  if (m.kind !== "file" && m.kind !== "hls") return true;
  return !!opts.allowPrivate || media.publicHost(m.url);
}

// Pinned-down media from one candidate URL, or null. Probes the
// Content-Type of URLs without a telling extension (a few per page).
async function fromCandidate(raw, base, ctx) {
  const u = toUrl(typeof raw === "string" ? raw : "", base);
  if (!u) return null;
  const known = matchKnown(u);
  if (known && known.clip) {
    ctx.sawClip = true;
    return null;
  }
  if (known && known.media) {
    if (hostAllowed(known.media, ctx.opts)) return known.media;
    ctx.sawBlocked = true; // a file on a private / intranet host
    return null;
  }
  if (known) return null; // a protected-service embed: not playable
  if (!ctx.opts.allowPrivate && !media.publicHost(u.href)) {
    ctx.sawBlocked = true;
    return null;
  }
  if (ctx.probes >= MAX_PROBES || Date.now() > ctx.deadline) return null;
  ctx.probes += 1;
  try {
    const t = await probe(u.href, ctx);
    if (t && t.kind === "hls") return { kind: "hls", url: u.href };
    if (t && t.kind === "file") return { kind: "file", url: u.href, mime: t.mime };
  } catch (err) {
    if (err instanceof FetchError && err.code === "blocked") ctx.sawBlocked = true;
  }
  return null;
}

/* ---- Metadata ---- */

const offlineMeta = (opts) => opts.meta === false || process.env.OFFLINE_META === "1";

function parseClock(s) {
  if (typeof s === "number") return s;
  if (typeof s !== "string") return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(":").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

async function jsonFrom(url, ctx, timeoutMs) {
  const res = await safeFetch(url, {
    ...ctx.fetchOpts(timeoutMs),
    headers: { accept: "application/json" },
  });
  if (res.status >= 400) throw new FetchError("network", `HTTP ${res.status}`);
  return res.json();
}

// Vimeo / Dailymotion oEmbed: title, author, thumbnail (+ duration on
// Vimeo). Short timeout; any failure just leaves the fields empty.
async function providerMeta(m, ctx) {
  if (offlineMeta(ctx.opts)) return;
  let endpoint = null;
  if (m.kind === "vimeo") {
    const page = `https://vimeo.com/${m.id}${m.hash ? `/${m.hash}` : ""}`;
    endpoint = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(page)}`;
  } else if (m.kind === "dailymotion") {
    const page = `https://www.dailymotion.com/video/${m.id}`;
    endpoint = `https://www.dailymotion.com/services/oembed?format=json&url=${encodeURIComponent(page)}`;
  }
  if (!endpoint) return;
  try {
    const data = await jsonFrom(endpoint, ctx, META_TIMEOUT_MS);
    fill(m, media.infoFrom({
      title: data.title,
      author: data.author_name,
      thumb: data.thumbnail_url,
      duration: m.kind === "vimeo" ? data.duration : undefined,
    }));
  } catch {
    /* untitled is fine */
  }
}

/* ---- 3. Provider APIs ---- */

async function streamable(u, ctx) {
  if (hostOf(u) !== "streamable.com") return null;
  const m = u.pathname.match(/^\/(?:[eo]\/)?([a-z0-9]{3,16})\/?$/i);
  if (!m) return null;
  const base = ctx.opts.apiBase?.streamable || "https://api.streamable.com";
  const data = await jsonFrom(`${base}/videos/${m[1]}`, ctx, 5_000);
  const files = data && typeof data.files === "object" ? data.files : {};
  const f = files.mp4 || files["mp4-mobile"];
  const url = f && toUrl(String(f.url || "").replace(/^\/\//, "https://"));
  if (!url) return null;
  return {
    kind: "file",
    url: url.href,
    mime: "video/mp4",
    ...media.infoFrom({
      title: data.title,
      thumb: typeof data.thumbnail_url === "string" ? data.thumbnail_url.replace(/^\/\//, "https://") : null,
      duration: f.duration,
    }),
  };
}

async function internetArchive(u, ctx) {
  if (hostOf(u) !== "archive.org") return null;
  const m = u.pathname.match(/^\/(?:details|embed)\/([^/]+)(?:\/(.+))?$/);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(id)) return null;
  const wanted = m[2] ? decodeURIComponent(m[2]) : null;
  const base = ctx.opts.apiBase?.archive || "https://archive.org";
  const data = await jsonFrom(`${base}/metadata/${encodeURIComponent(id)}`, ctx, 6_000);
  const files = Array.isArray(data && data.files) ? data.files : [];
  const rank = (f) => {
    const name = String(f.name || "").toLowerCase();
    if (name.endsWith(".mp4")) return 3;
    if (name.endsWith(".webm")) return 2;
    if (name.endsWith(".ogv")) return 1;
    return 0;
  };
  const playable = files.filter((f) => typeof f.name === "string" && rank(f) > 0);
  if (!playable.length) return null;
  const chosen =
    (wanted && playable.find((f) => f.name === wanted)) ||
    playable.sort((a, b) => rank(b) - rank(a))[0];
  const path = chosen.name.split("/").map(encodeURIComponent).join("/");
  const ext = chosen.name.toLowerCase().split(".").pop();
  const md = (data && data.metadata) || {};
  const one = (v) => (Array.isArray(v) ? v[0] : v);
  return {
    kind: "file",
    url: `https://archive.org/download/${encodeURIComponent(id)}/${path}`,
    mime: VIDEO_EXT[ext],
    ...media.infoFrom({
      title: one(md.title),
      author: one(md.creator),
      thumb: `https://archive.org/services/img/${encodeURIComponent(id)}`,
      duration: parseClock(chosen.length),
    }),
  };
}

async function peertube(u, ctx) {
  const m = u.pathname.match(/^\/(?:w|videos\/watch|videos\/embed)\/([a-zA-Z0-9-]{8,40})\/?$/);
  if (!m) return null;
  const data = await jsonFrom(`${u.origin}/api/v1/videos/${m[1]}`, ctx, 5_000);
  if (!data || typeof data !== "object" || !data.uuid) return null;
  const info = media.infoFrom({
    title: data.name,
    author: data.account?.displayName || data.channel?.displayName,
    thumb: typeof data.thumbnailPath === "string" ? `${u.origin}${data.thumbnailPath}` : null,
    duration: data.isLive ? null : data.duration,
  });
  const playlists = Array.isArray(data.streamingPlaylists) ? data.streamingPlaylists : [];
  const hls = playlists.map((p) => p && toUrl(String(p.playlistUrl || ""))).find(Boolean);
  if (hls) return { kind: "hls", url: hls.href, ...info };
  const files = (Array.isArray(data.files) ? data.files : [])
    .map((f) => ({ url: f && toUrl(String(f.fileUrl || "")), res: Number(f?.resolution?.id) || 0 }))
    .filter((f) => f.url && f.res > 0);
  // The sharpest file up to 1080p, else the smallest one above it.
  const best =
    files.filter((f) => f.res <= 1080).sort((a, b) => b.res - a.res)[0] ||
    files.sort((a, b) => a.res - b.res)[0];
  if (!best) return null;
  const ext = extOf(best.url);
  return { kind: "file", url: best.url.href, mime: VIDEO_EXT[ext] || "video/mp4", ...info };
}

/* ---- 4. Any page ---- */

const READABLE = /^(text\/html|application\/xhtml\+xml|text\/plain)/i;

async function fromPage(u, ctx) {
  const res = await safeFetch(u.href, {
    ...ctx.fetchOpts(),
    headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "accept-language": "en" },
    // A video (or anything that isn't a page) isn't downloaded.
    readBody: (headers) => READABLE.test(String(headers["content-type"] || "text/html")),
  });
  if (res.status >= 400) return { error: ERR.unreachable };
  // The link itself was the video, just without an extension.
  const direct = classifyType(res.headers["content-type"]);
  if (direct) {
    return direct.kind === "hls"
      ? { media: { kind: "hls", url: u.href } }
      : { media: { kind: "file", url: u.href, mime: direct.mime } };
  }
  if (!READABLE.test(String(res.headers["content-type"] || "text/html"))) return { error: ERR.notFound };

  const pageUrl = res.url;
  const page = readPage(res.text());
  const pageInfo = () => {
    const lds = page.ld.flatMap(videoObjects);
    return media.infoFrom({
      title:
        (lds[0] && ldString(lds[0].name)) ||
        first(page, "og:title", "twitter:title") ||
        page.title,
      thumb: absolute(
        (lds[0] && ldString(lds[0].thumbnailUrl)) ||
          first(page, "og:image:secure_url", "og:image", "og:image:url", "twitter:image") ||
          page.videos.find((v) => v.poster)?.poster,
        pageUrl
      ),
    });
  };
  const found = (m) => {
    // Page title / image describe a file found on it; providers describe
    // their own videos (oEmbed, or YouTube's enrich later).
    if (m.kind === "file" || m.kind === "hls") fill(m, pageInfo());
    return { media: m };
  };

  // og:video, then twitter:player:stream.
  for (const c of all(page, "og:video:secure_url", "og:video:url", "og:video")) {
    const m = await fromCandidate(c, pageUrl, ctx);
    if (m) return found(m);
  }
  for (const c of all(page, "twitter:player:stream")) {
    const m = await fromCandidate(c, pageUrl, ctx);
    if (m) return found(m);
  }
  // JSON-LD VideoObject: contentUrl, then embedUrl.
  for (const v of page.ld.flatMap(videoObjects)) {
    for (const c of [ldString(v.contentUrl), ldString(v.embedUrl)]) {
      if (!c) continue;
      const m = await fromCandidate(c, pageUrl, ctx);
      if (m) return found(m);
    }
  }
  // <video src> / <source src>.
  for (const v of page.videos) {
    for (const c of [v.src, ...v.sources.map((s) => s.src)]) {
      if (!c) continue;
      const m = await fromCandidate(c, pageUrl, ctx);
      if (m) return found(m);
    }
  }
  // oEmbed discovery → the iframe it describes.
  const oembed = page.links.find(
    (l) => /\balternate\b/i.test(l.rel || "") && /json\+oembed/i.test(l.type || "") && l.href
  );
  const oembedUrl = oembed && toUrl(oembed.href, pageUrl);
  if (oembedUrl && Date.now() < ctx.deadline) {
    try {
      const data = await jsonFrom(oembedUrl.href, ctx, 4_000);
      const html = typeof data?.html === "string" ? data.html : "";
      for (const t of tags(html, "iframe")) {
        const m = await fromCandidate(t.attrs.src || "", pageUrl, ctx);
        if (m) {
          if (m.kind === "file" || m.kind === "hls" || m.kind === "twitch") {
            fill(m, media.infoFrom({ title: data.title, author: data.author_name, thumb: data.thumbnail_url }));
          }
          return { media: m };
        }
      }
    } catch (err) {
      if (err instanceof FetchError && err.code === "blocked") ctx.sawBlocked = true;
    }
  }
  // A known provider's player, embedded in the page.
  for (const c of [...page.iframes, ...all(page, "twitter:player")]) {
    const u2 = toUrl(c, pageUrl);
    if (!u2) continue;
    const known = matchKnown(u2);
    if (known && known.clip) ctx.sawClip = true;
    else if (known && known.media && known.media.kind !== "file" && known.media.kind !== "hls") {
      return { media: known.media };
    }
  }
  if (ctx.sawClip) return { error: ERR.twitchClip };
  return { error: ERR.notFound };
}

function absolute(s, base) {
  const u = toUrl(typeof s === "string" ? s : "", base);
  return u ? u.href : null;
}

/* ---- Putting it together ---- */

const cache = createLru(500, 10 * 60_000);

/* resolve(input, opts) → Promise<VideoMedia | { error }>
   opts: allowPrivate (tests), meta: false (skip provider oEmbed), cache:
   false, apiBase: { streamable, archive } (tests), timeoutMs per fetch,
   budgetMs for the whole thing (≤ RESOLVE_BUDGET_MS),
   plus safeFetch's test hooks (lookup, isBlocked, allowAnyPort). */
async function resolve(input, opts = {}) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw || raw.length > MAX_INPUT) return { error: ERR.notLink };

  // YouTube (a bare id or any of its links): no fetch, enrich() titles it.
  const yt = media.parseInput(raw);
  if (yt) return yt;
  // A link with no scheme ("vimeo.com/123") is taken as https.
  let u = toUrl(raw);
  if (!u && !/^[a-z][a-z0-9+.-]*:/i.test(raw) && /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i.test(raw)) {
    u = toUrl(`https://${raw}`);
  }
  if (!u || /\s/.test(raw)) return { error: ERR.notLink };

  const cacheKey = `${opts.allowPrivate ? 1 : 0}|${u.href}`;
  if (opts.cache !== false) {
    const hit = cache.get(cacheKey);
    if (hit) return { ...hit };
  }
  const out = await resolveUrl(u, opts);
  // A file on a private / intranet host would send every viewer's browser
  // there (a provider API can hand one out too).
  if (!out.error && !hostAllowed(out, opts)) return { error: ERR.blocked };
  if (!out.error) {
    if (out.kind !== "youtube") out.source = out.source || u.href;
    if ((out.kind === "file" || out.kind === "hls") && !out.title) out.title = media.fileTitle(out.url);
    if (out.kind === "twitch" && out.type === "channel" && !out.title) {
      out.title = out.id;
      out.author = out.id;
    }
    // Only fields lib/socket.ts knows, each validated.
    const clean = media.fromClient(out, { allowPrivate: !!opts.allowPrivate });
    if (!clean) return { error: ERR.notFound };
    Object.assign(clean, media.infoFrom(out));
    if (opts.cache !== false) cache.set(cacheKey, clean);
    return { ...clean };
  }
  if (out.cache && opts.cache !== false) cache.set(cacheKey, out);
  return { error: out.error };
}

// One resolve's shared state. Every fetch it makes ends by `deadline`
// (RESOLVE_BUDGET_MS from the start, or opts.budgetMs).
function resolveCtx(opts) {
  return {
    opts,
    probes: 0,
    sawClip: false,
    sawBlocked: false,
    deadline: Date.now() + Math.min(opts.budgetMs ?? RESOLVE_BUDGET_MS, RESOLVE_BUDGET_MS),
    fetchOpts(timeoutMs) {
      const left = Math.max(1, this.deadline - Date.now());
      return {
        allowPrivate: !!opts.allowPrivate,
        allowAnyPort: !!opts.allowAnyPort,
        lookup: opts.lookup,
        isBlocked: opts.isBlocked,
        cache: opts.cache,
        maxBytes: opts.maxBytes,
        timeoutMs: Math.min(timeoutMs ?? opts.timeoutMs ?? 6_000, left),
      };
    },
  };
}

async function resolveUrl(u, opts) {
  const ctx = resolveCtx(opts);

  // 2. By shape.
  const known = matchKnown(u);
  if (known && known.error) return { error: known.error };
  if (known) {
    await providerMeta(known.media, ctx);
    return known.media;
  }

  try {
    // 3. Provider APIs. A miss (not that provider after all) falls through.
    for (const api of [streamable, internetArchive, peertube]) {
      try {
        const m = await api(u, ctx);
        if (m) return m;
      } catch (err) {
        if (err instanceof FetchError && err.code === "blocked") throw err;
        /* not that provider (or it's down): try the page itself */
      }
    }
    // 4. The page.
    const r = await fromPage(u, ctx);
    if (r.media) {
      await providerMeta(r.media, ctx);
      return r.media;
    }
    if (r.error === ERR.notFound && ctx.sawBlocked) return { error: ERR.blocked };
    return { error: r.error, cache: r.error === ERR.notFound || r.error === ERR.twitchClip };
  } catch (err) {
    if (err instanceof FetchError && err.code === "blocked") return { error: ERR.blocked };
    return { error: ERR.unreachable };
  }
}

module.exports = {
  resolve,
  matchKnown,
  readPage,
  decodeEntities,
  ERR,
  clearCache: () => cache.clear(),
};
