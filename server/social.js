// Chat (replies, reactions, pins, announcements, moderation) and live
// reactions on the video, which build a timeline of the room's best moments.
//
// Messages keep their sender's clientId server-side (so authorship survives
// a refresh) and always leave through ctx.publicMessage, which swaps every
// clientId for a browser tag.

const { str, oneOf } = require("./limits");

// Floating reactions over the video.
const LIVE_REACTIONS = ["😂", "❤️", "🔥", "😮", "👏", "😭", "💀", "🎉"];
// Reactions on a chat message.
const CHAT_REACTIONS = ["👍", "😂", "❤️", "🔥", "😮", "😢"];
const MAX_MOMENTS = 1_500;
// How much of a message a reply quotes.
const QUOTE_LEN = 90;

module.exports = function registerSocial(ctx) {
  const { io, media } = ctx;

  function pinned(room) {
    const m = room.pinnedId && room.messages.find((x) => x.id === room.pinnedId);
    return m ? ctx.publicMessage(m) : null;
  }

  ctx.addSnapshot((room) => ({
    pinned: pinned(room),
    moments:
      media.isTimed(room.media) && room.moments.key === media.key(room.media)
        ? room.moments.list
        : [],
  }));

  // A person's message (never a system line) by id.
  function findMessage(room, id) {
    return typeof id === "string"
      ? room.messages.find((m) => m.id === id && !m.system) || null
      : null;
  }

  return {
    connection(socket, on) {
      const allow = socket.data.allow;
      let lastSlowNotice = 0;
      const slowDown = (text) => {
        if (Date.now() - lastSlowNotice < 4_000) return;
        lastSlowNotice = Date.now();
        socket.emit("room:notice", text);
      };

      on("chat:message", ({ text, replyTo, announce }) => {
        const room = ctx.roomOf(socket);
        if (!room || !ctx.effectivePerms(room, socket.id).chat) return;
        const clean = str(text, 500);
        if (!clean) return;
        if (!allow("chat", 6, 8_000)) {
          return slowDown("You're sending messages too fast");
        }
        const user = room.users.get(socket.id);
        const msg = {
          id: ctx.msgId("m"),
          cid: user.clientId,
          name: user.name,
          color: user.color,
          text: clean,
          ts: Date.now(),
        };
        const parent = findMessage(room, replyTo);
        if (parent) {
          msg.replyTo = { id: parent.id, text: parent.text.slice(0, QUOTE_LEN) };
          if (parent.name) msg.replyTo.name = parent.name;
        }
        // Announcements are the host's megaphone; anyone else's is a plain line.
        if (announce === true && ctx.isAdmin(room, socket.id)) msg.announce = true;
        ctx.pushMessage(room, msg);
        io.to(room.code).emit("chat:message", ctx.publicMessage(msg));
      });

      // Toggle one emoji on a message.
      on("chat:react", ({ id, emoji }) => {
        const room = ctx.roomOf(socket);
        if (!room || !oneOf(emoji, CHAT_REACTIONS)) return;
        if (!ctx.effectivePerms(room, socket.id).chat) return;
        if (!allow("chat:react", 20, 10_000)) return;
        const msg = findMessage(room, id);
        if (!msg) return;
        const cid = room.users.get(socket.id).clientId;
        msg.reactions = msg.reactions || {};
        const list = msg.reactions[emoji] || [];
        const next = list.includes(cid) ? list.filter((c) => c !== cid) : [...list, cid];
        if (next.length) msg.reactions[emoji] = next;
        else delete msg.reactions[emoji];
        io.to(room.code).emit("chat:update", ctx.publicMessage(msg));
      });

      on("chat:pin", ({ id }) => {
        const room = ctx.roomOf(socket);
        if (!room || !ctx.isAdmin(room, socket.id)) return;
        if (!allow("chat:pin", 10, 10_000)) return;
        const msg = id === null ? null : findMessage(room, id);
        if (id !== null && !msg) return;
        room.pinnedId = msg ? msg.id : null;
        io.to(room.code).emit("chat:pinned", pinned(room));
      });

      // Admins can take a message down; anyone can delete their own.
      on("chat:delete", ({ id }) => {
        const room = ctx.roomOf(socket);
        const msg = room && findMessage(room, id);
        if (!msg || !allow("chat:delete", 10, 10_000)) return;
        const cid = room.users.get(socket.id).clientId;
        if (!ctx.isAdmin(room, socket.id) && msg.cid !== cid) return;
        room.messages = room.messages.filter((m) => m !== msg);
        if (room.pinnedId === msg.id) {
          room.pinnedId = null;
          io.to(room.code).emit("chat:pinned", null);
        }
        io.to(room.code).emit("chat:removed", msg.id);
        // Replies stop quoting what was taken down.
        for (const m of room.messages) {
          if (m.replyTo?.id !== msg.id) continue;
          m.replyTo = { ...m.replyTo, text: "Message deleted" };
          io.to(room.code).emit("chat:update", ctx.publicMessage(m));
        }
      });

      // Reports go to whoever is running the room right now (and the log).
      on("chat:report", ({ id, reason }, reply) => {
        const room = ctx.roomOf(socket);
        const msg = room && findMessage(room, id);
        if (!msg) return reply({ ok: false, error: "That message is gone" });
        if (!allow("chat:report", 3, 60_000)) {
          return reply({ ok: false, error: "You've sent a few reports already" });
        }
        const reporter = room.users.get(socket.id);
        if (msg.cid === reporter.clientId) {
          return reply({ ok: false, error: "You can't report your own message" });
        }
        const why = str(reason, 120);
        const who = msg.name || "someone";
        console.warn(
          `[report] room=${room.code} from=${reporter.name} about=${who}` +
            ` msg=${JSON.stringify(msg.text.slice(0, 200))} reason=${JSON.stringify(why)}`
        );
        ctx.noticeAdmins(
          room,
          `${reporter.name} reported a message from ${who}${why ? `: ${why}` : ""}`
        );
        reply({ ok: true });
      });

      // ---- Live reactions ----
      // Everyone sees them float by; on a YouTube video they're also kept
      // against the playhead, building the "moments" timeline.
      on("reaction:send", ({ emoji }) => {
        const room = ctx.roomOf(socket);
        if (!room || !oneOf(emoji, LIVE_REACTIONS)) return;
        if (!ctx.effectivePerms(room, socket.id).chat) return;
        if (!allow("reaction", 8, 4_000)) return;
        const user = room.users.get(socket.id);
        const timed = media.isTimed(room.media);
        const t = timed ? Math.round(ctx.currentTime(room) * 10) / 10 : null;
        if (timed) {
          const k = media.key(room.media);
          if (room.moments.key !== k) room.moments = { key: k, list: [] };
          room.moments.list.push({ t, e: emoji });
          if (room.moments.list.length > MAX_MOMENTS) room.moments.list.shift();
        }
        io.to(room.code).emit("reaction", {
          emoji,
          name: user.name,
          color: user.color,
          byId: socket.id,
          t,
        });
      });
    },
  };
};

module.exports.LIVE_REACTIONS = LIVE_REACTIONS;
module.exports.CHAT_REACTIONS = CHAT_REACTIONS;
module.exports.MAX_MOMENTS = MAX_MOMENTS;
