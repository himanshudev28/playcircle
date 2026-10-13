// Integration tests for the realtime server (server/realtime.js + friends).
// Each suite mounts attachRealtime() on a bare HTTP server on port 0 and
// talks to it with real socket.io-client connections.
//
// Run with: npm test   (sets OFFLINE_META=1 so nothing hits the network)

import { describe, test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.OFFLINE_META = "1";

const require = createRequire(import.meta.url);
const { Server } = require("socket.io");
const { io: ioClient } = require("socket.io-client");
const { attachRealtime, SOCKET_OPTIONS } = require("../server/realtime.js");

const FAST = {
  tickMs: 100,
  hostGraceMs: 200,
  leaveAnnounceMs: 50,
  companionGraceMs: 200,
  emptyRoomTtlMs: 200,
  restoredTtlMs: 5_000,
  saveEveryMs: 60_000,
  dataFile: null,
};

// Valid 11-char YouTube ids.
const V0 = "dQw4w9WgXcQ";
const V1 = "aaaaaaaaaa1";
const V2 = "bbbbbbbbbb2";
const V3 = "cccccccccc3";
const yt = (id) => ({ kind: "youtube", id });
const key = (id) => `yt:${id}`;

/* ---------------- helpers ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let codeSeq = 0;
function roomCode() {
  codeSeq += 1;
  return `T${codeSeq}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

async function startServer(options = {}) {
  const httpServer = http.createServer();
  const io = new Server(httpServer, SOCKET_OPTIONS);
  const rt = attachRealtime(io, { ...FAST, ...options });
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${httpServer.address().port}`;
  const clients = new Set();
  let stopped = false;

  return {
    url,
    io,
    rt,
    connect() {
      const sock = ioClient(url, {
        transports: ["websocket"],
        forceNew: true,
        reconnection: false,
      });
      clients.add(sock);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("connect timeout")), 3000);
        sock.once("connect", () => {
          clearTimeout(t);
          resolve(sock);
        });
        sock.once("connect_error", (err) => {
          clearTimeout(t);
          reject(err);
        });
      });
    },
    disconnectAll() {
      for (const c of clients) c.disconnect();
      clients.clear();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      rt.close(); // flushes while rooms still have their state
      for (const c of clients) c.disconnect();
      clients.clear();
      await new Promise((r) => io.close(() => r()));
    },
  };
}

// Resolve with the first `event` payload matching `predicate`; reject on timeout.
function once(sock, event, predicate = () => true, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      sock.off(event, handler);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeout);
    function handler(payload) {
      let ok = false;
      try {
        ok = predicate(payload);
      } catch {
        ok = false;
      }
      if (!ok) return;
      clearTimeout(t);
      sock.off(event, handler);
      resolve(payload);
    }
    sock.on(event, handler);
  });
}

// Resolve if no matching `event` arrives within `ms`; reject if one does.
function none(sock, event, predicate = () => true, ms = 300) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      sock.off(event, handler);
      resolve();
    }, ms);
    function handler(payload) {
      if (!predicate(payload)) return;
      clearTimeout(t);
      sock.off(event, handler);
      reject(new Error(`unexpected "${event}": ${JSON.stringify(payload)}`));
    }
    sock.on(event, handler);
  });
}

// Collect every payload of `event` into an array.
function record(sock, event) {
  const out = [];
  sock.on(event, (p) => out.push(p));
  return out;
}

function join(sock, { code, name = "Guest", clientId, ...extra }) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      reject(new Error(`join ${code} timed out`));
    }, 2000);
    function onState(st) {
      cleanup();
      resolve(st);
    }
    function onDenied(d) {
      cleanup();
      reject(new Error(`join ${code} denied: ${d?.reason}`));
    }
    function cleanup() {
      clearTimeout(t);
      sock.off("room:state", onState);
      sock.off("room:denied", onDenied);
    }
    sock.on("room:state", onState);
    sock.on("room:denied", onDenied);
    sock.emit("room:join", { code, name, clientId, ...extra });
  });
}

// Events from one socket are handled in order and synchronously, so an acked
// ping round-trip guarantees everything it sent before has been processed.
function ping(sock) {
  return sock.timeout(2000).emitWithAck("time:ping", {});
}

function ack(sock, event, payload) {
  return sock.timeout(2000).emitWithAck(event, payload);
}

// Collect every event (name + args) a socket receives.
function recordAll(sock) {
  const out = [];
  sock.onAny((event, ...args) => out.push({ event, args }));
  return out;
}

// No clientId (or a field named cid) anywhere in what clients were sent.
function assertNoIds(payloads, ids) {
  const json = JSON.stringify(payloads);
  for (const id of ids) assert.ok(!json.includes(id), `leaked ${id}`);
  assert.ok(!json.includes('"cid"'), "leaked a cid field");
}

/* ---------------- suites ---------------- */

describe("realtime", () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  afterEach(() => srv.disconnectAll());
  after(() => srv.stop());

  // Host + viewer in a fresh room.
  async function pair() {
    const code = roomCode();
    const host = await srv.connect();
    const hostState = await join(host, { code, name: "Host", clientId: `h-${code}` });
    const viewer = await srv.connect();
    const viewerState = await join(viewer, {
      code,
      name: "Viewer",
      clientId: `v-${code}`,
    });
    return { code, host, viewer, hostState, viewerState };
  }

  async function loadVideo(host, viewer, id) {
    const seen = once(viewer, "player:action", (a) => a.type === "load" && a.media?.id === id);
    host.emit("player:action", { type: "load", media: yt(id) });
    return seen;
  }

  /* 1 */
  describe("join & authority", () => {
    test("first joiner is owner and host", async () => {
      const { code, host, viewer, hostState, viewerState } = await pair();
      assert.equal(hostState.hostId, host.id);
      const me = hostState.users.find((u) => u.id === host.id);
      assert.equal(me.owner, true);
      assert.deepEqual(me.perms, { video: true, chat: true, call: true });

      assert.equal(viewerState.hostId, host.id);
      const v = viewerState.users.find((u) => u.id === viewer.id);
      assert.equal(v.owner, false);
      assert.equal(v.perms.video, false);
      // clientIds never leak to clients
      assert.ok(!JSON.stringify(viewerState).includes(`h-${code}`));
      assert.ok(!JSON.stringify(hostState).includes(`h-${code}`));
    });

    test("invalid room code is denied", async () => {
      const s = await srv.connect();
      const denied = once(s, "room:denied");
      s.emit("room:join", { code: "bad code!", name: "X", clientId: "x1" });
      assert.deepEqual(await denied, { reason: "invalid" });
    });
  });

  /* 2 */
  describe("playback permissions", () => {
    test("viewer play is refused with a denied snap-back", async () => {
      const { host, viewer } = await pair();
      const snap = once(viewer, "player:action", (a) => a.denied === true);
      const hostSees = none(host, "player:action");
      viewer.emit("player:action", { type: "play", time: 5, key: key(V0) });
      const a = await snap;
      assert.equal(a.type, "pause");
      assert.equal(a.isPlaying, false);
      await hostSees;
    });

    test("host load reaches everyone; play/seek/pause relay; stale key ignored", async () => {
      const { host, viewer } = await pair();

      const hostLoad = once(host, "player:action", (a) => a.type === "load");
      const viewerLoad = once(viewer, "player:action", (a) => a.type === "load");
      host.emit("player:action", { type: "load", media: yt(V0) });
      const [hl, vl] = await Promise.all([hostLoad, viewerLoad]);
      assert.equal(hl.media.id, V0);
      assert.equal(vl.media.id, V0);
      assert.equal(vl.isPlaying, true);
      assert.equal(vl.byId, host.id);

      const pause = once(viewer, "player:action", (a) => a.type === "pause");
      host.emit("player:action", { type: "pause", time: 3, key: key(V0) });
      const p = await pause;
      assert.equal(p.isPlaying, false);
      assert.equal(p.time, 3);

      const seek = once(viewer, "player:action", (a) => a.type === "seek");
      host.emit("player:action", { type: "seek", time: 42, key: key(V0) });
      assert.equal((await seek).time, 42);

      const play = once(viewer, "player:action", (a) => a.type === "play");
      // the actor doesn't get its own play/seek/pause echoed back
      const noEcho = none(host, "player:action", (a) => a.type === "play");
      host.emit("player:action", { type: "play", time: 10, key: key(V0) });
      const pl = await play;
      assert.equal(pl.isPlaying, true);
      assert.equal(pl.time, 10);
      await noEcho;

      // A play for some other video (stale key) or no key at all is dropped.
      const stale = none(viewer, "player:action");
      host.emit("player:action", { type: "pause", time: 1, key: key(V1) });
      host.emit("player:action", { type: "seek", time: 1 });
      await stale;

      // Viewer snap-back now reflects the room's real position.
      const snap = once(viewer, "player:action", (a) => a.denied);
      viewer.emit("player:action", { type: "pause", time: 0, key: key(V0) });
      const s = await snap;
      assert.equal(s.type, "play");
      assert.equal(s.media.id, V0);
      assert.ok(s.time >= 10 && s.time < 12, `snap-back time ${s.time}`);
    });

    test("viewer granted video perm can drive", async () => {
      const { host, viewer } = await pair();
      await loadVideo(host, viewer, V0);
      const notice = once(viewer, "room:notice");
      host.emit("host:perm", { targetId: viewer.id, perm: "video", value: true });
      await notice;
      const seen = once(host, "player:action", (a) => a.type === "seek");
      viewer.emit("player:action", { type: "seek", time: 7, key: key(V0) });
      assert.equal((await seen).time, 7);
    });
  });

  /* 3 */
  describe("sync heartbeat", () => {
    test("player:tick carries an advancing playhead while playing", async () => {
      const { host, viewer } = await pair();
      await loadVideo(host, viewer, V0);
      const first = await once(viewer, "player:tick", (t) => t.isPlaying);
      assert.equal(first.key, key(V0));
      assert.equal(typeof first.at, "number");
      const later = await once(
        viewer,
        "player:tick",
        (t) => t.isPlaying && t.at - first.at >= 300
      );
      const wall = (later.at - first.at) / 1000;
      const advanced = later.time - first.time;
      assert.ok(advanced > 0.25, `advanced ${advanced}`);
      assert.ok(Math.abs(advanced - wall) < 0.1, `advanced ${advanced} vs wall ${wall}`);

      // Paused: the playhead holds still.
      host.emit("player:action", { type: "pause", time: 5, key: key(V0) });
      const p1 = await once(viewer, "player:tick", (t) => !t.isPlaying);
      const p2 = await once(viewer, "player:tick", (t) => !t.isPlaying && t.at > p1.at);
      assert.equal(p1.time, 5);
      assert.equal(p2.time, 5);
    });
  });

  /* 3b */
  describe("duration", () => {
    test("a live-stream-sized duration is refused, not clamped", async () => {
      const { code, host, viewer } = await pair();
      await loadVideo(host, viewer, V0);
      const room = srv.rt.rooms.get(code);

      host.emit("player:meta", { key: key(V0), duration: 1e8 });
      host.emit("player:meta", { key: key(V0), duration: 86_400 });
      host.emit("player:meta", { key: key(V0), duration: "600" });
      await ping(host);
      assert.equal(room.duration, null);

      // Two viewers agreeing on a bogus length don't get it through either.
      const v2 = await srv.connect();
      await join(v2, { code, name: "V2", clientId: `v2-${code}` });
      viewer.emit("player:meta", { key: key(V0), duration: 1e8 });
      v2.emit("player:meta", { key: key(V0), duration: 1e8 });
      await Promise.all([ping(viewer), ping(v2)]);
      assert.equal(room.duration, null);

      // A real length still lands.
      host.emit("player:meta", { key: key(V0), duration: 600 });
      await ping(host);
      assert.equal(room.duration, 600);
    });

    test("replaying the same video keeps its duration, so it can end again", async () => {
      const { code, host, viewer } = await pair();
      await loadVideo(host, viewer, V0);
      const room = srv.rt.rooms.get(code);
      host.emit("player:meta", { key: key(V0), duration: 600 });

      // First run ends (nothing queued): rests at the end.
      const rested = once(viewer, "player:action", (a) => a.type === "pause" && a.time === 600);
      host.emit("player:ended", { key: key(V0) });
      await rested;

      // Play it again: same key, so the known length survives the reload.
      await loadVideo(host, viewer, V0);
      assert.equal(room.duration, 600);
      assert.equal(room.endedKey, null);
      assert.equal(room.time, 0);

      // Near the end, a viewer's "ended" is believed again and the queue moves.
      await ack(host, "queue:add", { media: yt(V1) });
      host.emit("player:action", { type: "seek", time: 598, key: key(V0) });
      await ping(host);
      const next = once(viewer, "player:action", (a) => a.type === "load" && a.media?.id === V1);
      viewer.emit("player:ended", { key: key(V0) });
      await next;

      // A different video starts with an unknown length.
      assert.equal(room.duration, null);
    });
  });

  /* 4 */
  describe("robustness", () => {
    test("garbage payloads never crash the server", async () => {
      const errors = [];
      const origError = console.error;
      console.error = (...args) => {
        errors.push(args.map(String).join(" "));
      };
      try {
        const { host, viewer } = await pair();
        // Every frame below must stay under maxHttpBufferSize (100kB), or the
        // server rightly drops the connection (tested separately below).
        const huge = "x".repeat(20_000);
        const payloads = [
          null,
          undefined,
          0,
          42,
          -1,
          NaN,
          true,
          "",
          "a string",
          huge,
          [],
          [1, 2, 3],
          [{ code: "ABC" }],
          {},
          { code: null, name: null, clientId: null },
          { code: 123, name: {}, clientId: [] },
          { code: huge, name: huge, clientId: huge, title: huge, isPublic: "yes" },
          { code: ["AB"], name: ["n"] },
          { type: "load" },
          { type: "load", media: null, input: huge },
          { type: "load", media: { kind: "youtube", id: huge } },
          { type: "load", media: { kind: "vimeo", id: 5 } },
          { type: "load", media: [] },
          { type: "play", key: [], time: "NaN" },
          { type: "seek", key: {}, time: Infinity },
          { type: ["play"] },
          { type: {} },
          { targetId: null },
          { targetId: {} },
          { targetId: ["x"] },
          { targetId: huge },
          { targetId: viewer.id, perm: "__proto__", value: true },
          { targetId: viewer.id, perm: ["chat"], value: {} },
          { targetId: viewer.id, perm: huge },
          { text: null },
          { text: {} },
          { text: [] },
          { text: huge },
          { media: null },
          { media: "dQw4w9WgXcQ" },
          { media: { kind: "youtube", id: {} } },
          { input: {} },
          { input: huge },
          { input: [] },
          { id: null },
          { id: {} },
          { id: huge },
          { id: [] },
          { __proto__: { polluted: true } },
          { constructor: { prototype: { polluted: true } } },
        ];
        const events = [
          "room:join",
          "player:action",
          "host:kick",
          "host:perm",
          "chat:message",
          "queue:add",
          "queue:vote",
          // a few more for good measure
          "queue:approve",
          "queue:remove",
          "queue:move",
          "queue:play",
          "player:meta",
          "player:ended",
          "host:settings",
          "host:transfer",
          "call:join",
          "call:signal",
          "call:state",
          "time:ping",
          "chat:react",
          "chat:pin",
          "chat:delete",
          "chat:report",
          "reaction:send",
          "poll:create",
          "poll:vote",
          "poll:close",
          "host:password",
          "stage:start",
          "stage:stop",
          "stage:want",
          "stage:signal",
          "stage:quality",
        ];
        // Both an admin and a plain viewer, each inside a room, so handlers
        // get past the "are you in a room?" check.
        for (const sock of [viewer, host]) {
          for (const ev of events) {
            for (const p of payloads) {
              sock.emit(ev, p);
              sock.emit(ev, p, () => {}); // with an ack
            }
            sock.emit(ev); // no payload at all
            sock.emit(ev, 1, 2, 3); // extra args
          }
        }

        // Everything sent above has been handled once these come back.
        // (A barrage `room:join` may have moved them; they're still connected.)
        const [a, b] = await Promise.all([ping(host), ping(viewer)]);
        assert.equal(typeof a.now, "number");
        assert.equal(typeof b.now, "number");

        // An oversized frame only costs that one socket its connection.
        const big = await srv.connect();
        const gone = once(big, "disconnect");
        big.emit("chat:message", { text: "y".repeat(200_000) });
        await gone;

        // The same server still serves fresh joins and clock pings.
        const fresh = await srv.connect();
        const code = roomCode();
        const st = await join(fresh, { code, name: "Fresh", clientId: "fresh-1" });
        assert.equal(st.hostId, fresh.id);
        const pong = await ping(fresh);
        assert.equal(typeof pong.now, "number");
        assert.ok(Math.abs(pong.now - Date.now()) < 1000);

        assert.equal(({}).polluted, undefined, "prototype pollution");
        const handlerErrors = errors.filter((e) => e.includes("handler failed"));
        assert.deepEqual(handlerErrors, [], "no handler threw");
      } finally {
        console.error = origError;
      }
    });
  });

  /* 5 */
  describe("rate limiting", () => {
    test("chat floods are trimmed and the sender is told", async () => {
      const { host, viewer } = await pair();
      const got = record(viewer, "chat:message");
      const notice = once(host, "room:notice", (t) => /too fast/i.test(t));
      for (let i = 0; i < 20; i++) host.emit("chat:message", { text: `msg ${i}` });
      await notice;
      await ping(host);
      await sleep(150);
      const mine = got.filter((m) => !m.system && m.text.startsWith("msg "));
      assert.ok(mine.length >= 6 && mine.length <= 7, `broadcast ${mine.length}`);
      assert.equal(mine[0].text, "msg 0");
    });
  });

  /* 6 */
  describe("queue", () => {
    const ids = (u) => u.items.map((i) => i.media.id);

    test("viewer suggestion waits for approval; viewer can't approve", async () => {
      const { code, host, viewer } = await pair();
      await loadVideo(host, viewer, V0);

      const update = once(host, "queue:update", (u) => ids(u).includes(V1));
      const notice = once(host, "room:notice", (t) => /suggested/.test(t));
      const res = await ack(viewer, "queue:add", { input: `https://youtu.be/${V1}` });
      assert.deepEqual(res, { ok: true, status: "pending" });
      const u = await update;
      const item = u.items.find((i) => i.media.id === V1);
      assert.equal(item.status, "pending");
      assert.equal(item.votes, 0);
      await notice;

      viewer.emit("queue:approve", { id: item.id });
      await ping(viewer);
      const room = srv.rt.rooms.get(code);
      assert.equal(room.queue.find((q) => q.id === item.id).status, "pending");

      const approved = once(
        viewer,
        "queue:update",
        (x) => x.items.find((i) => i.id === item.id)?.status === "ready"
      );
      host.emit("queue:approve", { id: item.id });
      const a = await approved;
      assert.equal(a.items.find((i) => i.id === item.id).votes, 1);
    });

    test("host add with nothing playing starts immediately", async () => {
      const { code, host, viewer } = await pair();
      const load = once(viewer, "player:action", (a) => a.type === "load");
      const emptied = once(viewer, "queue:update", (u) => u.items.length === 0);
      const res = await ack(host, "queue:add", { media: yt(V1) });
      assert.equal(res.ok, true);
      assert.equal(res.status, "ready");
      const a = await load;
      assert.equal(a.media.id, V1);
      assert.equal(a.isPlaying, true);
      await emptied;
      assert.equal(srv.rt.rooms.get(code).queue.length, 0);
    });


    test("votes reorder the queue (order: votes) and toggle", async () => {
      const { code, host, viewer } = await pair();
      await loadVideo(host, viewer, V0);
      const two = once(viewer, "queue:update", (u) => u.items.length === 2);
      await ack(host, "queue:add", { media: yt(V1) });
      await ack(host, "queue:add", { media: yt(V2) });
      const u0 = await two;
      assert.deepEqual(ids(u0), [V1, V2]);
      assert.equal(srv.rt.rooms.get(code).settings.order, "votes");
      const v2 = u0.items[1];
      assert.equal(v2.votes, 1);

      const up = once(viewer, "queue:update", (u) => ids(u)[0] === V2);
      viewer.emit("queue:vote", { id: v2.id });
      const u1 = await up;
      assert.deepEqual(ids(u1), [V2, V1]);
      assert.equal(u1.items[0].votes, 2);

      // Voting again takes the vote back; ties fall back to added order.
      const back = once(viewer, "queue:update", (u) => ids(u)[0] === V1);
      viewer.emit("queue:vote", { id: v2.id });
      const u2 = await back;
      assert.deepEqual(ids(u2), [V1, V2]);
      assert.equal(u2.items[1].votes, 1);

      // Manual order: votes no longer move things.
      const settings = once(viewer, "room:settings", (s) => s.order === "manual");
      host.emit("host:settings", { order: "manual" });
      await settings;
      const voted = once(viewer, "queue:update", (u) => u.items[1]?.votes === 2);
      viewer.emit("queue:vote", { id: v2.id });
      assert.deepEqual(ids(await voted), [V1, V2]);
    });

    test("skip: refused for viewers, host plays next ready item", async () => {
      const { code, host, viewer } = await pair();
      await loadVideo(host, viewer, V0);

      const empty = await ack(host, "queue:skip", {});
      assert.equal(empty.ok, false);

      await ack(host, "queue:add", { media: yt(V1) });
      await ack(host, "queue:add", { media: yt(V2) });

      const refused = await ack(viewer, "queue:skip", {});
      assert.equal(refused.ok, false);
      assert.equal(srv.rt.rooms.get(code).media.id, V0);

      const load = once(viewer, "player:action", (a) => a.type === "load");
      const update = once(viewer, "queue:update", (u) => !ids(u).includes(V1));
      const res = await ack(host, "queue:skip", {});
      assert.equal(res.ok, true);
      assert.equal((await load).media.id, V1);
      const u = await update;
      assert.deepEqual(ids(u), [V2]);
      assert.ok(u.history.some((h) => h.media.id === V0), "previous video in history");
    });

    test("auto-advance on end; autoplay off pauses instead", async () => {
      const { code, host, viewer } = await pair();
      await loadVideo(host, viewer, V0);
      await ack(host, "queue:add", { media: yt(V1) });

      const next = once(viewer, "player:action", (a) => a.type === "load");
      host.emit("player:meta", { key: key(V0), duration: 600 });
      host.emit("player:ended", { key: key(V0) });
      const a = await next;
      assert.equal(a.media.id, V1);
      assert.equal(a.isPlaying, true);

      const off = once(viewer, "room:settings", (s) => s.autoplay === false);
      host.emit("host:settings", { autoplay: false });
      await off;
      await ack(host, "queue:add", { media: yt(V2) });

      const pause = once(viewer, "player:action", (x) => x.type === "pause");
      const noLoad = none(viewer, "player:action", (x) => x.type === "load", 400);
      host.emit("player:meta", { key: key(V1), duration: 300 });
      host.emit("player:ended", { key: key(V1) });
      const p = await pause;
      assert.equal(p.isPlaying, false);
      assert.equal(p.media.id, V1);
      assert.equal(p.time, 300);
      await noLoad;
      assert.equal(srv.rt.rooms.get(code).queue.length, 1);
    });

    test("viewer ended before the room's clock agrees is ignored", async () => {
      const { code, host, viewer } = await pair();
      await loadVideo(host, viewer, V0);
      await ack(host, "queue:add", { media: yt(V1) });
      host.emit("player:meta", { key: key(V0), duration: 600 });
      await ping(host);
      viewer.emit("player:ended", { key: key(V0) });
      await ping(viewer);
      assert.equal(srv.rt.rooms.get(code).media.id, V0);
    });

    test("duplicate suggestion counts as a vote", async () => {
      const { code, host, viewer } = await pair();
      await loadVideo(host, viewer, V0);
      await ack(host, "queue:add", { media: yt(V1) });
      const voted = once(host, "queue:update", (u) => u.items[0]?.votes === 2);
      const res = await ack(viewer, "queue:add", { input: `https://www.youtube.com/watch?v=${V1}` });
      assert.deepEqual(res, { ok: true, duplicate: true, status: "ready" });
      const u = await voted;
      assert.equal(u.items.length, 1);
      assert.equal(srv.rt.rooms.get(code).queue.length, 1);

      // What's already on stage can't be queued.
      const playing = await ack(viewer, "queue:add", { media: yt(V0) });
      assert.equal(playing.ok, false);
    });

    test("someone whose chat was revoked can't add", async () => {
      const { code, host, viewer } = await pair();
      await loadVideo(host, viewer, V0);
      const notice = once(viewer, "room:notice", (t) => /chat/.test(t));
      host.emit("host:perm", { targetId: viewer.id, perm: "chat", value: false });
      await notice;
      const res = await ack(viewer, "queue:add", { media: yt(V3) });
      assert.equal(res.ok, false);
      assert.equal(typeof res.error, "string");
      assert.equal(srv.rt.rooms.get(code).queue.length, 0);

      // ...and can't chat either.
      const quiet = none(host, "chat:message", (m) => m.text === "hello?");
      viewer.emit("chat:message", { text: "hello?" });
      await quiet;
    });
  });

  /* 7 */
  describe("host grace & reclaim", () => {
    test("crown is held, then passed on, then reclaimed by the owner", async () => {
      const code = roomCode();
      const owner = await srv.connect();
      await join(owner, { code, name: "Owner", clientId: "owner-cid" });
      const other = await srv.connect();
      const st = await join(other, { code, name: "Other", clientId: "other-cid" });
      assert.equal(st.hostId, owner.id);

      const vacant = once(other, "room:host", (h) => h === null);
      const t0 = Date.now();
      owner.disconnect();
      await vacant;

      const announced = once(other, "chat:message", (m) => m.system && /is now the host/.test(m.text));
      const passed = await once(other, "room:host", (h) => h === other.id);
      const waited = Date.now() - t0;
      assert.equal(passed, other.id);
      assert.ok(waited >= 150, `crown passed after ${waited}ms (grace 200ms)`);
      await announced;

      // The owner comes back in a new socket with the same clientId.
      const back = once(other, "room:host", (h) => h && h !== other.id);
      const banner = once(other, "chat:message", (m) => m.system && /back in charge/.test(m.text));
      const owner2 = await srv.connect();
      const st2 = await join(owner2, { code, name: "Owner", clientId: "owner-cid" });
      assert.equal(st2.hostId, owner2.id);
      assert.equal(await back, owner2.id);
      await banner;
      assert.equal(st2.users.find((u) => u.id === owner2.id).owner, true);
    });

    test("a host who comes back within the grace keeps the crown", async () => {
      const code = roomCode();
      const owner = await srv.connect();
      await join(owner, { code, name: "Owner", clientId: "o2-cid" });
      const host = await srv.connect();
      await join(host, { code, name: "Host", clientId: "h2-cid" });
      const given = once(owner, "room:host", (h) => h === host.id);
      owner.emit("host:transfer", { targetId: host.id });
      await given;
      // Owner leaves so the transfer sticks (the owner would reclaim on rejoin).
      owner.disconnect();
      const third = await srv.connect();
      await join(third, { code, name: "Third", clientId: "t2-cid" });

      const vacant = once(third, "room:host", (h) => h === null);
      host.disconnect();
      await vacant;
      const host2 = await srv.connect();
      const st = await join(host2, { code, name: "Host", clientId: "h2-cid" });
      assert.equal(st.hostId, host2.id);
      await sleep(300); // past the grace: the crown must not move to Third
      assert.equal(srv.rt.rooms.get(code).hostId, host2.id);
    });

    test("when a stand-in host leaves, the crown goes straight back to the owner", async () => {
      const code = roomCode();
      const owner = await srv.connect();
      await join(owner, { code, name: "Owner", clientId: `o3-${code}` });
      const b = await srv.connect();
      await join(b, { code, name: "Bee", clientId: `b3-${code}` });
      const c = await srv.connect();
      await join(c, { code, name: "Cee", clientId: `c3-${code}` });

      const given = once(c, "room:host", (h) => h === b.id);
      owner.emit("host:transfer", { targetId: b.id });
      await given;

      // No vacant crown in between, and no grace wait.
      const noVacancy = none(c, "room:host", (h) => h === null, 150);
      const banner = once(c, "chat:message", (m) => m.system && /Owner \(room creator\) is the host again/.test(m.text));
      const t0 = Date.now();
      const back = once(c, "room:host", (h) => h === owner.id);
      b.disconnect();
      await back;
      assert.ok(Date.now() - t0 < 150, `owner got the crown after ${Date.now() - t0}ms`);
      await banner;
      await noVacancy;
      assert.equal(srv.rt.rooms.get(code).hostId, owner.id);

      // Same when the owner kicks the host they appointed.
      const toC = once(owner, "room:host", (h) => h === c.id);
      owner.emit("host:transfer", { targetId: c.id });
      await toC;
      const again = once(owner, "room:host", (h) => h === owner.id);
      owner.emit("host:kick", { targetId: c.id });
      await again;
      assert.equal(srv.rt.rooms.get(code).hostId, owner.id);
    });
  });

  /* 9 */
  describe("chat extras", () => {
    test("replies, announcements and browser tags; clientIds never leak", async () => {
      const { code, host, viewer, hostState, viewerState } = await pair();
      const seen = recordAll(viewer);
      const seenByHost = recordAll(host);

      const first = once(viewer, "chat:message", (m) => m.text === "hello");
      host.emit("chat:message", { text: "hello" });
      const hello = await first;
      assert.equal(hello.browser, hostState.selfBrowser);
      assert.equal(hello.name, "Host");
      assert.equal(hello.announce, undefined);

      // A viewer's reply quotes the parent; their "announce" is ignored.
      const reply = once(host, "chat:message", (m) => m.text === "hi back");
      viewer.emit("chat:message", { text: "hi back", replyTo: hello.id, announce: true });
      const r = await reply;
      assert.deepEqual(r.replyTo, { id: hello.id, name: "Host", text: "hello" });
      assert.equal(r.announce, undefined);
      assert.equal(r.browser, viewerState.selfBrowser);

      // The host's announcement is flagged; a reply to nothing is a plain line.
      const ann = once(viewer, "chat:message", (m) => m.text === "listen up");
      host.emit("chat:message", { text: "listen up", announce: true, replyTo: "nope" });
      const a = await ann;
      assert.equal(a.announce, true);
      assert.equal(a.replyTo, undefined);

      // Reactions and a pin, so every message shape goes over the wire.
      const upd = once(viewer, "chat:update", (m) => m.id === hello.id);
      viewer.emit("chat:react", { id: hello.id, emoji: "👍" });
      await upd;
      const pin = once(viewer, "chat:pinned", (m) => m?.id === hello.id);
      host.emit("chat:pin", { id: hello.id });
      await pin;

      // A later joiner's snapshot carries tags, not ids, too.
      const third = await srv.connect();
      const st = await join(third, { code, name: "Third", clientId: `t-${code}` });
      const fromHost = st.messages.find((m) => m.id === hello.id);
      assert.equal(fromHost.browser, hostState.selfBrowser);
      assert.equal(st.pinned.id, hello.id);

      await Promise.all([ping(host), ping(viewer)]);
      for (const payloads of [seen, seenByHost, [st]]) {
        assertNoIds(payloads, [`h-${code}`, `v-${code}`, `t-${code}`]);
      }
      // Stored server-side with the sender, for "delete your own".
      const room = srv.rt.rooms.get(code);
      assert.equal(room.messages.find((m) => m.id === hello.id).cid, `h-${code}`);
    });

    test("reactions toggle per browser and map to browser tags", async () => {
      const { host, viewer, hostState, viewerState } = await pair();
      const sys = viewerState.messages.find((m) => m.system);
      const sent = once(viewer, "chat:message", (m) => m.text === "react to me");
      host.emit("chat:message", { text: "react to me" });
      const msg = await sent;

      const u1 = once(host, "chat:update", (m) => m.reactions?.["👍"]?.length === 1);
      viewer.emit("chat:react", { id: msg.id, emoji: "👍" });
      assert.deepEqual((await u1).reactions, { "👍": [viewerState.selfBrowser] });

      const u2 = once(host, "chat:update", (m) => m.reactions?.["👍"]?.length === 2);
      host.emit("chat:react", { id: msg.id, emoji: "👍" });
      assert.deepEqual(
        [...(await u2).reactions["👍"]].sort(),
        [hostState.selfBrowser, viewerState.selfBrowser].sort()
      );

      // Again = take it back.
      const u3 = once(host, "chat:update", (m) => m.reactions?.["👍"]?.length === 1);
      viewer.emit("chat:react", { id: msg.id, emoji: "👍" });
      assert.deepEqual((await u3).reactions, { "👍": [hostState.selfBrowser] });

      // Off-list emoji, unknown messages and system lines are ignored.
      const quiet = none(host, "chat:update");
      viewer.emit("chat:react", { id: msg.id, emoji: "💩" });
      viewer.emit("chat:react", { id: "nope", emoji: "👍" });
      viewer.emit("chat:react", { id: sys.id, emoji: "👍" });
      await quiet;
    });

    test("pin is admin-only; delete is admin or author; replies stop quoting", async () => {
      const { code, host, viewer } = await pair();
      const hm = once(viewer, "chat:message", (m) => m.text === "host line");
      host.emit("chat:message", { text: "host line" });
      const hostMsg = await hm;
      const vm = once(host, "chat:message", (m) => m.text === "viewer line");
      viewer.emit("chat:message", { text: "viewer line" });
      const viewerMsg = await vm;
      const rp = once(host, "chat:message", (m) => m.text === "quoting");
      viewer.emit("chat:message", { text: "quoting", replyTo: viewerMsg.id });
      const quoting = await rp;

      // Viewers can't pin.
      const noPin = none(host, "chat:pinned");
      viewer.emit("chat:pin", { id: hostMsg.id });
      await noPin;

      const pinned = once(viewer, "chat:pinned", (m) => m?.id === viewerMsg.id);
      host.emit("chat:pin", { id: viewerMsg.id });
      assert.equal((await pinned).text, "viewer line");
      assert.equal(srv.rt.rooms.get(code).pinnedId, viewerMsg.id);

      // A viewer can't delete someone else's message...
      const kept = none(host, "chat:removed");
      viewer.emit("chat:delete", { id: hostMsg.id });
      await kept;

      // ...but the host can delete theirs, which also unpins it and scrubs
      // the quote out of replies.
      const removed = once(viewer, "chat:removed", (id) => id === viewerMsg.id);
      const unpinned = once(viewer, "chat:pinned", (m) => m === null);
      const scrubbed = once(viewer, "chat:update", (m) => m.id === quoting.id);
      host.emit("chat:delete", { id: viewerMsg.id });
      await Promise.all([removed, unpinned]);
      assert.equal((await scrubbed).replyTo.text, "Message deleted");

      // Authors can delete their own.
      const own = once(host, "chat:removed", (id) => id === quoting.id);
      viewer.emit("chat:delete", { id: quoting.id });
      await own;

      const room = srv.rt.rooms.get(code);
      assert.equal(room.pinnedId, null);
      assert.ok(!room.messages.some((m) => m.id === viewerMsg.id || m.id === quoting.id));
      assert.ok(room.messages.some((m) => m.id === hostMsg.id));
    });

    test("reports reach the admins; you can't report yourself", async () => {
      const { host, viewer, viewerState } = await pair();
      const sys = viewerState.messages.find((m) => m.system);
      const hm = once(viewer, "chat:message", (m) => m.text === "rude");
      host.emit("chat:message", { text: "rude" });
      const msg = await hm;
      const vm = once(host, "chat:message", (m) => m.text === "mine");
      viewer.emit("chat:message", { text: "mine" });
      const mine = await vm;

      const origWarn = console.warn;
      console.warn = () => {};
      try {
        const notice = once(host, "room:notice", (t) => /Viewer reported a message from Host: spam/.test(t));
        const noViewerNotice = none(viewer, "room:notice", (t) => /reported/.test(t));
        const res = await ack(viewer, "chat:report", { id: msg.id, reason: "spam" });
        assert.equal(res.ok, true);
        await notice;
        await noViewerNotice;

        const self = await ack(viewer, "chat:report", { id: mine.id });
        assert.equal(self.ok, false);
        assert.equal((await ack(viewer, "chat:report", { id: sys.id })).ok, false);
        assert.equal((await ack(viewer, "chat:report", { id: "nope" })).ok, false);
      } finally {
        console.warn = origWarn;
      }
    });

    test("a pin goes when its message falls out of the buffer", async () => {
      const { code, host, viewer } = await pair();
      const sent = once(viewer, "chat:message", (m) => m.text === "pin me");
      host.emit("chat:message", { text: "pin me" });
      const msg = await sent;
      const pin = once(viewer, "chat:pinned", (m) => m?.id === msg.id);
      host.emit("chat:pin", { id: msg.id });
      await pin;

      // Make the pinned message the oldest of a full buffer (200), so the
      // next line pushes it out.
      const room = srv.rt.rooms.get(code);
      const stored = room.messages.find((m) => m.id === msg.id);
      const filler = Array.from({ length: 199 }, (_, i) => ({
        id: `fill-${i}`,
        system: true,
        text: `filler ${i}`,
        ts: Date.now(),
      }));
      room.messages = [stored, ...filler];

      const unpinned = once(viewer, "chat:pinned", (m) => m === null);
      host.emit("chat:message", { text: "one more" });
      await unpinned;
      assert.equal(room.pinnedId, null);
      assert.equal(room.messages.length, 200);
      assert.ok(!room.messages.some((m) => m.id === msg.id));
      const st = await join(await srv.connect(), { code, name: "Late", clientId: `l-${code}` });
      assert.equal(st.pinned, null);
    });

    test("evicting an unpinned message leaves the pin alone", async () => {
      const { code, host, viewer } = await pair();
      const sent = once(viewer, "chat:message", (m) => m.text === "keep me");
      host.emit("chat:message", { text: "keep me" });
      const msg = await sent;
      const pin = once(viewer, "chat:pinned", (m) => m?.id === msg.id);
      host.emit("chat:pin", { id: msg.id });
      await pin;
      const room = srv.rt.rooms.get(code);
      const stored = room.messages.find((m) => m.id === msg.id);
      const filler = Array.from({ length: 199 }, (_, i) => ({
        id: `fill-${i}`,
        system: true,
        text: `filler ${i}`,
        ts: Date.now(),
      }));
      room.messages = [...filler, stored];
      const stays = none(viewer, "chat:pinned");
      host.emit("chat:message", { text: "one more" });
      await stays;
      assert.equal(room.pinnedId, msg.id);
    });
  });

  /* 10 */
  describe("live reactions & moments", () => {
    test("moments are recorded for YouTube only and reset when the stage changes", async () => {
      const { code, host, viewer } = await pair();
      const room = srv.rt.rooms.get(code);

      // Nothing playing: it floats by, untimed, and isn't kept.
      const r0 = once(host, "reaction", (r) => r.emoji === "🔥");
      viewer.emit("reaction:send", { emoji: "🔥" });
      const first = await r0;
      assert.equal(first.t, null);
      assert.equal(first.name, "Viewer");
      assert.equal(first.byId, viewer.id);
      assert.equal(room.moments.list.length, 0);

      // Off-list emoji are ignored.
      const quiet = none(host, "reaction");
      viewer.emit("reaction:send", { emoji: "💩" });
      viewer.emit("reaction:send", { emoji: ["🔥"] });
      await quiet;

      await loadVideo(host, viewer, V0);
      host.emit("player:action", { type: "seek", time: 42, key: key(V0) });
      await ping(host);
      const r1 = once(host, "reaction", (r) => r.emoji === "🎉");
      viewer.emit("reaction:send", { emoji: "🎉" });
      const timed = await r1;
      assert.ok(timed.t >= 42 && timed.t < 44, `t ${timed.t}`);
      assert.equal(room.moments.key, key(V0));
      assert.deepEqual(room.moments.list.map((m) => m.e), ["🎉"]);

      // A late joiner gets the timeline in the snapshot.
      const third = await srv.connect();
      const st = await join(third, { code, name: "Third", clientId: `t-${code}` });
      assert.deepEqual(st.moments.map((m) => m.e), ["🎉"]);

      // New video: fresh timeline.
      await loadVideo(host, viewer, V1);
      assert.equal(room.moments.key, key(V1));
      assert.deepEqual(room.moments.list, []);

      // A live share has no timeline: untimed again, nothing kept.
      const started = await ack(host, "stage:start", { source: "tab" });
      assert.equal(started.ok, true);
      const r2 = once(viewer, "reaction", (r) => r.emoji === "😂");
      host.emit("reaction:send", { emoji: "😂" });
      assert.equal((await r2).t, null);
      assert.deepEqual(room.moments.list, []);
      const st2 = await join(await srv.connect(), { code, name: "Fourth", clientId: `f-${code}` });
      assert.deepEqual(st2.moments, []);
    });
  });

  /* 11 */
  describe("polls", () => {
    test("custom: admin-only, one at a time, votes change, close announces the result", async () => {
      const { code, host, viewer, viewerState } = await pair();

      const denied = await ack(viewer, "poll:create", {
        kind: "custom",
        question: "Pizza?",
        options: ["Yes", "No"],
      });
      assert.equal(denied.ok, false);
      const tooFew = await ack(host, "poll:create", { kind: "custom", options: ["Only"] });
      assert.equal(tooFew.ok, false);
      const tooMany = await ack(host, "poll:create", {
        kind: "custom",
        options: ["1", "2", "3", "4", "5", "6", "7"],
      });
      assert.equal(tooMany.ok, false);

      const started = once(viewer, "poll:update", (p) => p?.kind === "custom");
      const line = once(viewer, "chat:message", (m) => m.system && /started a poll: Snack\?/.test(m.text));
      const res = await ack(host, "poll:create", {
        kind: "custom",
        question: "Snack?",
        options: ["Chips", "Popcorn", "Popcorn"],
        seconds: 30,
      });
      assert.equal(res.ok, true);
      const poll = await started;
      await line;
      assert.equal(poll.question, "Snack?");
      assert.deepEqual(poll.options.map((o) => o.label), ["Chips", "Popcorn"]);
      assert.equal(poll.binding, false);
      assert.equal(poll.needed, null);
      assert.ok(poll.endsAt - Date.now() > 25_000);

      const busy = await ack(host, "poll:create", { kind: "custom", options: ["a", "b"] });
      assert.equal(busy.ok, false);
      assert.match(busy.error, /already/);

      // Late joiners see the running poll.
      const st = await join(await srv.connect(), { code, name: "Third", clientId: `t-${code}` });
      assert.equal(st.poll.id, poll.id);

      const v1 = once(host, "poll:update", (p) => p?.total === 1);
      viewer.emit("poll:vote", { id: poll.id, option: 1 });
      const after1 = await v1;
      assert.deepEqual(after1.voters, [viewerState.selfBrowser]);
      assert.deepEqual(after1.options.map((o) => o.count), [0, 1]);

      host.emit("poll:vote", { id: poll.id, option: 0 });
      const changed = once(viewer, "poll:update", (p) => p?.options[1].count === 2);
      host.emit("poll:vote", { id: poll.id, option: 1 });
      const after2 = await changed;
      assert.equal(after2.total, 2);
      // Bad votes are dropped.
      viewer.emit("poll:vote", { id: poll.id, option: 5 });
      viewer.emit("poll:vote", { id: poll.id, option: "0" });
      viewer.emit("poll:vote", { id: "other", option: 0 });

      // Viewers can't close it.
      const stillOpen = none(host, "poll:closed");
      viewer.emit("poll:close", { id: poll.id });
      await stillOpen;

      const closed = once(viewer, "poll:closed");
      const result = once(viewer, "chat:message", (m) => m.system && /Snack\?.*→ Popcorn/.test(m.text));
      host.emit("poll:close", { id: poll.id });
      const c = await closed;
      assert.equal(c.winner, 1);
      assert.equal(c.cancelled, false);
      assert.equal(c.passed, false);
      assert.deepEqual(c.poll.options.map((o) => o.count), [0, 2]);
      await result;
      assert.equal(srv.rt.rooms.get(code).poll, null);
    });

    test("skip: a majority passes early and plays next; voteSkip off blocks viewers", async () => {
      const { code, host, viewer } = await pair();
      await loadVideo(host, viewer, V0);

      // Nothing queued: nothing to skip to.
      const nothing = await ack(viewer, "poll:create", { kind: "skip" });
      assert.equal(nothing.ok, false);

      await ack(host, "queue:add", { media: yt(V1) });
      const started = once(host, "poll:update", (p) => p?.kind === "skip");
      const res = await ack(viewer, "poll:create", { kind: "skip" });
      assert.equal(res.ok, true);
      const poll = await started;
      assert.equal(poll.binding, true);
      assert.equal(poll.needed, 2);
      // Calling the vote is a yes.
      assert.deepEqual(poll.options.map((o) => o.count), [1, 0]);

      const closed = once(viewer, "poll:closed");
      const next = once(viewer, "player:action", (a) => a.type === "load" && a.media?.id === V1);
      host.emit("poll:vote", { id: poll.id, option: 0 });
      const c = await closed;
      assert.equal(c.passed, true);
      assert.equal(c.winner, 0);
      await next;
      assert.equal(srv.rt.rooms.get(code).media.id, V1);

      // The creator turns skip votes off: viewers can't call one any more.
      await ack(host, "queue:add", { media: yt(V2) });
      const off = once(viewer, "room:settings", (s) => s.voteSkip === false);
      host.emit("host:settings", { voteSkip: false });
      await off;
      const blocked = await ack(viewer, "poll:create", { kind: "skip" });
      assert.equal(blocked.ok, false);
      assert.equal(srv.rt.rooms.get(code).poll, null);

      // A skip vote is about one video: changing it cancels the vote.
      const again = await ack(host, "poll:create", { kind: "skip" });
      assert.equal(again.ok, true);
      const cancelled = once(viewer, "poll:closed", (x) => x.cancelled);
      host.emit("player:action", { type: "load", media: yt(V3) });
      const x = await cancelled;
      assert.equal(x.passed, false);
      assert.equal(srv.rt.rooms.get(code).poll, null);
    });

    test("replay: passing seeks everyone back to 0", async () => {
      const { code, host, viewer } = await pair();
      await loadVideo(host, viewer, V0);
      host.emit("player:action", { type: "seek", time: 100, key: key(V0) });
      await ping(host);

      const started = once(viewer, "poll:update", (p) => p?.kind === "replay");
      assert.equal((await ack(host, "poll:create", { kind: "replay" })).ok, true);
      const poll = await started;

      const seek = once(host, "player:action", (a) => a.type === "seek" && a.time === 0);
      viewer.emit("poll:vote", { id: poll.id, option: 0 });
      const s = await seek;
      assert.equal(s.isPlaying, true);
      assert.equal(s.media.id, V0);
      const room = srv.rt.rooms.get(code);
      assert.ok(room.time === 0 && room.isPlaying);
    });

    test("next + binding: the winner is flagged next and plays next", async () => {
      const { code, host, viewer } = await pair();
      await loadVideo(host, viewer, V0);
      await ack(host, "queue:add", { media: yt(V1) });
      await ack(host, "queue:add", { media: yt(V2) });
      await ack(host, "queue:add", { media: yt(V3) });
      const room = srv.rt.rooms.get(code);
      const id = (v) => room.queue.find((q) => q.media.id === v).id;

      // V1 has the most votes, so without the poll it would play next.
      viewer.emit("queue:vote", { id: id(V1) });
      await ping(viewer);

      const viewerTry = await ack(viewer, "poll:create", { kind: "next", itemIds: [id(V2), id(V3)] });
      assert.equal(viewerTry.ok, false);
      const one = await ack(host, "poll:create", { kind: "next", itemIds: [id(V2), "nope"] });
      assert.equal(one.ok, false);

      const started = once(viewer, "poll:update", (p) => p?.kind === "next");
      const res = await ack(host, "poll:create", {
        kind: "next",
        itemIds: [id(V2), id(V3)],
        binding: true,
      });
      assert.equal(res.ok, true);
      const poll = await started;
      assert.equal(poll.binding, true);
      assert.deepEqual(poll.options.map((o) => o.ref), [id(V2), id(V3)]);

      viewer.emit("poll:vote", { id: poll.id, option: 1 });
      host.emit("poll:vote", { id: poll.id, option: 1 });
      await Promise.all([ping(viewer), ping(host)]);

      const flagged = once(viewer, "queue:update", (u) => u.items[0]?.next === true);
      const closed = once(viewer, "poll:closed");
      host.emit("poll:close", { id: poll.id });
      assert.equal((await closed).winner, 1);
      const u = await flagged;
      assert.equal(u.items[0].media.id, V3);
      assert.deepEqual(u.items.map((i) => i.next), [true, false, false]);

      const load = once(viewer, "player:action", (a) => a.type === "load");
      assert.equal((await ack(host, "queue:skip", {})).ok, true);
      assert.equal((await load).media.id, V3);
    });

    test("vote-and-leave doesn't count; coming back, you can vote again", async () => {
      const { code, host, viewer } = await pair();
      await loadVideo(host, viewer, V0);
      await ack(host, "queue:add", { media: yt(V1) });
      const room = srv.rt.rooms.get(code);

      // The viewer calls a skip (their yes), then leaves.
      const started = once(host, "poll:update", (p) => p?.kind === "skip");
      assert.equal((await ack(viewer, "poll:create", { kind: "skip" })).ok, true);
      const poll = await started;
      assert.equal(poll.needed, 2);

      // Alone, the host is a majority of one, but the departed yes isn't
      // theirs to count: no binding skip happens.
      const notClosed = none(host, "poll:closed", () => true, 300);
      const noSkip = none(host, "player:action", (a) => a.type === "load", 300);
      const shrunk = once(host, "poll:update", (p) => p?.id === poll.id && p.needed === 1);
      viewer.disconnect();
      const u = await shrunk;
      assert.equal(u.total, 0);
      assert.deepEqual(u.options.map((o) => o.count), [0, 0]);
      assert.deepEqual(u.voters, []);
      await Promise.all([notClosed, noSkip]);
      assert.equal(room.poll.id, poll.id);
      assert.equal(room.media.id, V0);

      // Back again (same browser): they can vote normally.
      const back = await srv.connect();
      const st = await join(back, { code, name: "Viewer", clientId: `v-${code}` });
      assert.equal(st.poll.id, poll.id);
      const changed = once(host, "poll:update", (p) => p?.options[1].count === 1);
      back.emit("poll:vote", { id: poll.id, option: 1 });
      await changed;
      const closed = once(back, "poll:closed");
      host.emit("poll:vote", { id: poll.id, option: 1 });
      const c = await closed;
      assert.equal(c.passed, false);
      assert.equal(room.media.id, V0);
    });
  });

  /* 12 */
  describe("live sharing", () => {
    test("needs video perm; start puts live media on stage, with no ticks", async () => {
      const { code, host, viewer } = await pair();
      const refused = await ack(viewer, "stage:start", { source: "screen" });
      assert.equal(refused.ok, false);
      assert.equal((await ack(host, "stage:start", { source: "laser" })).ok, false);

      const load = once(viewer, "player:action", (a) => a.type === "load" && a.media?.kind === "live");
      const res = await ack(host, "stage:start", { source: "tab" });
      assert.equal(res.ok, true);
      assert.equal(typeof res.streamId, "string");
      const a = await load;
      assert.deepEqual(a.media, {
        kind: "live",
        source: "tab",
        streamId: res.streamId,
        presenter: host.id,
        title: "Shared tab",
        by: "Host",
      });
      assert.equal(srv.rt.rooms.get(code).media.streamId, res.streamId);
      await none(viewer, "player:tick", () => true, 350);

      // A client can't put a live share on stage through player:action.
      const notice = once(host, "room:notice");
      host.emit("player:action", {
        type: "load",
        media: { kind: "live", source: "tab", streamId: "x", presenter: host.id },
      });
      await notice;
      assert.equal(srv.rt.rooms.get(code).media.streamId, res.streamId);

      // Snapshots carry it.
      const st = await join(await srv.connect(), { code, name: "Third", clientId: `t-${code}` });
      assert.equal(st.media.kind, "live");
    });

    test("want / signal / quality relay only presenter ↔ viewer with the right streamId", async () => {
      const { code, host, viewer } = await pair();
      const other = await srv.connect();
      await join(other, { code, name: "Other", clientId: `o-${code}` });
      const { streamId } = await ack(host, "stage:start", { source: "screen", title: "Slides" });

      const wanted = once(host, "stage:viewer");
      viewer.emit("stage:want", { streamId: "stale" });
      viewer.emit("stage:want", { streamId });
      assert.deepEqual(await wanted, { id: viewer.id, streamId });

      // Presenter → viewer, relayed exactly as sent: the client's own extra
      // fields (e.g. its negotiation counter `n`) must survive.
      const offer = once(viewer, "stage:signal");
      const otherQuiet = none(other, "stage:signal");
      const data = { sdp: { type: "offer", sdp: "v=0" }, n: 3, extra: { any: ["thing"] } };
      host.emit("stage:signal", { to: viewer.id, streamId, data });
      assert.deepEqual(await offer, { from: host.id, streamId, data });

      // Not a plain object, or far too big: dropped.
      const dropped = none(viewer, "stage:signal");
      host.emit("stage:signal", { to: viewer.id, streamId, data: "v=0" });
      host.emit("stage:signal", { to: viewer.id, streamId, data: [1, 2] });
      host.emit("stage:signal", { to: viewer.id, streamId, data: { sdp: "x".repeat(40_000) } });
      await dropped;

      // Viewer → presenter is fine.
      const answer = once(host, "stage:signal");
      viewer.emit("stage:signal", { to: host.id, streamId, data: { candidate: { candidate: "c" } } });
      assert.equal((await answer).from, viewer.id);

      // Viewer → viewer, and anything with a stale streamId, goes nowhere.
      const hostQuiet = none(host, "stage:signal");
      viewer.emit("stage:signal", { to: other.id, streamId, data: { sdp: { type: "offer" } } });
      host.emit("stage:signal", { to: other.id, streamId: "stale", data: { sdp: {} } });
      other.emit("stage:signal", { to: host.id, streamId: "stale", data: { sdp: {} } });
      await Promise.all([otherQuiet, hostQuiet]);

      const quality = once(host, "stage:quality");
      viewer.emit("stage:quality", { streamId, level: "4k" });
      viewer.emit("stage:quality", { streamId, level: "720" });
      assert.deepEqual(await quality, { id: viewer.id, streamId, level: "720" });

      // A viewer leaving tells the presenter.
      const left = once(host, "stage:viewer-left");
      const viewerId = viewer.id; // cleared on the client once disconnected
      viewer.disconnect();
      assert.deepEqual(await left, { id: viewerId, streamId });
      assert.equal(srv.rt.rooms.get(code).media.streamId, streamId);
    });

    test("presenter disconnect or losing video perm ends the share", async () => {
      const { code, host, viewer } = await pair();
      const room = srv.rt.rooms.get(code);
      const granted = once(viewer, "room:notice");
      host.emit("host:perm", { targetId: viewer.id, perm: "video", value: true });
      await granted;

      const first = await ack(viewer, "stage:start", { source: "file" });
      assert.equal(first.ok, true);
      assert.equal(room.media.presenter, viewer.id);

      // Host takes video control back: share ends.
      const cleared = once(host, "player:action", (a) => a.type === "load" && a.media === null);
      const told = once(viewer, "room:notice", (t) => /share ended/.test(t));
      host.emit("host:perm", { targetId: viewer.id, perm: "video", value: false });
      await Promise.all([cleared, told]);
      assert.equal(room.media, null);

      // Again, and this time the presenter just drops.
      host.emit("host:perm", { targetId: viewer.id, perm: "video", value: true });
      await ping(host);
      const second = await ack(viewer, "stage:start", { source: "screen" });
      assert.equal(second.ok, true);
      const ended = once(host, "player:action", (a) => a.type === "load" && a.media === null);
      const line = once(host, "chat:message", (m) => m.system && /Viewer stopped sharing/.test(m.text));
      viewer.disconnect();
      await Promise.all([ended, line]);
      assert.equal(room.media, null);
      // Live shares never go into history.
      assert.ok(room.history.every((h) => h.media.kind === "youtube"));
    });

    test("camera is a share source; unknown sources are refused", async () => {
      const { code, host } = await pair();
      const bad = await ack(host, "stage:start", { source: "webcam" });
      assert.equal(bad.ok, false);
      const res = await ack(host, "stage:start", { source: "camera" });
      assert.equal(res.ok, true);
      const media = srv.rt.rooms.get(code).media;
      assert.equal(media.source, "camera");
      assert.equal(media.title, "Live camera");
    });

    test("stage:stop: presenter or admin only", async () => {
      const { code, host, viewer } = await pair();
      const { streamId } = await ack(host, "stage:start", { source: "tab" });
      const kept = none(host, "player:action", (a) => a.media === null);
      viewer.emit("stage:stop", { streamId });
      await kept;
      const stopped = once(viewer, "player:action", (a) => a.type === "load" && a.media === null);
      host.emit("stage:stop", { streamId: "stale" });
      host.emit("stage:stop", { streamId });
      await stopped;
      assert.equal(srv.rt.rooms.get(code).media, null);
    });

    // Index of the first event matching, in what a socket received.
    const firstIndex = (events, name, pred = () => true) =>
      events.findIndex((e) => e.event === name && pred(e.args[0]));

    test("a kicked presenter's share ends, and they hear it before being removed", async () => {
      const { code, host, viewer } = await pair();
      const room = srv.rt.rooms.get(code);
      const granted = once(viewer, "room:notice");
      host.emit("host:perm", { targetId: viewer.id, perm: "video", value: true });
      await granted;
      assert.equal((await ack(viewer, "stage:start", { source: "screen" })).ok, true);

      const seen = recordAll(viewer);
      const cleared = once(host, "player:action", (a) => a.type === "load" && a.media === null);
      const line = once(host, "chat:message", (m) => m.system && /Viewer's share ended/.test(m.text));
      const denied = once(viewer, "room:denied");
      host.emit("host:kick", { targetId: viewer.id });
      assert.deepEqual(await denied, { reason: "removed" });
      await Promise.all([cleared, line]);
      assert.equal(room.media, null);

      const loadNull = firstIndex(seen, "player:action", (a) => a.type === "load" && a.media === null);
      const removed = firstIndex(seen, "room:denied");
      assert.ok(loadNull >= 0, "presenter was told the stage cleared");
      assert.ok(loadNull < removed, "…before room:denied");
    });

    test("a kicked viewer of someone else's share lets go of it first", async () => {
      const { code, host, viewer } = await pair();
      const { streamId } = await ack(host, "stage:start", { source: "tab" });
      const seen = recordAll(viewer);
      const denied = once(viewer, "room:denied");
      host.emit("host:kick", { targetId: viewer.id });
      await denied;
      const loadNull = firstIndex(seen, "player:action", (a) => a.type === "load" && a.media === null);
      assert.ok(loadNull >= 0 && loadNull < firstIndex(seen, "room:denied"));
      // The host's share carries on.
      assert.equal(srv.rt.rooms.get(code).media.streamId, streamId);
    });

    test("ending the room during a live share clears everyone's stage first", async () => {
      const { host, viewer } = await pair();
      assert.equal((await ack(host, "stage:start", { source: "tab" })).ok, true);
      const seenV = recordAll(viewer);
      const seenH = recordAll(host);
      const endedV = once(viewer, "room:denied", (d) => d.reason === "ended");
      const endedH = once(host, "room:denied", (d) => d.reason === "ended");
      host.emit("host:end");
      await Promise.all([endedV, endedH]);
      for (const seen of [seenV, seenH]) {
        const loadNull = firstIndex(seen, "player:action", (a) => a.type === "load" && a.media === null);
        assert.ok(loadNull >= 0, "told the share ended");
        assert.ok(loadNull < firstIndex(seen, "room:denied"), "…before room:denied");
      }
    });

    test("ending a room with a YouTube video on doesn't send a stage clear", async () => {
      const { host, viewer } = await pair();
      await loadVideo(host, viewer, V0);
      const noClear = none(viewer, "player:action", (a) => a.media === null);
      const ended = once(viewer, "room:denied", (d) => d.reason === "ended");
      host.emit("host:end");
      await ended;
      await noClear;
    });
  });

  /* 12b */
  describe("companion (Android app share link)", () => {
    test("only joins a room its person is in", async () => {
      const { code } = await pair();
      const app = await srv.connect();
      const denied = once(app, "room:denied");
      app.emit("room:join", { code, name: "Nobody", clientId: `x-${code}`, companion: true });
      assert.equal((await denied).reason, "missing");

      const fresh = roomCode();
      const denied2 = once(app, "room:denied");
      app.emit("room:join", { code: fresh, name: "Host", clientId: "x", companion: true });
      assert.equal((await denied2).reason, "missing");
      assert.equal(srv.rt.rooms.has(fresh), false);
    });

    test("hidden, never takes the crown, and shares with its person's rights", async () => {
      const { code, host, viewer } = await pair();
      const app = await srv.connect();
      const quietChat = none(viewer, "chat:message");
      const quietUsers = none(viewer, "room:users", (users) => users.length !== 2);
      const st = await join(app, { code, name: "Host", clientId: `h-${code}`, companion: true });
      await Promise.all([quietChat, quietUsers]);
      const room = srv.rt.rooms.get(code);
      assert.equal(room.hostId, host.id);
      assert.equal(st.users.length, 2);
      assert.ok(!st.users.some((u) => u.id === app.id));

      // The owner's companion may present; the stage names the person.
      const load = once(viewer, "player:action", (a) => a.media?.kind === "live");
      const res = await ack(app, "stage:start", { source: "screen", title: "Host's phone" });
      assert.equal(res.ok, true);
      const a = await load;
      assert.equal(a.media.presenter, app.id);
      assert.equal(a.media.by, "Host");

      // Viewers reach it like any presenter.
      const wanted = once(app, "stage:viewer");
      viewer.emit("stage:want", { streamId: res.streamId });
      assert.equal((await wanted).id, viewer.id);

      // Closing the app ends the share, quietly — no "left" line.
      const cleared = once(viewer, "player:action", (x) => x.type === "load" && x.media === null);
      const noLeft = none(viewer, "chat:message", (m) => / left /.test(m.text), 300);
      app.disconnect();
      await cleared;
      await noLeft;
      assert.equal(room.hostId, host.id);
    });

    test("a viewer's companion has no extra rights, and the crown skips it", async () => {
      const { code, host, viewer } = await pair();
      const app = await srv.connect();
      await join(app, { code, name: "Viewer", clientId: `v-${code}`, companion: true });
      assert.equal((await ack(app, "stage:start", { source: "screen" })).ok, false);

      // The host leaves: the crown waits out the grace period, then goes to a
      // person — the viewer's real tab, never the companion.
      const crowned = once(viewer, "room:host", (id) => !!id);
      host.disconnect();
      assert.equal(await crowned, viewer.id);
      // Now host, the viewer's companion borrows the right to present.
      assert.equal((await ack(app, "stage:start", { source: "screen" })).ok, true);
    });

    test("can't be handed the crown", async () => {
      const { code, host } = await pair();
      const app = await srv.connect();
      await join(app, { code, name: "Viewer", clientId: `v-${code}`, companion: true });
      host.emit("host:transfer", { targetId: app.id });
      await ping(host);
      assert.equal(srv.rt.rooms.get(code).hostId, host.id);
    });

    test("an idle companion goes once its person has left", async () => {
      const { code, viewer } = await pair();
      const app = await srv.connect();
      await join(app, { code, name: "Viewer", clientId: `v-${code}`, companion: true });
      const sentOut = once(app, "room:denied", (d) => d.reason === "missing", 2000);
      viewer.disconnect();
      await sentOut;
      const room = srv.rt.rooms.get(code);
      assert.ok(![...room.users.values()].some((u) => u.companion));
    });

    test("a sharing companion stands in for its person while their page is away", async () => {
      const { code, host, viewer } = await pair();
      const app = await srv.connect();
      await join(app, { code, name: "Viewer", clientId: `v-${code}`, companion: true });
      host.emit("host:playback", { mode: "everyone" });
      await ping(host);
      const { streamId } = await ack(app, "stage:start", { source: "screen" });

      // The page drops (phone showing other apps): the share goes on, the
      // person stays listed (as their companion) and nobody "left".
      const noLeft = none(host, "chat:message", (m) => / left /.test(m.text), 500);
      const stillLive = none(host, "player:action", (a) => a.type === "load", 500);
      const listed = once(host, "room:users", (users) => users.some((u) => u.id === app.id));
      viewer.disconnect();
      await Promise.all([noLeft, stillLive, listed]);
      assert.equal(srv.rt.rooms.get(code).media.streamId, streamId);
      assert.equal(srv.rt.rooms.get(code).hostId, host.id);

      // A reconnected companion is let in while the page still sleeps.
      const fresh = await srv.connect();
      const st = await join(fresh, { code, name: "Viewer", clientId: `v-${code}`, companion: true });
      assert.equal(st.media, null);
      assert.equal((await ack(fresh, "stage:start", { source: "screen" })).ok, true);

      // The page comes back: listed once, as itself.
      const page = await srv.connect();
      const back = await join(page, { code, name: "Viewer", clientId: `v-${code}` });
      const mine = back.users.filter((u) => u.name === "Viewer");
      assert.deepEqual(mine.map((u) => u.id), [page.id]);
    });

    test("a person back within the grace period keeps their companion", async () => {
      const { code } = await pair();
      const page = await srv.connect();
      await join(page, { code, name: "Phone", clientId: `p-${code}` });
      const app = await srv.connect();
      await join(app, { code, name: "Phone", clientId: `p-${code}`, companion: true });
      page.disconnect();
      const back = await srv.connect();
      await join(back, { code, name: "Phone", clientId: `p-${code}` });
      await none(app, "room:denied", () => true, 400);
      assert.ok(srv.rt.rooms.get(code).users.has(app.id));
    });

    test("a reconnected companion replaces the stale one and its share", async () => {
      const { code, host } = await pair();
      const stale = await srv.connect();
      await join(stale, { code, name: "Host", clientId: `h-${code}`, companion: true });
      const first = await ack(stale, "stage:start", { source: "screen" });
      assert.equal(first.ok, true);

      const cleared = once(host, "player:action", (a) => a.type === "load" && a.media === null);
      const fresh = await srv.connect();
      const st = await join(fresh, { code, name: "Host", clientId: `h-${code}`, companion: true });
      await cleared;
      assert.equal(st.media, null);
      const room = srv.rt.rooms.get(code);
      assert.equal([...room.users.values()].filter((u) => u.companion).length, 1);
      assert.equal((await ack(fresh, "stage:start", { source: "screen" })).ok, true);
    });
  });

  /* 13 */
  describe("password rooms", () => {
    function tryJoin(sock, payload) {
      return new Promise((resolve) => {
        const done = (kind) => (x) => {
          sock.off("room:state", onState);
          sock.off("room:denied", onDenied);
          resolve({ kind, x });
        };
        const onState = done("state");
        const onDenied = done("denied");
        sock.on("room:state", onState);
        sock.on("room:denied", onDenied);
        sock.emit("room:join", payload);
      });
    }

    test("strangers need it, wrong ones are flagged, members walk in", async () => {
      const { code, host, viewer } = await pair();

      const viewerTry = await ack(viewer, "host:password", { password: "hunter22" });
      assert.equal(viewerTry.ok, false);
      assert.equal((await ack(host, "host:password", { password: "abc" })).ok, false);
      assert.equal((await ack(host, "host:password", { password: "x".repeat(65) })).ok, false);
      assert.equal((await ack(host, "host:password", { password: 12345 })).ok, false);

      const settings = once(viewer, "room:settings", (s) => s.hasPassword === true);
      const line = once(viewer, "chat:message", (m) => m.system && m.text === "The host set a room password");
      assert.equal((await ack(host, "host:password", { password: "hunter22" })).ok, true);
      const s = await settings;
      await line;
      assert.ok(!/hash|salt/.test(JSON.stringify(s)));

      const stranger = await srv.connect();
      const base = { code, name: "Stranger", clientId: `s-${code}` };
      assert.deepEqual((await tryJoin(stranger, base)).x, { reason: "password" });
      assert.deepEqual(
        (await tryJoin(stranger, { ...base, password: "wrong-one" })).x,
        { reason: "password", wrong: true }
      );
      const ok = await tryJoin(stranger, { ...base, password: "hunter22" });
      assert.equal(ok.kind, "state");
      assert.equal(ok.x.settings.hasPassword, true);
      assert.ok(!/hash|salt/.test(JSON.stringify(ok.x)));

      // Admitted once = admitted: no password on the way back.
      stranger.disconnect();
      const back = await srv.connect();
      await join(back, base);
      viewer.disconnect();
      const viewer2 = await srv.connect();
      await join(viewer2, { code, name: "Viewer", clientId: `v-${code}` });

      // Clearing it lets anyone in again.
      const cleared = once(viewer2, "room:settings", (x) => x.hasPassword === false);
      const removedLine = once(viewer2, "chat:message", (m) => m.system && /removed the room password/.test(m.text));
      assert.equal((await ack(host, "host:password", { password: null })).ok, true);
      await Promise.all([cleared, removedLine]);
      await join(await srv.connect(), { code, name: "Anyone", clientId: `a-${code}` });
    });

    test("guessing is rate limited", async () => {
      const { code, host } = await pair();
      await ack(host, "host:password", { password: "correct horse" });
      const guesser = await srv.connect();
      const base = { code, name: "Guesser", clientId: `g-${code}` };
      for (let i = 0; i < 5; i++) {
        const r = await tryJoin(guesser, { ...base, password: `guess-${i}` });
        assert.deepEqual(r.x, { reason: "password", wrong: true });
      }
      // Out of attempts: even the right one is refused for now, and the
      // refusal says so rather than looking like a wrong password.
      const notice = once(guesser, "room:notice", (t) => /Too many/.test(t));
      const r = await tryJoin(guesser, { ...base, password: "correct horse" });
      assert.deepEqual(r.x, { reason: "password", limited: true });
      await notice;
      assert.ok(!srv.rt.rooms.get(code).members.has(`g-${code}`));
    });

    // A server of its own, so these guesses don't eat into the shared
    // server's per-address allowance (every test client is 127.0.0.1).
    async function withServer(options, fn) {
      const own = await startServer(options);
      try {
        await fn(own);
      } finally {
        await own.stop();
      }
    }

    async function passwordRoom(own, password, code = roomCode()) {
      const host = await own.connect();
      await join(host, { code, name: "Host", clientId: `h-${code}` });
      assert.equal((await ack(host, "host:password", { password })).ok, true);
      return { code, host };
    }

    test("reconnecting doesn't reset the limit: per address across sockets", async () => {
      await withServer({}, async (own) => {
        const { code } = await passwordRoom(own, "correct horse");
        // A fresh connection (and clientId) for every guess.
        for (let i = 0; i < 10; i++) {
          const s = await own.connect();
          const r = await tryJoin(s, { code, name: "G", clientId: `g${i}-${code}`, password: `guess-${i}` });
          assert.deepEqual(r.x, { reason: "password", wrong: true }, `guess ${i}`);
          s.disconnect();
        }
        const s = await own.connect();
        const notice = once(s, "room:notice", (t) => /Too many/.test(t));
        const r = await tryJoin(s, { code, name: "G", clientId: `gx-${code}`, password: "correct horse" });
        assert.deepEqual(r.x, { reason: "password", limited: true });
        await notice;
        assert.ok(!own.rt.rooms.get(code).members.has(`gx-${code}`));
        // Members still walk straight back in; they're never asked.
        const host2 = await own.connect();
        await join(host2, { code, name: "Host", clientId: `h-${code}` });
      });
    });

    test("per room: many addresses' worth of guesses still run out", async () => {
      // Lift the per-address cap so only the room's own limit (20) bites.
      // A long window, so a slow machine (20 scrypt checks) can't see a
      // token refill before the 21st guess.
      await withServer(
        { passwordPerAddress: [1_000, 60_000], passwordPerRoom: [20, 3_600_000] },
        async (own) => {
        const { code } = await passwordRoom(own, "correct horse");
        const other = await passwordRoom(own, "open sesame");
        for (let i = 0; i < 20; i++) {
          const s = await own.connect();
          const r = await tryJoin(s, { code, name: "G", clientId: `g${i}-${code}`, password: `guess-${i}` });
          assert.deepEqual(r.x, { reason: "password", wrong: true }, `guess ${i}`);
          s.disconnect();
        }
        const late = await own.connect();
        const r = await tryJoin(late, { code, name: "G", clientId: `gx-${code}`, password: "correct horse" });
        assert.deepEqual(r.x, { reason: "password", limited: true });
        // Another room's door isn't affected.
        const ok = await tryJoin(late, {
          code: other.code,
          name: "G",
          clientId: `gx-${code}`,
          password: "open sesame",
        });
        assert.equal(ok.kind, "state");
        }
      );
    });

    test("the async check admits the right password, refuses a wrong one, never blocks", async () => {
      await withServer({}, async (own) => {
        const { code, host } = await passwordRoom(own, "hunter22");
        const s = await own.connect();
        const base = { code, name: "S", clientId: `s-${code}` };
        // While a guess is hashing, the server keeps answering.
        const pending = tryJoin(s, { ...base, password: "nope-nope" });
        await ping(host);
        assert.deepEqual((await pending).x, { reason: "password", wrong: true });
        const ok = await tryJoin(s, { ...base, password: "hunter22" });
        assert.equal(ok.kind, "state");
        assert.ok(own.rt.rooms.get(code).users.has(s.id));
      });
    });

    test("a join that's still hashing is dropped if the socket leaves or joins elsewhere", async () => {
      await withServer({}, async (own) => {
        const { code } = await passwordRoom(own, "hunter22");
        const room = own.rt.rooms.get(code);

        // Joins somewhere else straight away: that one wins.
        const s = await own.connect();
        const seen = recordAll(s);
        const elsewhere = roomCode();
        s.emit("room:join", { code, name: "S", clientId: `s-${code}`, password: "hunter22" });
        const st = await join(s, { code: elsewhere, name: "S", clientId: `s-${code}` });
        assert.ok(st.users.some((u) => u.id === s.id));
        await sleep(300);
        assert.ok(!room.users.has(s.id));
        assert.ok(!room.members.has(`s-${code}`));
        assert.equal(seen.filter((e) => e.event === "room:state").length, 1);
        assert.ok(own.rt.rooms.get(elsewhere).users.has(s.id));

        // Disconnects mid-hash: no ghost seat.
        const d = await own.connect();
        d.emit("room:join", { code, name: "D", clientId: `d-${code}`, password: "hunter22" });
        d.disconnect();
        await sleep(300);
        assert.equal(room.users.size, 1);
        assert.ok(!room.members.has(`d-${code}`));
      });
    });

    test("host:password is limited per address too, across connections", async () => {
      await withServer({ passwordSetPerAddress: [3, 60_000] }, async (own) => {
        const code = roomCode();
        const results = [];
        for (let i = 0; i < 4; i++) {
          // The owner reconnecting each time gets a fresh per-socket bucket.
          const s = await own.connect();
          await join(s, { code, name: "Host", clientId: `h-${code}` });
          results.push(await ack(s, "host:password", { password: `secret-${i}` }));
          s.disconnect();
        }
        assert.deepEqual(results.map((r) => r.ok), [true, true, true, false]);
      });
    });
  });
});

/* 8 */
describe("persistence", () => {
  let dir;
  let first;
  let second;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "playcircle-test-"));
  });
  after(async () => {
    await first?.stop();
    await second?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("rooms survive a restart", async () => {
    const dataFile = path.join(dir, "rooms.json");
    const code = roomCode();
    first = await startServer({ dataFile });

    const owner = await first.connect();
    await join(owner, { code, name: "Owner", clientId: "persist-owner" });
    const viewer = await first.connect();
    await join(viewer, { code, name: "Viewer", clientId: "persist-viewer" });

    const loaded = once(viewer, "player:action", (a) => a.type === "load");
    owner.emit("player:action", { type: "load", media: yt(V0) });
    await loaded;
    owner.emit("player:action", { type: "pause", time: 30, key: key(V0) });
    await ack(owner, "queue:add", { media: yt(V1) });
    viewer.emit("chat:message", { text: "remember me" });
    await ping(viewer);

    first.rt.flush();
    assert.ok(fs.existsSync(dataFile), "snapshot written");
    const saved = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    assert.ok(saved.rooms.some((r) => r.code === code));
    await first.stop();

    const origLog = console.log;
    console.log = () => {};
    try {
      second = await startServer({ dataFile });
    } finally {
      console.log = origLog;
    }
    assert.ok(second.rt.rooms.has(code), "room restored");

    const owner2 = await second.connect();
    const st = await join(owner2, { code, name: "Owner", clientId: "persist-owner" });
    assert.equal(st.media.id, V0);
    assert.equal(st.isPlaying, false);
    assert.ok(Math.abs(st.time - 30) < 0.01, `time ${st.time}`);
    assert.deepEqual(
      st.queue.items.map((i) => i.media.id),
      [V1]
    );
    assert.equal(st.queue.items[0].status, "ready");
    assert.equal(st.hostId, owner2.id);
    assert.equal(st.users.find((u) => u.id === owner2.id).owner, true);
    assert.ok(st.messages.some((m) => m.text === "remember me"));

    // The returning viewer is a known member and not the host.
    const viewer2 = await second.connect();
    const vs = await join(viewer2, { code, name: "Viewer", clientId: "persist-viewer" });
    assert.equal(vs.hostId, owner2.id);
  });

  test("a corrupted snapshot doesn't stop startup; good rooms still restore", async () => {
    const dataFile = path.join(dir, "corrupt.json");
    const good = roomCode();
    const messy = roomCode();
    const bad = roomCode();
    fs.writeFileSync(
      dataFile,
      JSON.stringify({
        savedAt: Date.now(),
        rooms: [
          null,
          "not a room",
          42,
          [],
          { code: ["AB"] },
          { code: "lower-case" },
          {
            code: good,
            title: "Good room",
            media: { kind: "youtube", id: V0, title: "Song", extra: "<script>" },
            time: 12,
            duration: 300,
            ownerClientId: "good-owner",
            settings: { approval: false, order: "manual", autoplay: false },
            members: ["good-owner"],
            colors: [["good-owner", "#3b82f6"]],
            queue: [
              { id: "q1", media: yt(V1), cid: "good-owner", by: { name: "Owner", color: "#3b82f6" }, votes: ["good-owner"], status: "ready", addedAt: 1, seq: 1 },
              { id: "q2", media: yt(V2), by: { name: "Nobody" }, votes: [], status: "ready" }, // no cid
            ],
            messages: [{ id: "m1", name: "Owner", color: "#3b82f6", text: "hi", ts: 1 }],
            history: [{ media: yt(V3), playedAt: 1 }],
          },
          {
            code: messy,
            title: { evil: true },
            media: { kind: "youtube", id: "junk" },
            duration: 1e9,
            time: "lots",
            ownerClientId: 7,
            perms: "x",
            members: 7,
            colors: { a: 1 },
            banned: "someone",
            settings: { approval: "yes", order: "random", autoplay: 1, evil: true },
            messages: [null, 5, { text: 9 }, { text: "kept", junk: "dropped", system: true }],
            queue: [
              { media: yt(V1), cid: "c1", votes: 5, status: "weird", addedAt: "x", seq: null, by: "nope" },
              { media: { kind: "vimeo", id: 1 }, cid: "c2" },
              { media: yt(V1), cid: "c3" }, // duplicate video
              null,
              7,
            ],
            history: [null, { media: "junk" }, { media: yt(V2), playedAt: "x" }],
          },
          { code: bad, perms: [5, null, ["cid"], ["cid", "x"]], colors: [7, [1, 2]], queue: "x" },
        ],
      })
    );

    const origLog = console.log;
    const origError = console.error;
    const errors = [];
    console.log = () => {};
    console.error = (...args) => errors.push(args.map(String).join(" "));
    let third;
    try {
      third = await startServer({ dataFile });
    } finally {
      console.log = origLog;
      console.error = origError;
    }
    try {
      const { rooms } = third.rt;
      assert.deepEqual(errors, [], "every room restored without a throw");
      assert.deepEqual([...rooms.keys()].sort(), [good, messy, bad].sort());

      const g = rooms.get(good);
      assert.deepEqual(g.media, { kind: "youtube", id: V0, title: "Song" });
      assert.equal(g.duration, 300);
      assert.equal(g.time, 12);
      assert.deepEqual(g.settings, {
        approval: false,
        order: "manual",
        autoplay: false,
        voteSkip: true,
      });
      assert.deepEqual(g.queue.map((q) => q.media.id), [V1]);
      assert.ok(g.queue[0].votes instanceof Set && g.queue[0].votes.has("good-owner"));
      assert.equal(g.history[0].media.id, V3);

      const m = rooms.get(messy);
      assert.equal(m.title, null);
      assert.equal(m.media, null);
      assert.equal(m.duration, null);
      assert.equal(m.time, 0);
      assert.equal(m.ownerClientId, null);
      assert.equal(m.perms.size, 0);
      assert.equal(m.members.size, 0);
      assert.equal(m.colors.size, 0);
      assert.equal(m.banned.size, 0);
      assert.deepEqual(m.settings, {
        approval: true,
        order: "votes",
        autoplay: true,
        voteSkip: true,
      });
      assert.deepEqual(
        m.messages.map((x) => [x.text, x.system, x.junk]),
        [["kept", true, undefined]]
      );
      assert.equal(m.queue.length, 1);
      const q = m.queue[0];
      assert.equal(q.status, "pending");
      assert.equal(q.votes.size, 0);
      assert.equal(typeof q.addedAt, "number");
      assert.equal(typeof q.seq, "number");
      assert.deepEqual(Object.keys(q.by).sort(), ["color", "name"]);
      assert.deepEqual(m.history.map((h) => h.media.id), [V2]);
      assert.equal(typeof m.history[0].playedAt, "number");

      const b = rooms.get(bad);
      assert.equal(b.perms.size, 0);
      assert.equal(b.colors.size, 0);
      assert.deepEqual(b.queue, []);

      // Restored rooms actually work: the messy one gets an owner on join
      // and serves a snapshot with its (cleaned) queue.
      const s = await third.connect();
      const st = await join(s, { code: messy, name: "First", clientId: "messy-1" });
      assert.equal(st.hostId, s.id);
      assert.equal(st.queue.items.length, 1);
      const g2 = await third.connect();
      const gs = await join(g2, { code: good, name: "Owner", clientId: "good-owner" });
      assert.equal(gs.media.id, V0);
      assert.equal(gs.hostId, g2.id);
    } finally {
      await third.stop();
    }
  });

  test("chat extras, moments, settings and the password survive; live shares don't", async () => {
    const dataFile = path.join(dir, "batch2.json");
    const ytFile = path.join(dir, "batch2-yt.json");
    const code = roomCode();
    const quiet = async (fn) => {
      const origLog = console.log;
      console.log = () => {};
      try {
        return await fn();
      } finally {
        console.log = origLog;
      }
    };
    const a = await startServer({ dataFile });
    let b;
    let c;
    try {
      const owner = await a.connect();
      await join(owner, { code, name: "Owner", clientId: "b2-owner" });
      const viewer = await a.connect();
      await join(viewer, { code, name: "Viewer", clientId: "b2-viewer" });

      const loaded = once(viewer, "player:action", (x) => x.type === "load");
      owner.emit("player:action", { type: "load", media: yt(V0) });
      await loaded;
      owner.emit("player:action", { type: "pause", time: 20, key: key(V0) });
      viewer.emit("reaction:send", { emoji: "🎉" });
      await Promise.all([ping(owner), ping(viewer)]);

      const sent = once(viewer, "chat:message", (m) => m.text === "pin me");
      owner.emit("chat:message", { text: "pin me", announce: true });
      const msg = await sent;
      viewer.emit("chat:message", { text: "a reply", replyTo: msg.id });
      viewer.emit("chat:react", { id: msg.id, emoji: "🔥" });
      owner.emit("chat:pin", { id: msg.id });
      owner.emit("host:settings", { voteSkip: false });
      await Promise.all([ping(owner), ping(viewer)]);
      assert.equal((await ack(owner, "host:password", { password: "letmein" })).ok, true);

      // A binding "what's next" win is kept on the queue item.
      await ack(owner, "queue:add", { media: yt(V1) });
      await ack(owner, "queue:add", { media: yt(V2) });
      const room = a.rt.rooms.get(code);
      const v2id = room.queue.find((q) => q.media.id === V2).id;
      const v1id = room.queue.find((q) => q.media.id === V1).id;
      await ack(owner, "poll:create", { kind: "next", itemIds: [v1id, v2id], binding: true });
      owner.emit("poll:vote", { id: room.poll.id, option: 1 });
      owner.emit("poll:close", { id: room.poll.id });
      await ping(owner);
      assert.equal(room.queue.find((q) => q.id === v2id).next, true);

      a.rt.flush();
      fs.copyFileSync(dataFile, ytFile);
      const saved = JSON.parse(fs.readFileSync(dataFile, "utf8")).rooms.find((r) => r.code === code);
      assert.equal(saved.media.id, V0);
      assert.equal(saved.password.hash.length, 128);
      assert.ok(!JSON.stringify(saved).includes("letmein"), "never the plain password");
      assert.equal(saved.messages.find((m) => m.id === msg.id).cid, "b2-owner");

      // Now a live share takes the stage: it must not be saved.
      assert.equal((await ack(owner, "stage:start", { source: "screen" })).ok, true);
      a.rt.flush();
      const live = JSON.parse(fs.readFileSync(dataFile, "utf8")).rooms.find((r) => r.code === code);
      assert.equal(live.media, null);
      await a.stop();

      // Restart from the live-share snapshot: an empty stage, everything else kept.
      b = await quiet(() => startServer({ dataFile }));
      const r = b.rt.rooms.get(code);
      assert.equal(r.media, null);
      assert.equal(r.settings.voteSkip, false);
      assert.equal(r.pinnedId, msg.id);
      const m0 = r.messages.find((m) => m.id === msg.id);
      assert.equal(m0.cid, "b2-owner");
      assert.equal(m0.announce, true);
      assert.deepEqual(m0.reactions, { "🔥": ["b2-viewer"] });
      const reply = r.messages.find((m) => m.text === "a reply");
      assert.deepEqual(reply.replyTo, { id: msg.id, name: "Owner", text: "pin me" });
      assert.equal(r.queue[0].media.id, V2);
      assert.equal(r.queue[0].next, true);

      // The password still guards the door; members and the owner skip it.
      const stranger = await b.connect();
      const denied = once(stranger, "room:denied");
      stranger.emit("room:join", { code, name: "Stranger", clientId: "b2-stranger" });
      assert.deepEqual(await denied, { reason: "password" });
      const st = await join(await b.connect(), { code, name: "Owner", clientId: "b2-owner" });
      assert.equal(st.settings.hasPassword, true);
      assert.equal(st.settings.voteSkip, false);
      assert.equal(st.pinned.id, msg.id);
      assert.equal(st.messages.find((m) => m.id === msg.id).reactions["🔥"].length, 1);
      assertNoIds([st], ["b2-owner", "b2-viewer"]);
      await join(await b.connect(), { code, name: "Viewer", clientId: "b2-viewer" });
      await join(stranger, { code, name: "Stranger", clientId: "b2-stranger", password: "letmein" });

      // Restart from the YouTube snapshot: the video and its moments come back.
      c = await quiet(() => startServer({ dataFile: ytFile }));
      const y = c.rt.rooms.get(code);
      assert.equal(y.media.id, V0);
      assert.equal(y.moments.key, key(V0));
      assert.deepEqual(y.moments.list.map((x) => x.e), ["🎉"]);
      const yst = await join(await c.connect(), { code, name: "Owner", clientId: "b2-owner" });
      assert.deepEqual(yst.moments.map((x) => x.e), ["🎉"]);
    } finally {
      await a.stop();
      await b?.stop();
      await c?.stop();
    }
  });

  test("a hand-edited snapshot can't smuggle in live media, bad moments or a bad password", async () => {
    const dataFile = path.join(dir, "batch2-messy.json");
    const code = roomCode();
    fs.writeFileSync(
      dataFile,
      JSON.stringify({
        rooms: [
          {
            code,
            media: { kind: "live", source: "tab", streamId: "s", presenter: "x", title: "t" },
            moments: { key: "live:s", list: [{ t: 1, e: "🎉" }] },
            password: { salt: "zz", hash: "not hex" },
            pinnedId: "missing",
            settings: { voteSkip: "no" },
            messages: [
              { id: "m1", text: "hi", cid: 5, reactions: { "💩": ["a"], "👍": ["a", "a", 7] }, replyTo: { id: 3 } },
              { id: "m2", text: "sys", system: true, cid: "leak" },
            ],
          },
        ],
      })
    );
    const origLog = console.log;
    console.log = () => {};
    let srv2;
    try {
      srv2 = await startServer({ dataFile });
    } finally {
      console.log = origLog;
    }
    try {
      const r = srv2.rt.rooms.get(code);
      assert.equal(r.media, null);
      assert.deepEqual(r.moments.list, []);
      assert.equal(r.password, null);
      assert.equal(r.pinnedId, null);
      assert.equal(r.settings.voteSkip, true);
      const [m1, m2] = r.messages;
      assert.equal(m1.cid, undefined);
      assert.equal(m1.replyTo, undefined);
      assert.deepEqual(m1.reactions, { "👍": ["a"] });
      assert.equal(m2.cid, undefined);
    } finally {
      await srv2.stop();
    }
  });
});

