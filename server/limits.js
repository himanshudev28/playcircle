// Input hygiene and rate limiting for socket events. Nothing a client sends
// is trusted: every handler goes through `safe()` so a malformed payload can
// never throw inside the server, and noisy events go through a token bucket.

// Per-socket token buckets, keyed by event. `allow("chat", 6, 8000)` means
// at most 6 in any 8 seconds, refilled smoothly.
function createLimiter() {
  const buckets = new Map();
  return function allow(key, max, perMs) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: max, at: now };
      buckets.set(key, b);
    }
    b.tokens = Math.min(max, b.tokens + ((now - b.at) * max) / perMs);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

// Server-wide token buckets, shared by every connection (so reconnecting
// doesn't buy a fresh allowance). Keys are free-form, e.g. "pw-room:ABC".
// sweep() forgets buckets that have refilled, so the map stays small.
function createSharedLimiter() {
  const buckets = new Map();
  function refill(b, now) {
    b.tokens = Math.min(b.max, b.tokens + ((now - b.at) * b.max) / b.perMs);
    b.at = now;
  }
  return {
    allow(key, max, perMs) {
      const now = Date.now();
      let b = buckets.get(key);
      if (!b) {
        b = { tokens: max, at: now, max, perMs };
        buckets.set(key, b);
      }
      refill(b, now);
      if (b.tokens < 1) return false;
      b.tokens -= 1;
      return true;
    },
    sweep() {
      const now = Date.now();
      for (const [key, b] of buckets) {
        refill(b, now);
        if (b.tokens >= b.max) buckets.delete(key);
      }
    },
    get size() {
      return buckets.size;
    },
  };
}

// Payloads are always objects; anything else becomes {}.
function obj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function str(v, max) {
  if (typeof v !== "string" && typeof v !== "number") return "";
  return String(v).slice(0, max).trim();
}

function num(v, min, max) {
  const n = typeof v === "number" ? v : Number.NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function oneOf(v, list) {
  return list.includes(v) ? v : null;
}

// Wrap a handler: normalise the payload, pass a callable ack, and swallow
// any exception (logged) instead of letting it take the process down. Async
// handlers are covered too: a rejected promise is caught the same way.
function safe(event, fn) {
  return (payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const fail = (err) => {
      console.error(`[socket] ${event} handler failed:`, err);
      reply({ ok: false });
    };
    try {
      const out = fn(obj(payload), reply);
      if (out && typeof out.then === "function") out.then(undefined, fail);
    } catch (err) {
      fail(err);
    }
  };
}

const ROOM_CODE = /^[A-Z0-9-]{2,20}$/;

module.exports = { createLimiter, createSharedLimiter, obj, str, num, oneOf, safe, ROOM_CODE };
