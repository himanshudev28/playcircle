// Custom Next.js server with Socket.IO for real-time room sync + chat.
const { createServer } = require("http");
const next = require("next");
const { Server } = require("socket.io");
const crypto = require("crypto");

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST || "localhost";
const port = parseInt(process.env.PORT || "3000", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// In-memory room store. Fine for a single-process demo; swap for Redis to scale.
/** @type {Map<string, Room>} */
const rooms = new Map();

const COLORS = [
  "#f0454b", "#f59e0b", "#10b981", "#3b82f6",
  "#a855f7", "#ec4899", "#14b8a6", "#eab308",
];

// Global anonymous community feed ("venting"). Newest last; capped.
const LOBBY_CHANNEL = "__lobby__";
const vents = []; // { id, alias, emoji, text, ts }
const VENT_ALIASES = [
  "Night Owl", "Quiet Wanderer", "Lost Signal", "Blue Hour", "Static Ghost",
  "Paper Moon", "Slow Comet", "Velvet Static", "Echo", "Stranger",
];
const VENT_EMOJIS = ["🌙", "🫧", "🌧️", "⭐", "🔮", "🍃", "🌊", "🕯️", "👻", "🌌"];

// A host who drops (refresh, flaky wifi) gets this long to come back before
// the crown passes to someone else. An empty room is kept just as long so a
// solo host refreshing doesn't lose the lock / removed list.
const HOST_GRACE_MS = 20_000;
const EMPTY_ROOM_TTL_MS = 30_000;
// A refresh is a disconnect + reconnect; only announce "left" if the person
// is still gone after this long, so reloads don't spam the chat.
const LEAVE_ANNOUNCE_DELAY_MS = 5_000;
// An ended room's code stays dead this long, so a reload (or someone
// mid-reconnect) can't silently recreate it — and its removed list with it.
const ENDED_TTL_MS = 10 * 60_000;
/** @type {Map<string, number>} code -> endedAt */
const endedCodes = new Map();

// Tells tabs of the same browser apart from other people without ever
// exposing the clientId itself (which is what proves host identity).
const BROWSER_KEY = crypto.randomBytes(16);
function browserTag(clientId) {
  return crypto
    .createHmac("sha256", BROWSER_KEY)
    .update(clientId)
    .digest("base64url")
    .slice(0, 12);
}

function getRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = {
      code,
      title: null,
      isPublic: false,
      createdAt: Date.now(),
      videoId: null,
      isPlaying: false,
      time: 0, // playhead position (seconds) as of updatedAt
      updatedAt: Date.now(),
      hostId: null, // socket id of the host (null while they reconnect)
      hostClientId: null, // stable per-browser id, survives refreshes
      hostTimer: null,
      deleteTimer: null,
      locked: false, // locked rooms only admit people who were already in
      members: new Set(), // clientIds ever admitted
      banned: new Set(), // clientIds the host removed
      users: new Map(), // socketId -> { name, color, clientId }
      callers: new Map(), // socketId -> { mic, cam, session }
      pendingLeaves: new Map(), // clientId -> timer for a deferred "left" line
      messages: [], // { id, name, color, text, ts, system? }
    };
    rooms.set(code, room);
  }
  return room;
}

// Public rooms with at least one viewer, shaped for the lobby list.
function publicRoomList() {
  return [...rooms.values()]
    .filter((r) => r.isPublic && r.users.size > 0)
    .map((r) => ({
      code: r.code,
      title: r.title || "Untitled room",
      videoId: r.videoId,
      isPlaying: r.isPlaying,
      count: r.users.size,
      hosts: [...r.users.values()].slice(0, 4).map((u) => ({
        name: u.name,
        color: u.color,
      })),
    }))
    .sort((a, b) => b.count - a.count);
}

// Current playhead accounting for elapsed real time while playing.
function currentTime(room) {
  if (!room.isPlaying) return room.time;
  return room.time + (Date.now() - room.updatedAt) / 1000;
}

// Public view of the people in a room. clientIds stay server-side: they are
// what proves host identity, so they must never be broadcast.
function publicUsers(room) {
  return [...room.users.entries()].map(([id, u]) => {
    const c = room.callers.get(id);
    return {
      id,
      name: u.name,
      color: u.color,
      browser: browserTag(u.clientId),
      call: c ? { mic: c.mic, cam: c.cam } : null,
    };
  });
}

function snapshot(room) {
  return {
    videoId: room.videoId,
    isPlaying: room.isPlaying,
    time: currentTime(room),
    hostId: room.hostId,
    locked: room.locked,
    users: publicUsers(room),
  };
}