/* ---------------- paste any link ---------------- */

const { resolve: resolveLink, readPage, ERR: LINK_ERR } = require("../server/resolve.js");
const { safeFetch, isBlockedAddress, FetchError } = require("../server/safeFetch.js");
const mediaLib = require("../server/media.js");

// A local "internet": pages, files and APIs the resolver is pointed at.
async function startFixture() {
  const hits = new Map();
  const open = new Set();
  let base = "";
  const html = (res, body) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head>${body}</head><body></body></html>`);
  };
  const json = (res, data) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(data));
  };
  const server = http.createServer((req, res) => {
    const p = req.url;
    hits.set(p, (hits.get(p) || 0) + 1);
    if (p === "/og") {
      return html(
        res,
        `<title>Ignored</title>
         <meta property="og:title" content="Tom &amp; Jerry &#8212; ep 1">
         <meta property='og:image' content="/img/poster.jpg">
         <meta property="og:video" content="/v/movie.mp4?a=1&amp;b=2">`
      );
    }
    if (p === "/og2") return html(res, `<meta property="og:video:url" content="${base}/v/movie.mp4?a=1&b=2">`);
    if (p === "/og-noext") return html(res, `<meta property="og:video" content="/stream">`);
    if (p === "/stream") {
      res.setHeader("content-type", "video/mp4");
      return res.end(req.method === "HEAD" ? undefined : "not really a video");
    }
    if (p === "/live") {
      res.setHeader("content-type", "application/vnd.apple.mpegurl");
      return res.end("#EXTM3U\n");
    }
    if (p === "/ld") {
      return html(
        res,
        `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
           {"@type":"WebPage","name":"page"},
           {"@type":"VideoObject","name":"From JSON-LD","thumbnailUrl":["/t.jpg"],"contentUrl":"/files/clip.webm"}]}</script>`
      );
    }
    if (p === "/tag") {
      return html(
        res,
        `<!-- <video src="/commented-out.mp4"></video> -->
         <video controls poster="/p.jpg"><source src="/media/talk.m3u8" type="application/x-mpegURL"></video>`
      );
    }
    if (p === "/oe-vimeo") {
      return html(res, `<link rel="alternate" type="application/json+oembed" href="/oembed/vimeo.json" title="x">`);
    }
    if (p === "/oembed/vimeo.json") {
      return json(res, {
        type: "video",
        title: "A Vimeo thing",
        html: '<iframe src="https://player.vimeo.com/video/76979871?h=8272103f6e&amp;badge=0" width="640"></iframe>',
      });
    }
    if (p === "/oe-yt") {
      return html(res, `<link type="application/json+oembed" rel="alternate" href="${base}/oembed/yt.json">`);
    }
    if (p === "/oembed/yt.json") {
      return json(res, { html: `<iframe src="https://www.youtube.com/embed/${V2}?feature=oembed"></iframe>` });
    }
    if (p === "/iframe") return html(res, `<iframe data-src="https://www.dailymotion.com/embed/video/x8abc12"></iframe>`);
    if (p === "/clip-page") return html(res, `<iframe src="https://clips.twitch.tv/embed?clip=FunnyClip&parent=x"></iframe>`);
    if (p === "/none") return html(res, `<title>Just words</title><video></video>`);
    if (p === "/w/abcdefgh1234") return html(res, "<title>PeerTube</title>");
    if (p === "/api/v1/videos/abcdefgh1234") {
      return json(res, {
        uuid: "u-1",
        name: "Peer video",
        duration: 95,
        thumbnailPath: "/static/thumb.jpg",
        account: { displayName: "Alice" },
        streamingPlaylists: [{ type: 1, playlistUrl: `${base}/hls/master.m3u8` }],
        files: [],
      });
    }
    if (p === "/streamable-api/videos/abc123") {
      return json(res, {
        title: "Streamed",
        thumbnail_url: "//cdn.example.com/t.jpg",
        files: { mp4: { url: "//cdn.example.com/abc123.mp4", duration: 12.5 } },
      });
    }
    if (p === "/big") {
      res.setHeader("content-type", "text/html");
      const chunk = "x".repeat(64 * 1024);
      for (let i = 0; i < 48; i++) res.write(chunk); // 3 MB
      return res.end();
    }
    if (p === "/slow") return; // never answers
    // A video whose HEAD is slow and says nothing, and whose GET never ends.
    if (p === "/og-hang") return html(res, `<meta property="og:video" content="/hang-probe">`);
    if (p === "/hang-probe") {
      if (req.method === "HEAD") setTimeout(() => res.end(), 1_200);
      return;
    }
    // A page that takes a moment to share its video.
    if (p === "/delay-og") {
      setTimeout(() => html(res, `<meta property="og:video" content="/v/late.mp4">`), 600);
      return;
    }
    if (p === "/og-private") return html(res, `<meta property="og:video" content="http://10.0.0.7/a.mp4">`);
    if (p.startsWith("/redir/")) {
      const n = Number(p.split("/")[2]);
      res.statusCode = 302;
      res.setHeader("location", n > 0 ? `/redir/${n - 1}` : "/og");
      return res.end();
    }
    if (p === "/to-metadata") {
      res.statusCode = 302;
      res.setHeader("location", "http://169.254.169.254/latest/meta-data/");
      return res.end();
    }
    if (p === "/to-internal") {
      res.statusCode = 301;
      res.setHeader("location", `http://internal.test:${server.address().port}/og`);
      return res.end();
    }
    if (p === "/to-ftp") {
      res.statusCode = 302;
      res.setHeader("location", "ftp://example.com/x.mp4");
      return res.end();
    }
    res.statusCode = 404;
    res.end("nope");
  });
  server.on("connection", (s) => {
    open.add(s);
    s.on("close", () => open.delete(s));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  base = `http://127.0.0.1:${port}`;
  return {
    base,
    port,
    hits: (p) => hits.get(p) || 0,
    totalHits: () => [...hits.values()].reduce((a, b) => a + b, 0),
    close: () =>
      new Promise((r) => {
        for (const s of open) s.destroy();
        server.close(() => r());
      }),
  };
}

// Fixtures live on 127.0.0.1, so the resolver is told private is fine.
const LOCAL = { allowPrivate: true, cache: false };

describe("link resolution", () => {
  let fx;
  before(async () => {
    fx = await startFixture();
  });
  after(() => fx.close());

  test("direct .mp4 / .m3u8 links resolve by extension, without fetching", async () => {
    const before = fx.totalHits();
    const f = await resolveLink(`${fx.base}/videos/Big_Buck_Bunny.mp4`, LOCAL);
    assert.deepEqual(f, {
      kind: "file",
      url: `${fx.base}/videos/Big_Buck_Bunny.mp4`,
      mime: "video/mp4",
      title: "Big_Buck_Bunny",
      source: `${fx.base}/videos/Big_Buck_Bunny.mp4`,
    });
    const h = await resolveLink(`${fx.base}/hls/index.m3u8?token=1`, LOCAL);
    assert.equal(h.kind, "hls");
    assert.equal(h.url, `${fx.base}/hls/index.m3u8?token=1`);
    assert.equal(h.title, "127.0.0.1"); // a generic name falls back to the host
    assert.equal(mediaLib.key(h), `hls:${fx.base}/hls/index.m3u8?token=1`);
    assert.equal(fx.totalHits(), before, "nothing fetched");
  });

  test("an extensionless link is identified by its Content-Type", async () => {
    const f = await resolveLink(`${fx.base}/stream`, LOCAL);
    assert.equal(f.kind, "file");
    assert.equal(f.url, `${fx.base}/stream`);
    assert.equal(f.mime, "video/mp4");
    const h = await resolveLink(`${fx.base}/live`, LOCAL);
    assert.equal(h.kind, "hls");
    // A page's og:video without an extension is probed the same way.
    const o = await resolveLink(`${fx.base}/og-noext`, LOCAL);
    assert.equal(o.kind, "file");
    assert.equal(o.url, `${fx.base}/stream`);
    assert.equal(o.source, `${fx.base}/og-noext`);
  });

  test("og:video page: relative URL resolved, entities decoded, title and image kept", async () => {
    const m = await resolveLink(`${fx.base}/og`, LOCAL);
    assert.deepEqual(m, {
      kind: "file",
      url: `${fx.base}/v/movie.mp4?a=1&b=2`,
      mime: "video/mp4",
      title: "Tom & Jerry — ep 1",
      thumb: `${fx.base}/img/poster.jpg`,
      source: `${fx.base}/og`,
    });
  });

  test("JSON-LD VideoObject contentUrl", async () => {
    const m = await resolveLink(`${fx.base}/ld`, LOCAL);
    assert.equal(m.kind, "file");
    assert.equal(m.url, `${fx.base}/files/clip.webm`);
    assert.equal(m.mime, "video/webm");
    assert.equal(m.title, "From JSON-LD");
    assert.equal(m.thumb, `${fx.base}/t.jpg`);
  });

  test("<video><source> page (comments ignored)", async () => {
    const m = await resolveLink(`${fx.base}/tag`, LOCAL);
    assert.equal(m.kind, "hls");
    assert.equal(m.url, `${fx.base}/media/talk.m3u8`);
    assert.equal(m.thumb, `${fx.base}/p.jpg`);
    assert.equal(fx.hits("/commented-out.mp4"), 0);
  });

  test("oEmbed discovery → the Vimeo / YouTube player it describes", async () => {
    const v = await resolveLink(`${fx.base}/oe-vimeo`, LOCAL);
    assert.equal(v.kind, "vimeo");
    assert.equal(v.id, "76979871");
    assert.equal(v.hash, "8272103f6e");
    assert.equal(v.source, `${fx.base}/oe-vimeo`);
    const y = await resolveLink(`${fx.base}/oe-yt`, LOCAL);
    assert.equal(y.kind, "youtube");
    assert.equal(y.id, V2);
    // A provider's iframe right in the page works too.
    const d = await resolveLink(`${fx.base}/iframe`, LOCAL);
    assert.equal(d.kind, "dailymotion");
    assert.equal(d.id, "x8abc12");
  });

  test("PeerTube and Streamable go through their APIs", async () => {
    const p = await resolveLink(`${fx.base}/w/abcdefgh1234`, LOCAL);
    assert.equal(p.kind, "hls");
    assert.equal(p.url, `${fx.base}/hls/master.m3u8`);
    assert.equal(p.title, "Peer video");
    assert.equal(p.author, "Alice");
    assert.equal(p.duration, 95);
    assert.equal(p.thumb, `${fx.base}/static/thumb.jpg`);

    const s = await resolveLink("https://streamable.com/abc123", {
      ...LOCAL,
      apiBase: { streamable: `${fx.base}/streamable-api` },
    });
    assert.equal(s.kind, "file");
    assert.equal(s.url, "https://cdn.example.com/abc123.mp4");
    assert.equal(s.title, "Streamed");
    assert.equal(s.duration, 12.5);
  });

  test("a page that shares nothing, a Twitch clip, copy-protected services", async () => {
    assert.deepEqual(await resolveLink(`${fx.base}/none`, LOCAL), { error: LINK_ERR.notFound });
    assert.match(LINK_ERR.notFound, /doesn't share it/);
    assert.deepEqual(await resolveLink(`${fx.base}/clip-page`, LOCAL), { error: LINK_ERR.twitchClip });
    assert.deepEqual(await resolveLink("https://clips.twitch.tv/FunnyClip"), { error: LINK_ERR.twitchClip });
    assert.deepEqual(await resolveLink("https://www.twitch.tv/somebody/clip/FunnyClip-abc"), {
      error: LINK_ERR.twitchClip,
    });
    for (const [url, name] of [
      ["https://www.netflix.com/watch/80100172", "Netflix"],
      ["https://www.primevideo.com/detail/0ABC", "Prime Video"],
      ["https://www.amazon.co.uk/gp/video/detail/B0X", "Prime Video"],
      ["https://www.disneyplus.com/video/123", "Disney+"],
      ["https://www.hotstar.com/in/movies/x/123", "Hotstar"],
      ["https://www.crunchyroll.com/watch/G4", "Crunchyroll"],
      ["https://play.max.com/video/watch/1", "Max"],
      ["https://www.hulu.com/watch/1", "Hulu"],
      ["https://tv.apple.com/us/episode/x", "Apple TV"],
    ]) {
      const r = await resolveLink(url);
      assert.equal(r.error, `${name} is copy-protected and can't be played here — each person needs to watch it on their own account.`);
    }
    // A regular Amazon product page isn't Prime Video (and isn't fetched here).
    assert.equal(LINK_ERR.protected("X").startsWith("X is copy-protected"), true);
  });

  test("readPage stays linear on hostile markup (no ReDoS)", () => {
    // Best of 3, so a busy machine's hiccup isn't mistaken for a regression
    // (the old regex scanner took 10–47 s on the first two).
    const timed = (html) => {
      let best = Infinity;
      for (let r = 0; r < 3; r++) {
        const t0 = process.hrtime.bigint();
        readPage(html);
        best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
      }
      return best;
    };
    const cases = [
      ["300 KB of unclosed <meta", "<meta ".repeat(50_000), 100],
      ["2 MB of unclosed <meta", "<meta ".repeat(350_000), 400],
      ["2000 <video> and one </video>", `${"<video>".repeat(2000)}</video>`, 100],
      ["2000 <video></video>", "<video></video>".repeat(2000), 100],
      ["unclosed quotes", "<meta content='".repeat(20_000), 100],
      ["ld+json scripts", '<script type="application/ld+json">{}</script>'.repeat(5_000), 100],
    ];
    for (const [name, html, ms] of cases) {
      const took = timed(html);
      assert.ok(took <= ms, `${name}: ${took.toFixed(1)} ms`);
    }
    // …and it still reads real markup right.
    const p = readPage(
      `<title>Hi &amp; there</title><metadata content="no"><meta name=x content=it's>
       <meta property="og:title" content="a>b"><meta content = 'c>d' name="q">
       <video src=x.mp4><source src="/s1.m3u8"></video>
       <video><source src="s2.mp4"><source src="s3.webm"></video><source src="orphan.mp4">`
    );
    assert.equal(p.title, "Hi & there");
    assert.deepEqual([...p.meta], [["x", ["it"]], ["og:title", ["a>b"]], ["q", ["c>d"]]]);
    assert.deepEqual(
      p.videos.map((v) => [v.src, v.sources.map((x) => x.src)]),
      [["x.mp4", ["/s1.m3u8"]], [null, ["s2.mp4", "s3.webm"]]]
    );
  });

  test("a probe's fallback GET gets only what's left of the deadline", async () => {
    const t0 = Date.now();
    const r = await resolveLink(`${fx.base}/og-hang`, { ...LOCAL, budgetMs: 1_500 });
    assert.equal(r.error, LINK_ERR.notFound);
    // HEAD answers (uselessly) at 1.2 s; the GET used to get a fresh 1.5 s.
    assert.ok(Date.now() - t0 < 2_200, `took ${Date.now() - t0} ms`);
  });

  test("file / HLS links on private or intranet hosts are refused", async () => {
    for (const url of [
      "http://192.168.1.5/a.mp4",
      "http://10.0.0.1/live.m3u8",
      "http://169.254.169.254/x.m3u8",
      "http://[::1]/a.mp4",
      "http://2130706433/a.mp4",
      "http://localhost:8080/a.mp4",
      "http://foo.localhost/a.webm",
      "http://intranet/a.mp4",
    ]) {
      assert.deepEqual(await resolveLink(url, { cache: false }), { error: LINK_ERR.blocked }, url);
    }
    assert.equal((await resolveLink("https://cdn.example.com/a.mp4", { cache: false })).kind, "file");
  });

  test("Vimeo / Dailymotion / Twitch / YouTube by URL shape, no network", async () => {
    const cases = [
      ["https://vimeo.com/76979871", { kind: "vimeo", id: "76979871" }],
      ["vimeo.com/123456/abcdef1234", { kind: "vimeo", id: "123456", hash: "abcdef1234" }],
      ["https://player.vimeo.com/video/123?h=deadbeef12", { kind: "vimeo", id: "123", hash: "deadbeef12" }],
      ["https://vimeo.com/channels/staffpicks/987654", { kind: "vimeo", id: "987654" }],
      ["https://www.dailymotion.com/video/x8abc12", { kind: "dailymotion", id: "x8abc12" }],
      ["https://dai.ly/x7tgad0", { kind: "dailymotion", id: "x7tgad0" }],
      ["https://geo.dailymotion.com/player.html?video=x8zzz99", { kind: "dailymotion", id: "x8zzz99" }],
      ["https://www.twitch.tv/videos/2233445566", { kind: "twitch", type: "video", id: "2233445566" }],
      ["https://twitch.tv/SomeStreamer", { kind: "twitch", type: "channel", id: "somestreamer" }],
      ["https://player.twitch.tv/?video=v123&parent=x", { kind: "twitch", type: "video", id: "123" }],
    ];
    for (const [input, want] of cases) {
      const got = await resolveLink(input, { cache: false });
      for (const [k, v] of Object.entries(want)) assert.equal(got[k], v, `${input}: ${k}`);
      assert.ok(got.source, `${input}: source`);
      assert.deepEqual(mediaLib.fromClient(got) && mediaLib.key(mediaLib.fromClient(got)), mediaLib.key(got));
    }
    assert.deepEqual(await resolveLink(V0), { kind: "youtube", id: V0 });
    assert.deepEqual(await resolveLink(`https://youtu.be/${V1}`), { kind: "youtube", id: V1 });
    assert.equal((await resolveLink("just some words")).error, LINK_ERR.notLink);
    assert.equal((await resolveLink("javascript:alert(1)")).error, LINK_ERR.notLink);
    assert.equal((await resolveLink("x".repeat(2001))).error, LINK_ERR.notLink);
  });
});

describe("SSRF-safe fetch", () => {
  let fx;
  before(async () => {
    fx = await startFixture();
  });
  after(() => fx.close());

  // Pretend these names are on the internet: public.test is our fixture
  // (127.0.0.1, allowed only for this check), internal.test is a private box.
  const DNS = {
    allowAnyPort: true,
    lookup: async (host) => {
      if (host === "public.test") return [{ address: "127.0.0.1", family: 4 }];
      if (host === "internal.test") return [{ address: "10.0.0.5", family: 4 }];
      if (host === "mixed.test") {
        return [
          { address: "93.184.216.34", family: 4 },
          { address: "192.168.1.1", family: 4 },
        ];
      }
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    },
    isBlocked: (ip) => ip !== "127.0.0.1" && isBlockedAddress(ip),
  };

  test("the address classifier", () => {
    const blocked = [
      "127.0.0.1", "127.255.255.254", "10.0.0.1", "10.255.1.1", "172.16.0.1", "172.31.255.255",
      "192.168.0.1", "169.254.169.254", "100.64.0.1", "100.127.255.255", "0.0.0.0", "0.1.2.3",
      "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255", "192.0.2.1", "198.18.0.1",
      "::", "::1", "[::1]", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
      "::127.0.0.1", "64:ff9b::10.0.0.1", "2002:a00:1::1", "2002:7f00:1::", "fe80::1", "fe80::1%en0",
      "fc00::1", "fd12:3456::1", "fec0::1", "ff02::1", "100::1", "2001:db8::1", "2001::1",
      "not-an-ip", "",
    ];
    for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, ip);
    const ok = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "2a00:1450:4009::200e"];
    for (const ip of ok) assert.equal(isBlockedAddress(ip), false, ip);
  });

  test("private, loopback and metadata addresses are refused (before connecting)", async () => {
    for (const url of [
      `${fx.base}/og`,
      "http://10.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://2130706433/", // 127.0.0.1 as a number
      "http://0x7f.1/",
      "http://localhost/",
    ]) {
      await assert.rejects(safeFetch(url), (e) => e instanceof FetchError && e.code === "blocked", url);
    }
    assert.equal(fx.hits("/og"), 0);
    // …and the resolver says so in words.
    assert.deepEqual(await resolveLink(`${fx.base}/og`, { cache: false }), { error: LINK_ERR.blocked });
    assert.deepEqual(await resolveLink("http://169.254.169.254/latest/meta-data/", { cache: false }), {
      error: LINK_ERR.blocked,
    });
  });

  test("a public page whose video file is on a private host is refused", async () => {
    const r = await resolveLink(`http://public.test:${fx.port}/og-private`, { ...DNS, cache: false });
    assert.deepEqual(r, { error: LINK_ERR.blocked });
  });

  test("a name resolving to a private address (even one of several) is refused", async () => {
    await assert.rejects(safeFetch("http://internal.test/", DNS), (e) => e.code === "blocked");
    await assert.rejects(safeFetch("http://mixed.test/", DNS), (e) => e.code === "blocked");
  });

  test("odd ports and schemes are refused", async () => {
    await assert.rejects(safeFetch("http://public.test:22/", { ...DNS, allowAnyPort: false }), (e) => e.code === "blocked");
    await assert.rejects(safeFetch("ftp://public.test/"), (e) => e.code === "blocked");
    await assert.rejects(safeFetch("file:///etc/passwd"), (e) => e.code === "blocked");
  });

  test("redirects are followed by hand and every hop is re-checked", async () => {
    const pub = `http://public.test:${fx.port}`;
    let lookups = 0;
    const counted = { ...DNS, lookup: (h) => (lookups++, DNS.lookup(h)) };
    const ok = await safeFetch(`${pub}/redir/2`, counted);
    assert.equal(ok.status, 200);
    assert.equal(ok.url, `${pub}/og`);
    assert.match(ok.text(), /og:video/);
    // One DNS answer per hop, and the connection used that answer (pinned).
    assert.equal(lookups, 4);

    await assert.rejects(safeFetch(`${pub}/to-metadata`, DNS), (e) => e.code === "blocked");
    await assert.rejects(safeFetch(`${pub}/to-internal`, DNS), (e) => e.code === "blocked");
    await assert.rejects(safeFetch(`${pub}/to-ftp`, DNS), (e) => e.code === "blocked");
    assert.equal(fx.hits("/og"), 1, "the private hop was never made");
    await assert.rejects(safeFetch(`${pub}/redir/5`, DNS), (e) => e.code === "network" && /redirects/.test(e.message));
    // Through the resolver: a public page bouncing inward is refused.
    assert.deepEqual(await resolveLink(`${pub}/to-internal`, { ...DNS, cache: false }), {
      error: LINK_ERR.blocked,
    });
  });

  test("the pinned lookup: a rebinding DNS can't swap the address mid-request", async () => {
    let calls = 0;
    const rebinding = {
      ...DNS,
      // First answer is fine; any later one would point inside.
      lookup: async () => (++calls === 1 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "10.0.0.5", family: 4 }]),
    };
    const res = await safeFetch(`http://public.test:${fx.port}/og`, rebinding);
    assert.equal(res.status, 200);
    assert.equal(calls, 1);
  });

  test("bodies are capped and slow sites time out", async () => {
    const big = await safeFetch(`${fx.base}/big`, { allowPrivate: true });
    assert.equal(big.truncated, true);
    assert.equal(Buffer.byteLength(big.text()), 2 * 1024 * 1024);
    const small = await safeFetch(`${fx.base}/big`, { allowPrivate: true, maxBytes: 1000 });
    assert.equal(small.text().length, 1000);
    assert.throws(() => small.json(), (e) => e.code === "network");

    const t0 = Date.now();
    await assert.rejects(
      safeFetch(`${fx.base}/slow`, { allowPrivate: true, timeoutMs: 300 }),
      (e) => e.code === "network" && /timeout/.test(e.message)
    );
    assert.ok(Date.now() - t0 < 1500);
    assert.deepEqual(await resolveLink(`${fx.base}/slow`, { ...LOCAL, timeoutMs: 300 }), {
      error: LINK_ERR.unreachable,
    });
    assert.deepEqual(await resolveLink("http://nowhere.test/", { ...DNS, cache: false }), {
      error: LINK_ERR.unreachable,
    });
  });
});

