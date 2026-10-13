// Fetching URLs that people paste, without letting them point the server at
// itself or its network (SSRF). Every hop of a request:
//   - must be http(s), on a normal web port (80/443, or 8080/8443);
//   - has its host resolved here, and is refused if ANY address it resolves
//     to is private, loopback, link-local, CGNAT, multicast or reserved
//     (IPv4 and IPv6, including IPv4 hidden inside IPv6);
//   - connects to exactly the address that was checked (a pinned lookup),
//     so a DNS answer that changes between check and connect (rebinding)
//     can't swap in an internal address;
//   - follows redirects by hand (at most 4), each one checked again.
// Bodies are capped (2 MB by default: reading stops and the connection is
// dropped beyond it) and the whole thing, redirects included, has one
// deadline (6 s by default). No cookies, no credentials, a bot User-Agent.
//
// `allowPrivate` (and the `lookup` / `isBlocked` / `allowAnyPort` hooks)
// exist for the tests only, which serve fixtures from 127.0.0.1.

const http = require("http");
const https = require("https");
const dns = require("dns");
const net = require("net");

const USER_AGENT = "PlayCircleBot/1.0 (+link preview)";
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 6_000;
const MAX_REDIRECTS = 4;
const OK_PORTS = new Set(["", "80", "443", "8080", "8443"]);

class FetchError extends Error {
  // code: "blocked" (we refused to go there) | "network" (couldn't get there)
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/* ---- Address classification ---- */

function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

// [base, prefix bits] of every IPv4 range a link may never reach.
const V4_BLOCKED = [
  ["0.0.0.0", 8], // "this network", incl. 0.0.0.0
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata lives here)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. 255.255.255.255
].map(([base, bits]) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return [ipv4ToInt(base) & mask, mask];
});

function v4Blocked(n) {
  return V4_BLOCKED.some(([base, mask]) => ((n & mask) >>> 0) === base >>> 0);
}