function systemMessage(room, text) {
  const sys = {
    id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    system: true,
    text,
    ts: Date.now(),
  };
  room.messages.push(sys);
  if (room.messages.length > 200) room.messages.shift();
  return sys;
}

function destroyRoom(room) {
  for (const t of room.pendingLeaves.values()) clearTimeout(t);
  clearTimeout(room.hostTimer);
  clearTimeout(room.deleteTimer);
  rooms.delete(room.code);
}

app.prepare().then(() => {
  const server = createServer((req, res) => handle(req, res));
  const io = new Server(server, { cors: { origin: "*" } });

  // Push the live public-room list to anyone watching the lobby.
  function broadcastLobby() {
    io.to(LOBBY_CHANNEL).emit("lobby:list", publicRoomList());
  }

  function broadcastUsers(room) {
    io.to(room.code).emit("room:users", publicUsers(room));
  }

  function emitSystem(room, text) {
    io.to(room.code).emit("chat:message", systemMessage(room, text));
  }

  function setHost(room, socketId) {
    room.hostId = socketId;
    const u = socketId ? room.users.get(socketId) : null;
    if (u) room.hostClientId = u.clientId;
    clearTimeout(room.hostTimer);
    room.hostTimer = null;
    io.to(room.code).emit("room:host", room.hostId);
  }

  // Take one socket out of its room — on disconnect, removal, or a voluntary
  // leave. Handles host hand-off, call teardown and empty-room cleanup.
  function detach(socket, { announce = true, verb = "left" } = {}) {
    const code = socket.data.code;
    if (!code) return;
    socket.data.code = null;
    socket.leave(code);
    const room = rooms.get(code);
    if (!room) return;

    const user = room.users.get(socket.id);
    room.users.delete(socket.id);
    if (room.callers.delete(socket.id)) {
      io.to(code).emit("call:left", socket.id);
    }

    if (room.hostId === socket.id) {
      // Same browser in another tab keeps the crown; otherwise hold it for
      // the host to reconnect — even if the room is momentarily empty —
      // before anyone else can take it.
      const sibling = [...room.users.entries()].find(
        ([, u]) => u.clientId === room.hostClientId
      );
      if (sibling) {
        setHost(room, sibling[0]);
      } else {
        room.hostId = null;
        io.to(code).emit("room:host", null);
        clearTimeout(room.hostTimer);
        room.hostTimer = setTimeout(() => {
          room.hostTimer = null;
          if (rooms.get(code) !== room) return;
          if (room.hostId || room.users.size === 0) return;
          const [nextId, next] = room.users.entries().next().value;
          setHost(room, nextId);
          emitSystem(room, `${next.name} is now the host`);
        }, HOST_GRACE_MS);
      }
    }

    if (room.users.size === 0) {
      clearTimeout(room.deleteTimer);
      room.deleteTimer = setTimeout(() => {
        if (rooms.get(code) === room && room.users.size === 0) destroyRoom(room);
      }, EMPTY_ROOM_TTL_MS);
      if (room.isPublic) broadcastLobby();
      return;
    }

    if (user && announce) {
      const { clientId, name } = user;
      clearTimeout(room.pendingLeaves.get(clientId));
      room.pendingLeaves.set(
        clientId,
        setTimeout(() => {
          room.pendingLeaves.delete(clientId);
          if (rooms.get(code) !== room) return;
          const back = [...room.users.values()].some(
            (u) => u.clientId === clientId
          );
          if (!back) emitSystem(room, `${name} ${verb} the room`);
        }, LEAVE_ANNOUNCE_DELAY_MS)
      );
    }
    broadcastUsers(room);
    if (room.isPublic) broadcastLobby();
  }

  // The room this socket is in, and only if it is currently the host.
  function hostRoom(socket) {
    const room = socket.data.code && rooms.get(socket.data.code);
    if (!room || room.hostId !== socket.id) return null;
    return room;
  }

  io.on("connection", (socket) => {
    socket.data.code = null;

    const currentRoom = () =>
      (socket.data.code && rooms.get(socket.data.code)) || null;

    socket.on("room:join", ({ code, name, title, isPublic, clientId }) => {
      if (!code) return;
      code = String(code).toUpperCase().trim();
      const cid = String(clientId || socket.id).slice(0, 64);
      const displayName = (name || "Guest").toString().slice(0, 24);

      // Same socket asking for the same room again (a remount): just resend
      // state rather than announcing a leave + join.
      const already = rooms.get(code);
      if (socket.data.code === code && already?.users.has(socket.id)) {
        socket.emit("room:state", {
          ...snapshot(already),
          selfBrowser: browserTag(cid),
          messages: already.messages.slice(-50),
        });
        return;
      }
      if (socket.data.code) detach(socket, { announce: false });

      const endedAt = endedCodes.get(code);
      if (endedAt && Date.now() - endedAt < ENDED_TTL_MS) {
        socket.emit("room:denied", { reason: "ended" });
        return;
      }
      endedCodes.delete(code);

      const isNew = !rooms.has(code);
      const existing = rooms.get(code);
      if (existing && existing.banned.has(cid)) {
        socket.emit("room:denied", { reason: "removed" });
        return;
      }
      if (
        existing &&
        existing.locked &&
        !existing.members.has(cid) &&
        existing.hostClientId !== cid
      ) {
        socket.emit("room:denied", { reason: "locked" });
        return;
      }

      const room = getRoom(code);
      clearTimeout(room.deleteTimer);
      room.deleteTimer = null;

      // The first person in the room (its creator) sets its metadata.
      if (isNew) {
        room.isPublic = !!isPublic;
        room.title = title ? String(title).slice(0, 60) : null;
      }

      // Back within the grace window, or just another tab: no "joined" line.
      const quietJoin =
        room.pendingLeaves.has(cid) ||
        [...room.users.values()].some((u) => u.clientId === cid);
      clearTimeout(room.pendingLeaves.get(cid));
      room.pendingLeaves.delete(cid);

      socket.data.code = code;
      socket.join(code);
      const color = COLORS[room.members.size % COLORS.length];
      room.members.add(cid);
      room.users.set(socket.id, { name: displayName, color, clientId: cid });

      // Returning host reclaims the crown; otherwise an unclaimed room goes to
      // whoever walks in (unless we're still holding it for a reconnect).
      if (!room.hostClientId || room.hostClientId === cid) {
        setHost(room, socket.id);
      } else if (!room.hostId && !room.hostTimer) {
        setHost(room, socket.id);
      }

      // Send current state to the newcomer.
      socket.emit("room:state", {
        ...snapshot(room),
        selfBrowser: browserTag(cid),
        messages: room.messages.slice(-50),
      });

      if (!quietJoin) emitSystem(room, `${displayName} joined the room`);
      broadcastUsers(room);
      if (room.isPublic) broadcastLobby();
    });

    socket.on("room:leave", ({ code } = {}) => {
      if (code && String(code).toUpperCase() !== socket.data.code) return;
      detach(socket);
    });

    // ---- Host controls ----
    socket.on("host:kick", ({ targetId }) => {
      const room = hostRoom(socket);
      if (!room || targetId === socket.id) return;
      const target = room.users.get(targetId);
      if (!target) return;
      // Your own other tab shares your clientId — banning it would ban you.
      if (target.clientId === room.users.get(socket.id)?.clientId) return;
      room.banned.add(target.clientId);
      room.members.delete(target.clientId);
      // Every tab that browser has open in this room goes, not just one.
      for (const [sid, u] of [...room.users.entries()]) {
        if (u.clientId !== target.clientId) continue;
        const s = io.sockets.sockets.get(sid);
        if (!s) continue;
        s.emit("room:denied", { reason: "removed" });
        detach(s, { announce: false });
      }
      emitSystem(room, `${target.name} was removed by the host`);
    });

    socket.on("host:transfer", ({ targetId }) => {
      const room = hostRoom(socket);
      if (!room || targetId === socket.id) return;
      const target = room.users.get(targetId);
      if (!target) return;
      setHost(room, targetId);
      emitSystem(room, `${target.name} is now the host`);
    });

    socket.on("host:mute", ({ targetId }) => {
      const room = hostRoom(socket);
      if (!room || !room.callers.has(targetId)) return;
      io.to(targetId).emit("call:force-mute");
    });

    socket.on("host:lock", ({ locked }) => {
      const room = hostRoom(socket);
      if (!room) return;
      room.locked = !!locked;
      io.to(room.code).emit("room:locked", room.locked);
      emitSystem(
        room,
        room.locked
          ? "The host locked the room — no new people can join"
          : "The host unlocked the room"
      );
    });

    socket.on("host:end", () => {
      const room = hostRoom(socket);
      if (!room) return;
      for (const sid of room.users.keys()) {
        const s = io.sockets.sockets.get(sid);
        if (!s) continue;
        s.emit("room:denied", { reason: "ended" });
        s.leave(room.code);
        s.data.code = null;
      }
      const wasPublic = room.isPublic;
      destroyRoom(room);
      const now = Date.now();
      for (const [c, t] of endedCodes) {
        if (now - t >= ENDED_TTL_MS) endedCodes.delete(c);
      }
      endedCodes.set(room.code, now);
      if (wasPublic) broadcastLobby();
    });

    // ---- Voice / video calls (WebRTC mesh, signaled through here) ----
    // Acked, so a call:join that arrives before room:join (buffered while the
    // socket was reconnecting) fails loudly instead of leaving a ghost seat.
    socket.on("call:join", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const room = currentRoom();
      if (!room || !room.users.has(socket.id)) return reply({ ok: false });
      const { mic, cam } = payload || {};
      const peers = [...room.callers.entries()]
        .filter(([id]) => id !== socket.id)
        .map(([id, c]) => ({ id, session: c.session }));
      // Each seat gets a fresh session id; signals are addressed to a session,
      // so leftovers from before a leave + rejoin are dropped, not misapplied.
      const session = crypto.randomUUID();
      room.callers.set(socket.id, { mic: !!mic, cam: !!cam, session });
      // The newcomer sends the offers, so two peers never both offer at once.
      reply({ ok: true, session, peers });
      broadcastUsers(room);
    });

    socket.on("call:signal", ({ to, toSession, data } = {}) => {
      const room = currentRoom();
      const from = room && room.callers.get(socket.id);
      const target = room && room.callers.get(to);
      if (!from || !target || target.session !== toSession) return;
      io.to(to).emit("call:signal", {
        from: socket.id,
        fromSession: from.session,
        data,
      });
    });

    socket.on("call:state", ({ mic, cam } = {}) => {
      const room = currentRoom();
      const seat = room && room.callers.get(socket.id);
      if (!seat) return;
      seat.mic = !!mic;
      seat.cam = !!cam;
      broadcastUsers(room);
    });

    socket.on("call:leave", () => {
      const room = currentRoom();
      if (!room || !room.callers.delete(socket.id)) return;
      io.to(room.code).emit("call:left", socket.id);
      broadcastUsers(room);
    });

    // ---- Public lobby ----
    socket.on("lobby:subscribe", () => {
      socket.join(LOBBY_CHANNEL);
      socket.emit("lobby:list", publicRoomList());
    });
    socket.on("lobby:unsubscribe", () => socket.leave(LOBBY_CHANNEL));

    // ---- Anonymous venting feed ----
    socket.on("vent:list", () => {
      socket.emit("vent:list", vents.slice(-60));
    });
    socket.on("vent:post", ({ text }) => {
      const clean = String(text || "").slice(0, 400).trim();
      if (!clean) return;
      const seed = vents.length + socket.id.charCodeAt(0);
      const vent = {
        id: `v-${socket.id}-${Date.now()}`,
        alias: VENT_ALIASES[seed % VENT_ALIASES.length],
        emoji: VENT_EMOJIS[seed % VENT_EMOJIS.length],
        text: clean,
        ts: Date.now(),
      };
      vents.push(vent);
      if (vents.length > 300) vents.shift();
      io.emit("vent:new", vent);
    });

    socket.on("player:action", ({ type, time, videoId }) => {
      const room = currentRoom();
      if (!room) return;

      switch (type) {
        case "load":
          room.videoId = videoId;
          room.time = 0;
          room.isPlaying = true;
          break;
        case "play":
          room.isPlaying = true;
          if (typeof time === "number") room.time = time;
          break;
        case "pause":
          room.isPlaying = false;
          if (typeof time === "number") room.time = time;
          break;
        case "seek":
          if (typeof time === "number") room.time = time;
          break;
        default:
          return;
      }
      room.updatedAt = Date.now();

      // Relay to everyone else in the room.
      socket.to(room.code).emit("player:action", {
        type,
        time: room.time,
        videoId: room.videoId,
        isPlaying: room.isPlaying,
        by: room.users.get(socket.id)?.name,
      });
      if (room.isPublic && type === "load") broadcastLobby();
    });

    // Late joiners / drift correction can ask for the authoritative state.
    socket.on("player:request-sync", () => {
      const room = currentRoom();
      if (!room) return;
      socket.emit("player:action", {
        type: room.isPlaying ? "play" : "pause",
        time: currentTime(room),
        videoId: room.videoId,
        isPlaying: room.isPlaying,
      });
    });

    socket.on("chat:message", ({ text }) => {
      const room = currentRoom();
      if (!room) return;
      const user = room.users.get(socket.id);
      if (!user) return;
      const clean = String(text || "").slice(0, 500).trim();
      if (!clean) return;
      const msg = {
        id: `m-${socket.id}-${Date.now()}`,
        name: user.name,
        color: user.color,
        text: clean,
        ts: Date.now(),
      };
      room.messages.push(msg);
      if (room.messages.length > 200) room.messages.shift();
      io.to(room.code).emit("chat:message", msg);
    });

    socket.on("disconnect", () => detach(socket));
  });

  server.listen(port, () => {
    console.log(`> PlayCircle ready on http://${hostname}:${port}`);
  });
});