describe("media validation", () => {
  test("fromClient accepts every video kind and rejects junk for each", () => {
    const good = [
      [{ kind: "youtube", id: V0, title: "spoof" }, { kind: "youtube", id: V0 }, `yt:${V0}`],
      [{ kind: "file", url: "https://e.com/a.mp4", mime: "video/MP4", extra: 1 }, { kind: "file", url: "https://e.com/a.mp4", mime: "video/mp4" }, "file:https://e.com/a.mp4"],
      [{ kind: "file", url: "https://e.com/a", mime: "text/html" }, { kind: "file", url: "https://e.com/a" }, "file:https://e.com/a"],
      [{ kind: "hls", url: "http://e.com/x.m3u8" }, { kind: "hls", url: "http://e.com/x.m3u8" }, "hls:http://e.com/x.m3u8"],
      [{ kind: "vimeo", id: "123", hash: "abcdef12" }, { kind: "vimeo", id: "123", hash: "abcdef12" }, "vimeo:123"],
      [{ kind: "vimeo", id: "123", hash: null }, { kind: "vimeo", id: "123" }, "vimeo:123"],
      [{ kind: "dailymotion", id: "x8abc12" }, { kind: "dailymotion", id: "x8abc12" }, "dm:x8abc12"],
      [{ kind: "twitch", type: "video", id: "99" }, { kind: "twitch", type: "video", id: "99" }, "twitch:video:99"],
      [{ kind: "twitch", type: "channel", id: "Some_One" }, { kind: "twitch", type: "channel", id: "some_one" }, "twitch:channel:some_one"],
    ];
    for (const [input, want, k] of good) {
      const got = mediaLib.fromClient(input);
      assert.deepEqual(got, want, JSON.stringify(input));
      assert.equal(mediaLib.key(got), k);
      assert.equal(mediaLib.isTimed(got), true);
    }
    const bad = [
      null, "x", [], {}, { kind: "live", streamId: "s" }, { kind: "nope", id: "1" },
      { kind: "youtube", id: "short" }, { kind: "youtube", id: ["dQw4w9WgXcQ"] },
      { kind: "file" }, { kind: "file", url: "javascript:alert(1)" }, { kind: "file", url: "/relative.mp4" },
      { kind: "file", url: "data:video/mp4;base64,AAAA" }, { kind: "file", url: `https://e.com/${"a".repeat(2000)}.mp4` },
      { kind: "file", url: "https://user:pw@e.com/a.mp4" }, { kind: "file", url: 5 },
      { kind: "hls", url: "ftp://e.com/x.m3u8" }, { kind: "hls", url: {} },
      { kind: "vimeo", id: 5 }, { kind: "vimeo", id: "12a" }, { kind: "vimeo", id: "1", hash: "<script>" },
      { kind: "dailymotion", id: "x" }, { kind: "dailymotion", id: "../../etc" },
      { kind: "twitch", id: "99" }, { kind: "twitch", type: "clip", id: "x" },
      { kind: "twitch", type: "video", id: "abc" }, { kind: "twitch", type: "channel", id: "a b" },
    ];
    for (const b of bad) assert.equal(mediaLib.fromClient(b), null, JSON.stringify(b));
    // A file / HLS link every viewer would fetch must be on a public host.
    for (const url of ["http://192.168.0.2/a.mp4", "http://127.0.0.1:3000/a.mp4", "http://[fe80::1]/a.mp4", "http://localhost/a.mp4", "http://nas/a.mp4"]) {
      assert.equal(mediaLib.fromClient({ kind: "file", url }), null, url);
      assert.equal(mediaLib.fromClient({ kind: "hls", url }), null, url);
      assert.equal(mediaLib.refusal({ kind: "file", url }), "That link can't be opened", url);
      assert.deepEqual(mediaLib.fromClient({ kind: "file", url }, { allowPrivate: true }), { kind: "file", url });
    }
    assert.equal(mediaLib.refusal({ kind: "file", url: "https://e.com/a.mp4" }), null);
    assert.equal(mediaLib.isTimed({ kind: "live", streamId: "s" }), false);
    assert.equal(mediaLib.isTimed(null), false);
  });

  test("infoFrom keeps only clean display fields", () => {
    assert.deepEqual(
      mediaLib.infoFrom({
        title: `  ${"t".repeat(300)}\u0000 `,
        author: 7,
        thumb: "javascript:x",
        duration: 1e9,
        source: "https://e.com/page",
        evil: true,
      }),
      { title: "t".repeat(120), source: "https://e.com/page" }
    );
  });
});

