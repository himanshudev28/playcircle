// Room polls, one at a time:
//   custom  — the host asks anything, results are just shown
//   next    — "what should we watch next?" over queued videos; binding if
//             the host says so (the winner is flagged `next` and plays next)
//   skip    — vote to skip the current video (binding)
//   replay  — vote to restart it (binding)
// Skip/replay can be called by anyone with chat while the creator allows it
// (settings.voteSkip), and pass as soon as a majority of the people in the
// room say yes. Votes are per browser (clientId), and can be changed. Only
// people still in the room count: voting and leaving doesn't leave a vote
// behind (and coming back brings it back, so a refresh loses nothing).

const { str, num, oneOf } = require("./limits");

const YES_NO_MS = 30_000;

module.exports = function registerPolls(ctx) {
  const { io, media } = ctx;

  const isYesNo = (poll) => poll.kind === "skip" || poll.kind === "replay";

  // Yes-votes (or no-votes) that settle a skip / replay early.
  function needed(room) {
    return Math.floor(ctx.headcount(room) / 2) + 1;
  }

  // The votes of people who are in the room right now: [clientId, option].
  function liveVotes(room, poll) {
    const present = new Set([...room.users.values()].map((u) => u.clientId));
    return [...poll.votes].filter(([cid]) => present.has(cid));
  }

  function counts(room, poll) {
    const c = poll.options.map(() => 0);
    for (const [, idx] of liveVotes(room, poll)) c[idx] += 1;
    return c;
  }

  function publicPoll(room, poll) {
    if (!poll) return null;
    const live = liveVotes(room, poll);
    const c = counts(room, poll);
    return {
      id: poll.id,
      kind: poll.kind,
      question: poll.question,
      options: poll.options.map((o, i) => ({ ...o, count: c[i] })),
      total: live.length,
      // Who voted (to show "you voted"), never what they picked.
      voters: live.map(([cid]) => ctx.browserTag(cid)),
      endsAt: poll.endsAt,
      binding: poll.binding,
      by: poll.by,
      needed: isYesNo(poll) ? needed(room) : null,
    };
  }

  function broadcastPoll(room) {
    io.to(room.code).emit("poll:update", publicPoll(room, room.poll));
  }

  ctx.addSnapshot((room) => ({ poll: publicPoll(room, room.poll) }));

  // End the running poll: announce the result and act on it if binding.
  function close(room, { cancelled = false } = {}) {
    const poll = room.poll;
    if (!poll) return;
    clearTimeout(room.pollTimer);
    room.pollTimer = null;
    room.poll = null;

    const c = counts(room, poll);
    const top = Math.max(0, ...c);
    const leaders = c.flatMap((n, i) => (n === top && n > 0 ? [i] : []));
    const winner = !cancelled && leaders.length === 1 ? leaders[0] : null;
    const passed = isYesNo(poll) && !cancelled && c[0] > c[1];

    io.to(room.code).emit("poll:closed", {
      poll: publicPoll(room, poll),
      winner,
      passed,
      cancelled,
    });
    io.to(room.code).emit("poll:update", null);
    if (cancelled) return;

    if (isYesNo(poll)) {
      const what = poll.kind === "skip" ? "skip" : "replay";
      ctx.emitSystem(
        room,
        passed
          ? `The room voted to ${what} (${c[0]}–${c[1]})`
          : `Vote to ${what} didn't pass (${c[0]}–${c[1]})`
      );
      if (!passed || !poll.binding) return;
      if (poll.kind === "skip") {
        if (!ctx.playNext(room, null)) ctx.handleEnded(room);
      } else {
        room.time = 0;
        room.isPlaying = true;
        room.updatedAt = Date.now();
        room.endedKey = null;
        io.to(room.code).emit("player:action", {
          type: "seek",
          time: 0,
          media: room.media,
          isPlaying: true,
          at: Date.now(),
          by: "The room",
        });
      }
      return;
    }

    if (!c.some((n) => n > 0)) {
      ctx.emitSystem(room, `Poll “${poll.question}” ended with no votes`);
      return;
    }
    if (winner === null) {
      ctx.emitSystem(room, `Poll “${poll.question}” ended in a tie`);
      return;
    }
    const label = poll.options[winner].label;
    ctx.emitSystem(room, `Poll “${poll.question}” → ${label}`);
    if (poll.kind === "next" && poll.binding) {
      const item = room.queue.find((q) => q.id === poll.options[winner].ref);
      if (item && item.status === "ready") {
        for (const q of room.queue) q.next = false;
        item.next = true;
        ctx.broadcastQueue(room);
      }
    }
  }

  // Skip / replay settle early once a majority has spoken either way.
  function checkMajority(room) {
    const poll = room.poll;
    if (!poll || !isYesNo(poll)) return;
    const [yes, no] = counts(room, poll);
    if (yes >= needed(room) || no >= needed(room)) close(room);
  }

  // A skip/replay vote is about the video it was called on.
  ctx.onMedia((room) => {
    const p = room.poll;
    if (p && p.key && p.key !== media.key(room.media)) close(room, { cancelled: true });
  });

  // Fewer people means a smaller majority, and whoever left takes their vote
  // with them (counts only see people present); nobody left means no poll.
  ctx.onDetach((room) => {
    if (!room.poll) return;
    if (room.users.size === 0) close(room, { cancelled: true });
    else {
      broadcastPoll(room);
      checkMajority(room);
    }
  });

  // More people means a bigger majority; a returning voter's vote counts
  // again (and may be the one that settles it).
  ctx.onJoin((room) => {
    if (!room.poll) return;
    broadcastPoll(room);
    checkMajority(room);
  });

  return {
    connection(socket, on) {
      const allow = socket.data.allow;

      on("poll:create", (p, reply) => {
        const room = ctx.roomOf(socket);
        if (!room) return reply({ ok: false });
        const kind = oneOf(p.kind, ["custom", "next", "skip", "replay"]);
        if (!kind) return reply({ ok: false, error: "Unknown kind of poll" });
        const admin = ctx.isAdmin(room, socket.id);
        const user = room.users.get(socket.id);

        if (room.poll) return reply({ ok: false, error: "A poll is already running" });

        let poll = null;
        const base = {
          id: ctx.msgId("p"),
          kind,
          votes: new Map(), // clientId -> option index
          by: { name: user.name, color: user.color },
          key: null, // skip / replay: the video it's about
        };

        if (kind === "skip" || kind === "replay") {
          const mayCall =
            admin ||
            (room.settings.voteSkip && ctx.effectivePerms(room, socket.id).chat);
          if (!mayCall) {
            return reply({ ok: false, error: "The host turned off skip votes" });
          }
          if (!media.isTimed(room.media)) {
            return reply({ ok: false, error: "Nothing to vote on right now" });
          }
          if (kind === "skip" && !ctx.nextReady(room)) {
            return reply({
              ok: false,
              error: "Queue something up first — there's nothing to skip to",
            });
          }
          if (!allow("poll:create", 3, 60_000)) {
            return reply({ ok: false, error: "Give it a minute before starting another" });
          }
          const title = room.media.title || "this video";
          poll = {
            ...base,
            question:
              kind === "skip" ? `Skip “${title}”?` : `Replay “${title}” from the start?`,
            options: [{ label: "Yes" }, { label: "No" }],
            binding: true,
            key: media.key(room.media),
            endsAt: Date.now() + YES_NO_MS,
          };
          // Calling the vote counts as a yes.
          poll.votes.set(user.clientId, 0);
        } else {
          if (!admin) return reply({ ok: false, error: "Only the host can start polls" });
          const seconds = num(p.seconds, 15, 600) ?? 60;
          const question = str(p.question, 120);
          let options;
          if (kind === "next") {
            const ids = Array.isArray(p.itemIds)
              ? [...new Set(p.itemIds.filter((id) => typeof id === "string"))]
              : [];
            if (ids.length > 5) {
              return reply({ ok: false, error: "Pick up to five videos" });
            }
            options = ids
              .map((id) => room.queue.find((q) => q.id === id && q.status === "ready"))
              .filter(Boolean)
              .map((q) => ({ label: q.media.title || "Untitled video", ref: q.id }));
          } else {
            const raw = Array.isArray(p.options) ? p.options : [];
            options = [...new Set(raw.map((o) => str(o, 60)).filter(Boolean))].map(
              (label) => ({ label })
            );
            if (options.length > 6) {
              return reply({ ok: false, error: "A poll can have up to six choices" });
            }
          }
          if (options.length < 2) {
            return reply({ ok: false, error: "A poll needs at least two choices" });
          }
          if (!allow("poll:create", 3, 60_000)) {
            return reply({ ok: false, error: "Give it a minute before starting another" });
          }
          poll = {
            ...base,
            question:
              question || (kind === "next" ? "What should we watch next?" : "Quick poll"),
            options,
            binding: kind === "next" && p.binding === true,
            endsAt: Date.now() + seconds * 1000,
          };
        }

        room.poll = poll;
        room.pollTimer = setTimeout(() => {
          if (room.poll === poll) close(room);
        }, poll.endsAt - Date.now());
        reply({ ok: true });
        ctx.emitSystem(room, `${user.name} started a poll: ${poll.question}`);
        broadcastPoll(room);
        checkMajority(room);
      });

      // Vote, or change your vote.
      on("poll:vote", ({ id, option }) => {
        const room = ctx.roomOf(socket);
        const poll = room && room.poll;
        if (!poll || poll.id !== id || !allow("poll:vote", 10, 10_000)) return;
        if (!Number.isInteger(option) || option < 0 || option >= poll.options.length) {
          return;
        }
        poll.votes.set(room.users.get(socket.id).clientId, option);
        broadcastPoll(room);
        checkMajority(room);
      });

      // The host can end any poll early; it resolves on the votes so far.
      on("poll:close", ({ id }) => {
        const room = ctx.roomOf(socket);
        const poll = room && room.poll;
        if (!poll || poll.id !== id || !ctx.isAdmin(room, socket.id)) return;
        if (!allow("poll:close", 6, 10_000)) return;
        close(room);
      });
    },
  };
};