// "2001:db8::1" → eight 16-bit numbers, or null. Handles "::", a trailing
// dotted IPv4 ("::ffff:1.2.3.4") and a zone id ("fe80::1%eth0").
function expandIPv6(ip) {
  let s = ip.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  const dotted = s.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const n = ipv4ToInt(dotted[2]);
    if (n === null) return null;
    s = `${dotted[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part) => (part ? part.split(":") : []);
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array(Math.max(0, missing)).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const out = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

function v6Blocked(g) {
  const embedded = (hi, lo) => v4Blocked(((hi << 16) >>> 0) + lo);
  // ::/96 (unspecified, loopback, old IPv4-compatible) and ::ffff:0:0/96
  // (IPv4-mapped): judge the IPv4 inside. :: and ::1 land in 0.0.0.0/8.
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0) {
    if (g[5] === 0 || g[5] === 0xffff) return embedded(g[6], g[7]);
    return true;
  }
  // NAT64 (64:ff9b::/96) carries an IPv4 address too.
  if (g[0] === 0x64 && g[1] === 0xff9b && !g[2] && !g[3] && !g[4] && !g[5]) {
    return embedded(g[6], g[7]);
  }
  // 6to4 (2002::/16): the IPv4 is in bits 16–48.
  if (g[0] === 0x2002) return embedded(g[1], g[2]);
  // Only global unicast (2000::/3) is reachable at all: this rules out
  // fc00::/7 (unique local), fe80::/10 (link-local), fec0::/10, ff00::/8
  // (multicast), 100::/64 (discard), 64:ff9b:1::/48 and the rest.
  if ((g[0] & 0xe000) !== 0x2000) return true;
  // Inside 2000::/3: IETF special-purpose 2001::/23 (Teredo, ORCHID …) and
  // the documentation prefixes 2001:db8::/32 and 3fff::/20.
  if (g[0] === 0x2001 && g[1] < 0x200) return true;
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true;
  if (g[0] === 0x3fff && g[1] < 0x1000) return true;
  return false;
}

// true when a link must never reach this address (or it isn't an address).
function isBlockedAddress(ip) {
  const s = String(ip || "").replace(/^\[|\]$/g, "");
  if (net.isIPv4(s)) return v4Blocked(ipv4ToInt(s));
  if (net.isIPv6(s)) {
    const g = expandIPv6(s);
    return !g || v6Blocked(g);
  }
  return true;
}

/* ---- URL and host checks ---- */

function checkUrl(input, { allowPrivate, allowAnyPort }) {
  let u;
  try {
    u = new URL(input);
  } catch {
    throw new FetchError("blocked", "not a URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new FetchError("blocked", `scheme ${u.protocol}`);
  }
  if (!allowPrivate && !allowAnyPort && !OK_PORTS.has(u.port)) {
    throw new FetchError("blocked", `port ${u.port}`);
  }
  if (!u.hostname) throw new FetchError("blocked", "no host");
  return u;
}

// Resolve `host` once and decide. Returns the one address to connect to.
async function pickAddress(host, o, deadline) {
  const bare = host.replace(/^\[|\]$/g, "");
  const blocked = o.isBlocked || isBlockedAddress;
  let addrs;
  if (net.isIP(bare)) {
    addrs = [{ address: bare, family: net.isIP(bare) }];
  } else {
    const lookup = o.lookup || ((h) => dns.promises.lookup(h, { all: true, verbatim: true }));
    try {
      addrs = await withDeadline(Promise.resolve(lookup(bare)), deadline);
    } catch (err) {
      if (err instanceof FetchError) throw err;
      throw new FetchError("network", `dns: ${err.code || err.message}`);
    }
    if (!Array.isArray(addrs)) addrs = [addrs];
    addrs = addrs
      .map((a) => (typeof a === "string" ? { address: a, family: net.isIP(a) } : a))
      .filter((a) => a && net.isIP(a.address));
  }
  if (!addrs.length) throw new FetchError("network", "no address");
  // Every answer must be public: a name that also points inside is refused
  // outright rather than "picking the safe one".
  if (!o.allowPrivate && addrs.some((a) => blocked(a.address))) {
    throw new FetchError("blocked", `address ${bare}`);
  }
  const a = addrs[0];
  return { address: a.address, family: a.family || net.isIP(a.address) };
}

function withDeadline(promise, deadline) {
  const left = deadline - Date.now();
  if (left <= 0) return Promise.reject(new FetchError("network", "timeout"));
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new FetchError("network", "timeout")), left);
    }),
  ]).finally(() => clearTimeout(timer));
}

/* ---- One HTTP exchange against a pinned address ---- */

function exchange(u, addr, { method, headers, maxBytes, readBody, deadline }) {
  return new Promise((resolve, reject) => {
    const left = deadline - Date.now();
    if (left <= 0) return reject(new FetchError("network", "timeout"));
    const lib = u.protocol === "https:" ? https : http;
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname.replace(/^\[|\]$/g, ""),
      port: u.port || undefined,
      path: `${u.pathname}${u.search}`,
      method,
      agent: false,
      headers: {
        "user-agent": USER_AGENT,
        accept: "*/*",
        "accept-encoding": "identity",
        ...headers,
      },
      // The address we checked, and no other (autoSelectFamily asks for all).
      lookup: (_host, options, cb) => {
        if (options && options.all) cb(null, [{ address: addr.address, family: addr.family }]);
        else cb(null, addr.address, addr.family);
      },
    });
    const timer = setTimeout(() => {
      req.destroy(new FetchError("network", "timeout"));
    }, left);

    req.on("error", (err) =>
      finish(reject, err instanceof FetchError ? err : new FetchError("network", err.code || err.message))
    );
    req.on("response", (res) => {
      const status = res.statusCode || 0;
      const isRedirect = [301, 302, 303, 307, 308].includes(status) && res.headers.location;
      if (isRedirect || method === "HEAD" || !readBody(res.headers, status)) {
        res.resume();
        req.destroy();
        return finish(resolve, { status, headers: res.headers, body: Buffer.alloc(0), truncated: false });
      }
      const chunks = [];
      let size = 0;
      let truncated = false;
      res.on("data", (chunk) => {
        if (truncated) return;
        const room = maxBytes - size;
        if (chunk.length > room) {
          chunks.push(chunk.subarray(0, room));
          size = maxBytes;
          truncated = true;
          // Past the cap: stop downloading.
          finish(resolve, { status, headers: res.headers, body: Buffer.concat(chunks), truncated });
          req.destroy();
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      res.on("end", () =>
        finish(resolve, { status, headers: res.headers, body: Buffer.concat(chunks), truncated })
      );
      res.on("error", (err) =>
        finish(reject, err instanceof FetchError ? err : new FetchError("network", err.code || err.message))
      );
      res.on("aborted", () => finish(reject, new FetchError("network", "aborted")));
    });
    req.end();
  });
}

/* safeFetch(url, opts) → { status, headers, url (final), truncated, text(), json() }
   Throws FetchError: code "blocked" (refused) or "network" (failed / timeout).
   opts: method ("GET" | "HEAD"), headers, maxBytes, timeoutMs, maxRedirects,
   readBody(headers, status) → false to skip the body (e.g. not HTML),
   allowPrivate (tests), and test hooks lookup(host) / isBlocked(ip) /
   allowAnyPort. */
async function safeFetch(url, opts = {}) {
  const o = {
    method: opts.method === "HEAD" ? "HEAD" : "GET",
    headers: opts.headers || {},
    maxBytes: opts.maxBytes ?? MAX_BYTES,
    maxRedirects: opts.maxRedirects ?? MAX_REDIRECTS,
    readBody: opts.readBody || (() => true),
    allowPrivate: !!opts.allowPrivate,
    allowAnyPort: !!opts.allowAnyPort,
    lookup: opts.lookup,
    isBlocked: opts.isBlocked,
  };
  const deadline = Date.now() + (opts.timeoutMs ?? TIMEOUT_MS);
  let current = url;
  for (let hop = 0; ; hop++) {
    const u = checkUrl(current, o);
    const addr = await pickAddress(u.hostname, o, deadline);
    const res = await exchange(u, addr, { ...o, deadline });
    const location = res.headers.location;
    if ([301, 302, 303, 307, 308].includes(res.status) && location) {
      if (hop >= o.maxRedirects) throw new FetchError("network", "too many redirects");
      try {
        current = new URL(String(location), u).href;
      } catch {
        throw new FetchError("network", "bad redirect");
      }
      continue;
    }
    const body = res.body;
    return {
      status: res.status,
      headers: res.headers,
      url: u.href,
      truncated: res.truncated,
      text: () => body.toString("utf8"),
      json: () => {
        if (res.truncated) throw new FetchError("network", "too big");
        return JSON.parse(body.toString("utf8"));
      },
    };
  }
}

/* ---- A small LRU with expiry ---- */

function createLru(max = 500, ttlMs = 10 * 60_000) {
  const map = new Map();
  return {
    get(key) {
      const e = map.get(key);
      if (!e) return undefined;
      if (Date.now() > e.exp) {
        map.delete(key);
        return undefined;
      }
      map.delete(key);
      map.set(key, e); // most recently used goes last
      return e.value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, { value, exp: Date.now() + ttlMs });
      while (map.size > max) map.delete(map.keys().next().value);
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}

/* ---- What kind of video does a URL serve? ---- */

const HLS_TYPES = new Set([
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
]);

// A Content-Type header → { kind: "file", mime } | { kind: "hls" } | null.
function classifyType(contentType) {
  const t = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (HLS_TYPES.has(t)) return { kind: "hls" };
  if (/^video\/[a-z0-9.+-]{1,40}$/.test(t)) return { kind: "file", mime: t };
  return null;
}

const probeCache = createLru(500, 10 * 60_000);

// HEAD the URL (a one-byte ranged GET if HEAD isn't supported) and read its
// Content-Type. Resolves null when it isn't a video; throws FetchError.
async function probeType(url, opts = {}) {
  const cacheKey = `${opts.allowPrivate ? 1 : 0}|${url}`;
  const hit = opts.cache === false ? undefined : probeCache.get(cacheKey);
  if (hit !== undefined) return hit;
  let res = await safeFetch(url, { ...opts, method: "HEAD" });
  if (res.status === 405 || res.status === 501 || res.status === 403 || !res.headers["content-type"]) {
    res = await safeFetch(url, {
      ...opts,
      method: "GET",
      headers: { range: "bytes=0-0" },
      readBody: () => false,
    });
  }
  const out = res.status < 400 ? classifyType(res.headers["content-type"]) : null;
  if (opts.cache !== false) probeCache.set(cacheKey, out);
  return out;
}

module.exports = {
  safeFetch,
  probeType,
  classifyType,
  isBlockedAddress,
  createLru,
  FetchError,
  USER_AGENT,
  MAX_BYTES,
  TIMEOUT_MS,
};