describe("links over sockets", () => {
  let fx;
  let srv;
  before(async () => {
    fx = await startFixture();
    srv = await startServer({ resolveOptions: { ...LOCAL, timeoutMs: 1_500 } });
  });
  afterEach(() => srv.disconnectAll());
  after(async () => {
    await srv.stop();
    await fx.close();
  });

  async function pair() {
    const code = roomCode();
    const host = await srv.connect();
    await join(host, { code, name: "Host", clientId: `h-${code}` });
    const viewer = await srv.connect();
    await join(viewer, { code, name: "Viewer", clientId: `v-${code}` });
    return { code, host, viewer };
  }

  const loadAck = (sock, payload, timeout = 8000) =>
    sock.timeout(timeout).emitWithAck("player:action", { type: "load", ...payload });

  test("load by link: ack ok, everyone gets it, and it syncs like YouTube", async () => {
    const { code, host, viewer } = await pair();
    const url = `${fx.base}/stream`;
    const seen = once(viewer, "player:action", (a) => a.type === "load" && a.media?.kind === "file", 8000);
    const res = await loadAck(host, { input: `  ${url}  ` });
    assert.deepEqual(res, { ok: true });
    const a = await seen;
    assert.equal(a.media.url, url);
    assert.equal(a.media.mime, "video/mp4");
    assert.equal(a.by, "Host");
    const k = `file:${url}`;

    // Ticks, play/pause/seek with the key, meta and ended all work.
    const tick = once(viewer, "player:tick", (t) => t.key === k);
    const seek = once(viewer, "player:action", (x) => x.type === "seek" && x.time === 20);
    host.emit("player:action", { type: "seek", time: 20, key: k });
    await seek;
    await tick;
    host.emit("player:meta", { key: k, duration: 300 });
    await ping(host);
    const room = srv.rt.rooms.get(code);
    assert.equal(room.duration, 300);

    // Something new: the file goes to history.
    await loadAck(host, { input: "https://vimeo.com/123456" });
    assert.equal(room.media.kind, "vimeo");
    assert.equal(room.history[0].media.url, url);
    // And can be loaded back by identity, keeping what the room knew.
    assert.deepEqual(await loadAck(host, { media: { kind: "file", url, title: "spoofed" } }), { ok: true });
    // ("stream" is a generic name, so the file was titled by its host.)
    assert.equal(room.media.title, "127.0.0.1");
    assert.equal(room.media.source, url);
  });

  test("failures come back on the ack with a human message", async () => {
    const { host } = await pair();
    assert.deepEqual(await loadAck(host, { input: `${fx.base}/none` }), { ok: false, error: LINK_ERR.notFound });
    assert.deepEqual(await loadAck(host, { input: "https://www.netflix.com/watch/1" }), {
      ok: false,
      error: "Netflix is copy-protected and can't be played here — each person needs to watch it on their own account.",
    });
    assert.deepEqual(await loadAck(host, { input: "hello" }), { ok: false, error: LINK_ERR.notLink });
    assert.equal((await loadAck(host, { media: { kind: "live", streamId: "x" } })).ok, false);
  });

  test("a viewer without video control is refused before anything is fetched", async () => {
    const { host, viewer } = await pair();
    const before = fx.hits("/og");
    const snap = once(viewer, "player:action", (a) => a.denied === true);
    const res = await loadAck(viewer, { input: `${fx.base}/og` });
    assert.deepEqual(res, { ok: false, error: "Only the host can change the video" });
    await snap;
    assert.equal(fx.hits("/og"), before);
    await ping(host);
  });

  test("losing the right while the link resolves means it never lands", async () => {
    const { code, host, viewer } = await pair();
    host.emit("host:perm", { targetId: viewer.id, perm: "video", value: true });
    await ping(host);
    const pending = loadAck(viewer, { input: `${fx.base}/slow` }, 10_000);
    await sleep(100);
    host.emit("host:perm", { targetId: viewer.id, perm: "video", value: false });
    // The slow fetch times out on its own — wait for the ack.
    const res = await pending;
    assert.equal(res.ok, false);
    assert.equal(srv.rt.rooms.get(code).media, null);
  });

  test("queue:add by link resolves the media; the same video by another link is a duplicate", async () => {
    const { code, host } = await pair();
    // Something on stage so the suggestion queues instead of playing.
    await loadAck(host, { input: `https://www.youtube.com/watch?v=${V0}` });
    const res = await host.timeout(8000).emitWithAck("queue:add", { input: `${fx.base}/og` });
    assert.deepEqual(res, { ok: true, status: "ready" });
    const room = srv.rt.rooms.get(code);
    assert.equal(room.queue.length, 1);
    assert.deepEqual(room.queue[0].media, {
      kind: "file",
      url: `${fx.base}/v/movie.mp4?a=1&b=2`,
      mime: "video/mp4",
      title: "Tom & Jerry — ep 1",
      thumb: `${fx.base}/img/poster.jpg`,
      source: `${fx.base}/og`,
    });
    const again = await host.timeout(8000).emitWithAck("queue:add", { input: `${fx.base}/og2` });
    assert.equal(again.duplicate, true);
    assert.equal(room.queue.length, 1);
    const bad = await host.timeout(8000).emitWithAck("queue:add", { input: `${fx.base}/clip-page` });
    assert.deepEqual(bad, { ok: false, error: LINK_ERR.twitchClip });
    // Playing it from the queue syncs by its key.
    const item = room.queue[0];
    host.emit("queue:play", { id: item.id });
    await ping(host);
    assert.equal(mediaLib.key(room.media), `file:${fx.base}/v/movie.mp4?a=1&b=2`);
    assert.equal(room.moments.key, mediaLib.key(room.media));
  });

  test("a link that resolves after someone else changed the video doesn't land", async () => {
    const { code, host, viewer } = await pair();
    host.emit("host:perm", { targetId: viewer.id, perm: "video", value: true });
    await ping(host);
    const pending = loadAck(host, { input: `${fx.base}/delay-og` });
    await sleep(150);
    assert.deepEqual(await loadAck(viewer, { media: { kind: "youtube", id: V1 } }), { ok: true });
    assert.deepEqual(await pending, { ok: false, error: "The video changed while finding that link" });
    assert.equal(srv.rt.rooms.get(code).media.id, V1);
  });

  test("a load always gets an ack: not in a room, rate limited", async () => {
    const stray = await srv.connect();
    assert.deepEqual(await loadAck(stray, { media: { kind: "youtube", id: V0 } }), {
      ok: false,
      error: "You're not in this room",
    });
    const { host } = await pair();
    const acks = await Promise.all(
      Array.from({ length: 13 }, () => loadAck(host, { media: { kind: "youtube", id: V0 } }))
    );
    assert.deepEqual(acks.at(-1), { ok: false, error: "Slow down a little" });
  });

  test("resolving is rate limited per socket", async () => {
    const limited = await startServer({ resolveOptions: LOCAL, resolvePerSocket: [2, 60_000] });
    try {
      const host = await limited.connect();
      await join(host, { code: roomCode(), name: "Host", clientId: "rl-host" });
      const ask = (i) => host.timeout(8000).emitWithAck("player:action", { type: "load", input: `${fx.base}/v/${i}.mp4` });
      assert.equal((await ask(1)).ok, true);
      assert.equal((await ask(2)).ok, true);
      assert.deepEqual(await ask(3), { ok: false, error: "Slow down a little" });
      // YouTube links don't need resolving and aren't counted.
      const yt1 = await host.timeout(2000).emitWithAck("player:action", { type: "load", input: V1 });
      assert.equal(yt1.ok, true);
    } finally {
      await limited.stop();
    }
  });
});

