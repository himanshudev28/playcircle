// Custom Next.js server with Socket.IO for real-time room sync + chat.
const { createServer } = require("http");
const next = require("next");
const { Server } = require("socket.io");

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
      hostId: null,
      users: new Map(), // socketId -> { name, color }
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

function snapshot(room) {
  return {
    videoId: room.videoId,
    isPlaying: room.isPlaying,
    time: currentTime(room),
    hostId: room.hostId,
    users: [...room.users.entries()].map(([id, u]) => ({ id, ...u })),
  };
}

app.prepare().then(() => {
  const server = createServer((req, res) => handle(req, res));
  const io = new Server(server, { cors: { origin: "*" } });

  // Push the live public-room list to anyone watching the lobby.
  function broadcastLobby() {
    io.to(LOBBY_CHANNEL).emit("lobby:list", publicRoomList());
  }

  io.on("connection", (socket) => {
    let joinedCode = null;

    socket.on("room:join", ({ code, name, title, isPublic }) => {
      if (!code) return;
      code = String(code).toUpperCase().trim();
      const displayName = (name || "Guest").toString().slice(0, 24);
      const isNew = !rooms.has(code);
      const room = getRoom(code);

      // The first person in the room (its creator) sets its metadata.
      if (isNew) {
        room.isPublic = !!isPublic;
        room.title = title ? String(title).slice(0, 60) : null;
      }

      joinedCode = code;
      socket.join(code);
      const color = COLORS[room.users.size % COLORS.length];
      room.users.set(socket.id, { name: displayName, color });
      if (!room.hostId) room.hostId = socket.id;

      // Send current state to the newcomer.
      socket.emit("room:state", {
        ...snapshot(room),
        youAreHost: room.hostId === socket.id,
        messages: room.messages.slice(-50),
      });

      const sys = {
        id: `s-${socket.id}-${room.messages.length}`,
        system: true,
        text: `${displayName} joined the room`,
        ts: Date.now(),
      };
      room.messages.push(sys);

      // Tell everyone about the updated user list + system message.
      io.to(code).emit("room:users", snapshot(room).users);
      io.to(code).emit("chat:message", sys);
      if (room.isPublic) broadcastLobby();
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
      if (!joinedCode) return;
      const room = rooms.get(joinedCode);
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
      socket.to(joinedCode).emit("player:action", {
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
      if (!joinedCode) return;
      const room = rooms.get(joinedCode);
      if (!room) return;
      socket.emit("player:action", {
        type: room.isPlaying ? "play" : "pause",
        time: currentTime(room),
        videoId: room.videoId,
        isPlaying: room.isPlaying,
      });
    });

    socket.on("chat:message", ({ text }) => {
      if (!joinedCode) return;
      const room = rooms.get(joinedCode);
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
      io.to(joinedCode).emit("chat:message", msg);
    });

    socket.on("disconnect", () => {
      if (!joinedCode) return;
      const room = rooms.get(joinedCode);
      if (!room) return;
      const user = room.users.get(socket.id);
      room.users.delete(socket.id);

      if (room.hostId === socket.id) {
        room.hostId = room.users.keys().next().value || null;
      }

      const wasPublic = room.isPublic;

      if (room.users.size === 0) {
        rooms.delete(joinedCode);
        if (wasPublic) broadcastLobby();
        return;
      }

      if (user) {
        const sys = {
          id: `s-left-${socket.id}-${Date.now()}`,
          system: true,
          text: `${user.name} left the room`,
          ts: Date.now(),
        };
        room.messages.push(sys);
        io.to(joinedCode).emit("chat:message", sys);
      }
      io.to(joinedCode).emit("room:users", snapshot(room).users);
      io.to(joinedCode).emit("room:host", room.hostId);
      if (wasPublic) broadcastLobby();
    });
  });

  server.listen(port, () => {
    console.log(`> watchnparty ready on http://${hostname}:${port}`);
  });
});
