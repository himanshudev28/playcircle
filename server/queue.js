// Shared watch queue: anyone can suggest, the host approves (unless approval
// is off), everyone votes, and the next video starts on its own when one
// ends. Order is by votes or by hand, as the room's creator chooses; an
// item that won a binding "what's next" poll (server/polls.js) is flagged
// `next` and jumps ahead of both.

const { str, oneOf } = require("./limits");

const MAX_ITEMS = 50;
const MAX_PENDING_PER_PERSON = 5;

module.exports = function registerQueue(ctx) {
  const { io, media } = ctx;
  // Tie-breaker for items added in the same millisecond (addedAt collides).
  let addSeq = 0;

  function publicItem(q) {
    return {
      id: q.id,
      media: q.media,
      by: q.by,
      browser: ctx.browserTag(q.cid),
      votes: q.votes.size,
      voters: [...q.votes].map(ctx.browserTag),
      status: q.status,
      next: !!q.next,
      addedAt: q.addedAt,
    };
  }

  function sortQueue(room) {
    if (room.settings.order !== "votes") {
      // Hand-arranged: leave the order alone, except a poll winner goes
      // first (Array#sort is stable, so the rest keep their places).
      room.queue.sort((a, b) => (b.next ? 1 : 0) - (a.next ? 1 : 0));
      return;
    }
    // Equal votes keep the order they were added in. The sort is in place,
    // so ties need a real tie-breaker, not the array's current order.
    room.queue.sort(
      (a, b) =>
        (b.next ? 1 : 0) - (a.next ? 1 : 0) ||
        b.votes.size - a.votes.size ||
        a.addedAt - b.addedAt ||
        (a.seq || 0) - (b.seq || 0)
    );
  }

  function publicQueue(room) {
    return {
      items: room.queue.map(publicItem),
      history: room.history.slice(0, 12),
    };
  }

  function broadcastQueue(room) {
    sortQueue(room);
    io.to(room.code).emit("queue:update", publicQueue(room));
  }
  ctx.broadcastQueue = broadcastQueue;

  // What would play next: a poll winner first, then the queue's order.
  function nextItem(room) {
    sortQueue(room);
    return (
      room.queue.find((q) => q.status === "ready" && q.next) ||
      room.queue.find((q) => q.status === "ready") ||
      null
    );
  }
  ctx.nextReady = (room) => nextItem(room);

  // Start the next ready video. Returns false when there's nothing to play.
  ctx.playNext = (room, by) => {
    const item = nextItem(room);
    if (!item) return false;
    room.queue = room.queue.filter((q) => q !== item);
    ctx.setMedia(room, item.media, { by });
    ctx.emitSystem(room, `Up next: ${item.media.title || "a new video"}`);
    return true;
  };

  // Whatever just started playing leaves the queue; history changed too.
  ctx.onMedia((room) => {
    const k = media.key(room.media);
    if (k) room.queue = room.queue.filter((q) => media.key(q.media) !== k);
    broadcastQueue(room);
  });

  ctx.onSettings((room) => broadcastQueue(room));

  ctx.addSnapshot((room) => ({ queue: publicQueue(room) }));

  function findItem(room, id) {
    return room.queue.find((q) => q.id === id) || null;
  }

  return {
    connection(socket, on) {
      const allow = socket.data.allow;

      on("queue:add", (p, reply) => {
        const room = ctx.roomOf(socket);
        if (!room) return reply({ ok: false });
        const perms = ctx.effectivePerms(room, socket.id);
        // Someone the host silenced can't flood the queue instead.
        if (!perms.chat) {
          return reply({ ok: false, error: "The host turned off your suggestions" });
        }
        if (!allow("queue:add", 6, 20_000)) {
          return reply({ ok: false, error: "Slow down a little" });
        }
        const m = media.fromClient(p.media) || media.parseInput(str(p.input, 2000));
        if (!m) {
          return reply({ ok: false, error: "That doesn't look like a YouTube link" });
        }

        const user = room.users.get(socket.id);
        const k = media.key(m);
        if (k === media.key(room.media)) {
          return reply({ ok: false, error: "That's already playing" });
        }
        const dupe = room.queue.find((q) => media.key(q.media) === k);
        if (dupe) {
          // Suggesting something already queued counts as a vote for it.
          if (dupe.status === "ready") dupe.votes.add(user.clientId);
          broadcastQueue(room);
          return reply({ ok: true, duplicate: true, status: dupe.status });
        }
        if (room.queue.length >= MAX_ITEMS) {
          return reply({ ok: false, error: "The queue is full" });
        }

        const trusted = perms.video || !room.settings.approval;
        if (!trusted) {
          const mine = room.queue.filter(
            (q) => q.status === "pending" && q.cid === user.clientId
          ).length;
          if (mine >= MAX_PENDING_PER_PERSON) {
            return reply({
              ok: false,
              error: "Wait for the host to review your other suggestions",
            });
          }
        }

        const item = {
          id: ctx.msgId("q"),
          media: m,
          by: { name: user.name, color: user.color },
          cid: user.clientId,
          votes: new Set(trusted ? [user.clientId] : []),
          status: trusted ? "ready" : "pending",
          next: false,
          addedAt: Date.now(),
          seq: ++addSeq,
        };
        room.queue.push(item);
        reply({ ok: true, status: item.status });

        if (item.status === "pending") {
          ctx.noticeAdmins(room, `${user.name} suggested a video — check Up next`);
        }
        media.enrich(m).then(() => {
          if (findItem(room, item.id)) broadcastQueue(room);
        });
        // Nothing on stage: a ready suggestion just starts.
        if (!room.media && item.status === "ready") ctx.playNext(room, socket.id);
        else broadcastQueue(room);
      });

      on("queue:approve", ({ id }) => {
        const room = ctx.roomOf(socket);
        if (!room || !ctx.isAdmin(room, socket.id)) return;
        const item = findItem(room, id);
        if (!item || item.status !== "pending") return;
        item.status = "ready";
        item.votes.add(item.cid);
        if (!room.media) ctx.playNext(room, socket.id);
        else broadcastQueue(room);
      });

      // Admins remove anything; anyone can withdraw their own suggestion.
      on("queue:remove", ({ id }) => {
        const room = ctx.roomOf(socket);
        if (!room) return;
        const item = findItem(room, id);
        if (!item) return;
        const user = room.users.get(socket.id);
        if (!ctx.isAdmin(room, socket.id) && item.cid !== user.clientId) return;
        room.queue = room.queue.filter((q) => q !== item);
        broadcastQueue(room);
      });

      on("queue:move", ({ id, dir }) => {
        const room = ctx.roomOf(socket);
        if (!room || !ctx.isAdmin(room, socket.id)) return;
        if (room.settings.order !== "manual") return;
        if (!allow("queue:move", 12, 4_000)) return;
        const step = oneOf(dir, [-1, 1]);
        const i = room.queue.findIndex((q) => q.id === id);
        const j = i + (step || 0);
        if (!step || i < 0 || j < 0 || j >= room.queue.length) return;
        [room.queue[i], room.queue[j]] = [room.queue[j], room.queue[i]];
        broadcastQueue(room);
      });

      on("queue:vote", ({ id }) => {
        const room = ctx.roomOf(socket);
        if (!room || !allow("queue:vote", 20, 10_000)) return;
        const item = findItem(room, id);
        if (!item || item.status !== "ready") return;
        const cid = room.users.get(socket.id).clientId;
        if (item.votes.has(cid)) item.votes.delete(cid);
        else item.votes.add(cid);
        broadcastQueue(room);
      });

      on("queue:play", ({ id }) => {
        const room = ctx.roomOf(socket);
        if (!room || !ctx.effectivePerms(room, socket.id).video) return;
        // Same bucket as player:action, so this can't be a side door around
        // the load limit.
        if (!allow("player", 12, 4_000)) return;
        const item = findItem(room, id);
        if (!item) return;
        // Playing an unreviewed suggestion is the host's call.
        if (item.status === "pending" && !ctx.isAdmin(room, socket.id)) return;
        ctx.setMedia(room, item.media, { by: socket.id });
      });

      on("queue:skip", (_p, reply) => {
        const room = ctx.roomOf(socket);
        if (!room || !ctx.effectivePerms(room, socket.id).video) {
          return reply({ ok: false, error: "Only the host can skip" });
        }
        if (!allow("queue:skip", 4, 10_000)) return reply({ ok: false });
        const ok = ctx.playNext(room, socket.id);
        reply({ ok, error: ok ? undefined : "Nothing is queued up next" });
      });

      on("queue:clear", () => {
        const room = ctx.roomOf(socket);
        if (!room || !ctx.isAdmin(room, socket.id)) return;
        room.queue = [];
        broadcastQueue(room);
      });
    },
  };
};
