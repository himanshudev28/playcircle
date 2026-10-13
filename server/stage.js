// Live sharing: one presenter streams a browser tab, their screen, a
// camera, or a local video file to everyone else over WebRTC. The server only decides
// who may present and relays signaling between the presenter and each
// viewer; media never touches it.
//
// Every share gets a fresh streamId and every signal carries it, so nothing
// from an earlier share can land on a new one. The share ends when the
// presenter stops, leaves, disconnects, or loses video control.

const crypto = require("crypto");
const { str, oneOf } = require("./limits");

const SOURCE_TITLES = {
  tab: "Shared tab",
  screen: "Shared screen",
  file: "Shared video file",
  camera: "Live camera",
};
const QUALITIES = ["auto", "1080", "720", "480"];

// Signals are relayed exactly as sent (the client adds its own fields, e.g.
// a negotiation counter, next to sdp / candidate). They only have to be a
// plain object of a sane size; an SDP is a few kB.
const MAX_SIGNAL_BYTES = 32_000;
function validSignal(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  try {
    return JSON.stringify(data).length <= MAX_SIGNAL_BYTES;
  } catch {
    return false;
  }
}

module.exports = function registerStage(ctx) {
  const { io } = ctx;

  // The share on stage, if it's the one this streamId names.
  function liveStage(room, streamId) {
    const m = room.media;
    return m && m.kind === "live" && typeof streamId === "string" && m.streamId === streamId
      ? m
      : null;
  }

  function stop(room, by, text) {
    ctx.setMedia(room, null, { by, playing: false });
    if (text) ctx.emitSystem(room, text);
  }

  ctx.onDetach((room, socketId, user) => {
    const m = room.media;
    if (!m || m.kind !== "live") return;
    if (m.presenter === socketId) {
      const name = user?.name || "The presenter";
      stop(room, null, room.users.size > 0 ? `${name} stopped sharing` : null);
    } else {
      io.to(m.presenter).emit("stage:viewer-left", { id: socketId, streamId: m.streamId });
    }
  });

  // Lost the right to drive the stage → the share ends.
  ctx.permsChanged = (room) => {
    const m = room.media;
    if (!m || m.kind !== "live" || !room.users.has(m.presenter)) return;
    if (ctx.effectivePerms(room, m.presenter).video) return;
    io.to(m.presenter).emit(
      "room:notice",
      "Your share ended — the host took back video control"
    );
    stop(room, null, `${m.by}'s share ended`);
  };

  return {
    connection(socket, on) {
      const allow = socket.data.allow;

      on("stage:start", (p, reply) => {
        const room = ctx.roomOf(socket);
        if (!room) return reply({ ok: false });
        if (!ctx.effectivePerms(room, socket.id).video) {
          return reply({ ok: false, error: "Only people with video control can share" });
        }
        const source = oneOf(p.source, ["tab", "screen", "file", "camera"]);
        if (!source) return reply({ ok: false, error: "Pick a tab, screen, camera or file" });
        if (!allow("stage:start", 4, 20_000)) {
          return reply({ ok: false, error: "Slow down a little" });
        }
        const streamId = crypto.randomUUID();
        const user = room.users.get(socket.id);
        ctx.setMedia(
          room,
          {
            kind: "live",
            source,
            streamId,
            presenter: socket.id,
            title: str(p.title, 80) || SOURCE_TITLES[source],
            by: user.name,
          },
          { by: socket.id }
        );
        reply({ ok: true, streamId });
      });

      on("stage:stop", ({ streamId }) => {
        const room = ctx.roomOf(socket);
        const m = room && liveStage(room, streamId);
        if (!m || !allow("stage:stop", 6, 10_000)) return;
        if (m.presenter !== socket.id && !ctx.isAdmin(room, socket.id)) return;
        const user = room.users.get(socket.id);
        stop(
          room,
          socket.id,
          m.presenter === socket.id
            ? `${user.name} stopped sharing`
            : `${user.name} stopped ${m.by}'s share`
        );
      });

      // A viewer is ready to receive: ask the presenter to call them.
      on("stage:want", ({ streamId }) => {
        const room = ctx.roomOf(socket);
        const m = room && liveStage(room, streamId);
        if (!m || m.presenter === socket.id) return;
        if (!allow("stage:want", 6, 10_000)) return;
        io.to(m.presenter).emit("stage:viewer", { id: socket.id, streamId: m.streamId });
      });

      // Presenter ↔ one viewer only; viewers never signal each other.
      on("stage:signal", ({ to, streamId, data }) => {
        const room = ctx.roomOf(socket);
        const m = room && liveStage(room, streamId);
        if (!m || typeof to !== "string" || to === socket.id) return;
        if (!room.users.has(to)) return;
        if (m.presenter !== socket.id && m.presenter !== to) return;
        if (!validSignal(data) || !allow("stage:signal", 300, 10_000)) return;
        io.to(to).emit("stage:signal", { from: socket.id, streamId: m.streamId, data });
      });

      // A viewer's preferred quality, applied by the presenter to that
      // viewer's stream alone.
      on("stage:quality", ({ streamId, level }) => {
        const room = ctx.roomOf(socket);
        const m = room && liveStage(room, streamId);
        const q = oneOf(level, QUALITIES);
        if (!m || !q || m.presenter === socket.id) return;
        if (!allow("stage:quality", 10, 10_000)) return;
        io.to(m.presenter).emit("stage:quality", {
          id: socket.id,
          streamId: m.streamId,
          level: q,
        });
      });
    },
  };
};