describe("private-host files over sockets", () => {
  test("load / queue:add of a file on a private host are refused", async () => {
    const plain = await startServer();
    try {
      const host = await plain.connect();
      await join(host, { code: roomCode(), name: "Host", clientId: "ph-host" });
      const bad = { kind: "file", url: "http://192.168.0.10/a.mp4" };
      const no = { ok: false, error: "That link can't be opened" };
      assert.deepEqual(await host.timeout(4000).emitWithAck("player:action", { type: "load", media: bad }), no);
      assert.deepEqual(await host.timeout(4000).emitWithAck("queue:add", { media: bad }), no);
      const ok = await host
        .timeout(4000)
        .emitWithAck("player:action", { type: "load", media: { kind: "file", url: "https://cdn.example.com/a.mp4" } });
      assert.deepEqual(ok, { ok: true });
    } finally {
      await plain.stop();
    }
  });
});

describe("persistence of every video kind", () => {
  test("a vimeo on stage and a file in the queue survive a restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playcircle-links-"));
    const dataFile = path.join(dir, "rooms.json");
    const fx = await startFixture();
    const code = roomCode();
    let a;
    let b;
    try {
      a = await startServer({ dataFile, resolveOptions: LOCAL });
      const owner = await a.connect();
      await join(owner, { code, name: "Owner", clientId: "links-owner" });
      const loaded = await owner
        .timeout(8000)
        .emitWithAck("player:action", { type: "load", input: "https://vimeo.com/123456/abcdef1234" });
      assert.equal(loaded.ok, true);
      owner.emit("player:action", { type: "pause", time: 42, key: "vimeo:123456" });
      const queued = await owner.timeout(8000).emitWithAck("queue:add", { input: `${fx.base}/og` });
      assert.equal(queued.ok, true);
      await ping(owner);
      a.rt.flush();
      await a.stop();

      // Tamper with the snapshot: junk media in history must not come back.
      const saved = JSON.parse(fs.readFileSync(dataFile, "utf8"));
      const r = saved.rooms.find((x) => x.code === code);
      r.history = [
        { media: { kind: "file", url: "javascript:alert(1)" }, playedAt: 1 },
        { media: { kind: "twitch", type: "channel", id: "good_one", title: "Good" }, playedAt: 2 },
      ];
      r.queue[0].media.thumb = "javascript:bad";
      fs.writeFileSync(dataFile, JSON.stringify(saved));

      const origLog = console.log;
      console.log = () => {};
      try {
        b = await startServer({ dataFile, resolveOptions: LOCAL });
      } finally {
        console.log = origLog;
      }
      const st = await join(await b.connect(), { code, name: "Owner", clientId: "links-owner" });
      assert.deepEqual(st.media, {
        kind: "vimeo",
        id: "123456",
        hash: "abcdef1234",
        source: "https://vimeo.com/123456/abcdef1234",
      });
      assert.ok(Math.abs(st.time - 42) < 0.01);
      assert.equal(st.queue.items.length, 1);
      assert.deepEqual(st.queue.items[0].media, {
        kind: "file",
        url: `${fx.base}/v/movie.mp4?a=1&b=2`,
        mime: "video/mp4",
        title: "Tom & Jerry — ep 1",
        source: `${fx.base}/og`,
      });
      assert.deepEqual(
        st.queue.history.map((h) => h.media),
        [{ kind: "twitch", type: "channel", id: "good_one", title: "Good" }]
      );
    } finally {
      await a?.stop();
      await b?.stop();
      await fx.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
