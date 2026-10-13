// Room state and every Socket.IO handler. server.js mounts this next to
// Next.js; the tests mount it on a bare HTTP server.
//
// Feature modules (queue, chat extras + reactions, polls, live sharing) get
// a shared `ctx` and add their own handlers; this file owns rooms,
// authority, presence, passwords, playback sync, calls, the lobby and
// persistence.

const crypto = require("crypto");
const path = require("path");
const { promisify } = require("util");
const { createLimiter, createSharedLimiter, str, num, oneOf, safe, ROOM_CODE } = require("./limits");
const media = require("./media");
const { createStore } = require("./persist");
const registerQueue = require("./queue");
const registerSocial = require("./social");
const registerPolls = require("./polls");
const registerStage = require("./stage");

const { CHAT_REACTIONS, LIVE_REACTIONS, MAX_MOMENTS } = registerSocial;

const COLORS = [
  "#f0454b", "#f59e0b", "#10b981", "#3b82f6",
  "#a855f7", "#ec4899", "#14b8a6", "#eab308",
];

const LOBBY_CHANNEL = "__lobby__";
const VENT_ALIASES = [
  "Night Owl", "Quiet Wanderer", "Lost Signal", "Blue Hour", "Static Ghost",
  "Paper Moon", "Slow Comet", "Velvet Static", "Echo", "Stranger",
];
const VENT_EMOJIS = ["🌙", "🫧", "🌧️", "⭐", "🔮", "🍃", "🌊", "🕯️", "👻", "🌌"];

const DEFAULTS = {
  // A host who drops (refresh, flaky wifi) gets this long to come back before
  // the crown passes on. An empty room is kept just as long so a solo host
  // refreshing doesn't lose the lock / removed list.
  hostGraceMs: 20_000,
  emptyRoomTtlMs: 30_000,
  // A refresh is a disconnect + reconnect; only announce "left" if the
  // person is still gone after this long.
  leaveAnnounceMs: 5_000,
  // An ended room's code stays dead this long so a reload can't recreate it.
  endedTtlMs: 10 * 60_000,
  // Rooms restored from disk wait this long for someone to come back.
  restoredTtlMs: 15 * 60_000,
  // How often everyone hears the authoritative playhead (drift correction).
  tickMs: 3_000,
  maxRooms: 2_000,
  maxUsersPerRoom: 50,
  // Where room snapshots live; null disables persistence.
  dataFile: path.join(process.cwd(), ".data", "rooms.json"),
  saveEveryMs: 5_000,
  // Password guesses, server-wide (on top of each socket's own limit), so
  // reconnecting or opening more sockets doesn't buy more tries:
  // [max, perMs] per room code, and per client address.
  passwordPerRoom: [20, 60_000],
  passwordPerAddress: [10, 60_000],
  // Setting a password hashes it too, so that's limited per address as well.
  passwordSetPerAddress: [10, 60_000],
  // Behind a reverse proxy every socket shares the proxy's address; set
  // TRUST_PROXY=1 to key the per-address limits on X-Forwarded-For instead.
  trustProxy: process.env.TRUST_PROXY === "1",
};

// A believable video length in seconds, or null. A live stream's player
// reports time since the stream started (hours, and growing), so a day or
// more is refused outright rather than clamped into a fake end.
const MAX_DURATION = 86_400;

// Room passwords: scrypt with a per-room salt; only salt + hash are kept.
// Hashing is deliberately slow (tens of ms), so it runs on the libuv thread
// pool and never blocks the event loop.
const PASSWORD_MIN = 4;
const PASSWORD_MAX = 64;
const SALT_BYTES = 16;
const HASH_BYTES = 64;
const scrypt = promisify(crypto.scrypt);
function hashPassword(password, salt) {
  return scrypt(password, salt, HASH_BYTES);
}

// Constant-time check of a join attempt against a room's { salt, hash }.
async function passwordMatches(stored, attempt) {
  if (!stored || attempt.length > PASSWORD_MAX) return false;
  const expected = Buffer.from(stored.hash, "hex");
  const got = await hashPassword(attempt, Buffer.from(stored.salt, "hex"));
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}
function validDuration(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 && v < MAX_DURATION
    ? v
    : null;
}

// Socket.IO server options: SDP and chat are small, so refuse big frames.
const SOCKET_OPTIONS = {
  cors: { origin: "*" },
  maxHttpBufferSize: 100_000,
  pingInterval: 10_000,
  pingTimeout: 8_000,
};

function attachRealtime(io, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  /** @type {Map<string, any>} */
  const rooms = new Map();
  /** @type {Map<string, number>} code -> endedAt */
  const endedCodes = new Map();
  const vents = []; // { id, alias, emoji, text, ts }

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

  function newRoom(code) {
    return {
      code,
      title: null,
      isPublic: false,
      createdAt: Date.now(),
      media: null, // see server/media.js
      isPlaying: false,
      time: 0, // playhead position (seconds) as of updatedAt
      updatedAt: Date.now(),
      duration: null, // seconds, once someone's player (or the API) knows
      durationReports: new Map(), // clientId -> seconds, from viewers
      endedKey: null, // media key we already handled the end of
      hostId: null, // socket id of the host (null while they reconnect)
      hostClientId: null, // stable per-browser id, survives refreshes
      ownerClientId: null, // the creator: permanent first right + admin power
      playback: "host", // who controls the video: "host" | "everyone"
      settings: {
        approval: true, // suggestions from viewers wait for the host
        order: "votes", // up-next order: "votes" | "manual"
        autoplay: true, // play the next queued video when one ends
        voteSkip: true, // viewers may call skip / replay votes
      },
      password: null, // { salt, hash } (hex), never sent to anyone
      perms: new Map(), // clientId -> { video?, chat?, call? } host overrides
      hostTimer: null,
      deleteTimer: null,
      locked: false, // locked rooms only admit people who were already in
      members: new Set(), // clientIds ever admitted
      colors: new Map(), // clientId -> color, so a returning person keeps theirs
      banned: new Set(), // clientIds the host removed
      users: new Map(), // socketId -> { name, color, clientId }
      callers: new Map(), // socketId -> { mic, cam, session }
      pendingLeaves: new Map(), // clientId -> timer for a deferred "left" line
      // { id, cid?, name?, color?, text, ts, system?, announce?, replyTo?,
      //   reactions?: { emoji: [clientId] } } — sent through publicMessage
      messages: [],
      pinnedId: null, // id of the pinned chat message
      passwordSeq: 0, // bumps on every password change (hashing is async)
      moments: { key: null, list: [] }, // reactions timeline of the current video
      poll: null, // see server/polls.js
      pollTimer: null,
      queue: [], // see server/queue.js
      history: [], // recently played media, newest first
    };
  }

  function getRoom(code) {
    let room = rooms.get(code);
    if (!room) {
      room = newRoom(code);
      rooms.set(code, room);
    }
    return room;
  }

  // Current playhead accounting for elapsed real time while playing.
  function currentTime(room) {
    const t = room.isPlaying
      ? room.time + (Date.now() - room.updatedAt) / 1000
      : room.time;
    return room.duration ? Math.min(t, room.duration) : t;
  }

  /* ---- Authority ----
     The creator (owner) is permanent: whenever they're in the room they hold
     the crown, and nobody else can act on them. The host is whoever holds
     the crown right now. Both owner and host are admins. */

  function isOwnerId(room, socketId) {
    const u = room.users.get(socketId);
    return !!u && !!room.ownerClientId && u.clientId === room.ownerClientId;
  }

  function ownerPresent(room) {
    return [...room.users.values()].some((u) => u.clientId === room.ownerClientId);
  }

  // One of the owner's sockets ([socketId, user]), or undefined if they're away.
  function ownerEntry(room) {
    if (!room.ownerClientId) return undefined;
    return [...room.users.entries()].find(([, u]) => u.clientId === room.ownerClientId);
  }

  function isAdmin(room, socketId) {
    return room.hostId === socketId || isOwnerId(room, socketId);
  }

  // Room-wide switches: the owner, or the host standing in while they're away.
  function canRunRoom(room, socketId) {
    return (
      isOwnerId(room, socketId) ||
      (room.hostId === socketId && !ownerPresent(room))
    );
  }

  // May `actorId` manage `targetId`? Never yourself (or your own other tabs),
  // and only the owner may touch the owner.
  function canTarget(room, actorId, targetId) {
    const actor = room.users.get(actorId);
    const target = room.users.get(targetId);
    if (!actor || !target || !isAdmin(room, actorId)) return false;
    if (actor.clientId === target.clientId) return false;
    if (target.clientId === room.ownerClientId) return false;
    return true;
  }

  function effectivePerms(room, socketId) {
    const u = room.users.get(socketId);
    if (!u) return { video: false, chat: false, call: false };
    if (isAdmin(room, socketId)) return { video: true, chat: true, call: true };
    const p = room.perms.get(u.clientId) || {};
    return {
      video: p.video ?? room.playback === "everyone",
      chat: p.chat !== false,
      call: p.call !== false,
    };
  }

  // Unique people (not tabs) currently in the room.
  function headcount(room) {
    return new Set([...room.users.values()].map((u) => u.clientId)).size;
  }

  // Public view of the people in a room. clientIds stay server-side.
  function publicUsers(room) {
    return [...room.users.entries()].map(([id, u]) => {
      const c = room.callers.get(id);
      return {
        id,
        name: u.name,
        color: u.color,
        browser: browserTag(u.clientId),
        owner: u.clientId === room.ownerClientId,
        perms: effectivePerms(room, id),
        call: c ? { mic: c.mic, cam: c.cam } : null,
      };
    });
  }

  function publicSettings(room) {
    return {
      locked: room.locked,
      playback: room.playback,
      ...room.settings,
      hasPassword: !!room.password,
    };
  }

  // A chat message as clients see it: the sender's clientId (kept so
  // authorship survives a refresh) becomes their browser tag, and so do the
  // people behind each reaction.
  function publicMessage(m) {
    const out = { id: m.id, text: m.text, ts: m.ts };
    if (m.system) out.system = true;
    if (m.name) out.name = m.name;
    if (m.color) out.color = m.color;
    if (m.cid) out.browser = browserTag(m.cid);
    if (m.announce) out.announce = true;
    if (m.replyTo) out.replyTo = { ...m.replyTo };
    if (m.reactions) {
      const reactions = {};
      for (const [emoji, cids] of Object.entries(m.reactions)) {
        if (cids.length) reactions[emoji] = cids.map(browserTag);
      }
      if (Object.keys(reactions).length) out.reactions = reactions;
    }
    return out;
  }

  function pushMessage(room, msg) {
    room.messages.push(msg);
    if (room.messages.length > 200) {
      const gone = room.messages.shift();
      // A pin can't point at a message nobody can load any more.
      if (gone && gone.id === room.pinnedId) {
        room.pinnedId = null;
        io.to(room.code).emit("chat:pinned", null);
      }
    }
    return msg;
  }

  function msgId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  }

  function systemMessage(room, text) {
    return pushMessage(room, { id: msgId("s"), system: true, text, ts: Date.now() });
  }

  // Bits of the room snapshot contributed by feature modules.
  const snapshotParts = [];

  function snapshot(room, socket) {
    const out = {
      media: room.media,
      isPlaying: room.isPlaying,
      time: currentTime(room),
      duration: room.duration,
      at: Date.now(),
      hostId: room.hostId,
      settings: publicSettings(room),
      users: publicUsers(room),
      messages: room.messages.slice(-60).map(publicMessage),
    };
    for (const part of snapshotParts) Object.assign(out, part(room, socket));
    return out;
  }

  function publicRoomList() {
    return [...rooms.values()]
      .filter((r) => r.isPublic && r.users.size > 0)
      .map((r) => ({
        code: r.code,
        title: r.title || "Untitled room",
        videoId: r.media?.kind === "youtube" ? r.media.id : null,
        nowPlaying: r.media?.title || null,
        isPlaying: r.isPlaying,
        count: headcount(r),
        hosts: [...r.users.values()].slice(0, 4).map((u) => ({
          name: u.name,
          color: u.color,
        })),
      }))
      .sort((a, b) => b.count - a.count);
  }

  function broadcastLobby() {
    io.to(LOBBY_CHANNEL).emit("lobby:list", publicRoomList());
  }

  function broadcastUsers(room) {
    io.to(room.code).emit("room:users", publicUsers(room));
  }

  function broadcastSettings(room) {
    io.to(room.code).emit("room:settings", publicSettings(room));
  }

  function emitSystem(room, text) {
    io.to(room.code).emit("chat:message", publicMessage(systemMessage(room, text)));
  }

  // A private heads-up to every tab of one browser.
  function noticeTo(room, clientId, text) {
    for (const [sid, u] of room.users) {
      if (u.clientId === clientId) io.to(sid).emit("room:notice", text);
    }
  }

  function noticeAdmins(room, text) {
    for (const sid of room.users.keys()) {
      if (isAdmin(room, sid)) io.to(sid).emit("room:notice", text);
    }
  }

  function setHost(room, socketId) {
    room.hostId = socketId;
    const u = socketId ? room.users.get(socketId) : null;
    if (u) room.hostClientId = u.clientId;
    clearTimeout(room.hostTimer);
    room.hostTimer = null;
    io.to(room.code).emit("room:host", room.hostId);
    broadcastUsers(room);
    // Whoever lost the crown may have lost video control with it.
    ctx.permsChanged(room);
  }

  /* ---- The stage ---- */

  const mediaHooks = []; // (room, prevMedia) => void, after the stage changes
  const settingsHooks = []; // (room) => void, after host:settings
  const detachHooks = []; // (room, socketId, user) => void, after someone leaves
  const joinHooks = []; // (room, socketId) => void, after someone is admitted

  // Only timed (YouTube) media goes in history: a live share can't replay.
  function pushHistory(room, m) {
    if (!media.isTimed(m)) return;
    const k = media.key(m);
    room.history = [
      { media: m, playedAt: Date.now() },
      ...room.history.filter((h) => media.key(h.media) !== k),
    ].slice(0, 20);
  }

  const isLive = (m) => !!m && m.kind === "live";

  // What a client hears when the stage is cleared (same shape setMedia sends).
  function stageCleared() {
    return { type: "load", media: null, time: 0, isPlaying: false, at: Date.now() };
  }

  /* Put something new on the stage (or clear it) and tell everyone.
     `by` is the socket that did it, for the "X changed the video" toast. */
  function setMedia(room, next, { by = null, playing = true } = {}) {
    const prev = room.media;
    // Replaying the same video: its length hasn't changed, and nobody will
    // necessarily report it again, so keep it (or the tick never ends it).
    const sameVideo = !!next && media.key(next) === media.key(prev);
    pushHistory(room, prev);
    room.media = next;
    room.time = 0;
    room.isPlaying = !!next && playing;
    room.updatedAt = Date.now();
    if (!sameVideo) {
      room.duration = next?.duration || null;
      room.durationReports = new Map();
    }
    room.endedKey = null;
    // The reactions timeline belongs to what's on stage.
    room.moments = { key: media.key(next), list: [] };

    const user = by ? room.users.get(by) : null;
    io.to(room.code).emit("player:action", {
      type: "load",
      media: next,
      time: 0,
      isPlaying: room.isPlaying,
      at: Date.now(),
      by: user?.name,
      byId: by,
    });
    for (const hook of mediaHooks) hook(room, prev);
    if (room.isPublic) broadcastLobby();

    if (media.isTimed(next) && !next.title) {
      media.enrich(next).then(() => {
        if (room.media !== next || rooms.get(room.code) !== room) return;
        io.to(room.code).emit("room:media", next);
        if (room.isPublic) broadcastLobby();
      });
    }
  }

  // The video reached its end: play what's next, or rest at the end.
  function handleEnded(room) {
    const k = media.key(room.media);
    if (!k || room.endedKey === k) return;
    room.endedKey = k;
    if (room.settings.autoplay && ctx.playNext(room, null)) return;
    room.time = room.duration ?? currentTime(room);
    room.isPlaying = false;
    room.updatedAt = Date.now();
    io.to(room.code).emit("player:action", {
      type: "pause",
      time: room.time,
      media: room.media,
      isPlaying: false,
      at: Date.now(),
    });
  }

  /* ---- Leaving ---- */

  function destroyRoom(room) {
    for (const t of room.pendingLeaves.values()) clearTimeout(t);
    clearTimeout(room.hostTimer);
    clearTimeout(room.deleteTimer);
    clearTimeout(room.pollTimer);
    room.pollTimer = null;
    rooms.delete(room.code);
  }

  function scheduleDelete(room, ms) {
    clearTimeout(room.deleteTimer);
    room.deleteTimer = setTimeout(() => {
      if (rooms.get(room.code) === room && room.users.size === 0) {
        destroyRoom(room);
      }
    }, ms);
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
    // Feature cleanup first (e.g. a presenter leaving ends their share).
    for (const hook of detachHooks) hook(room, socket.id, user);

    if (room.hostId === socket.id) {
      // Same browser in another tab keeps the crown; failing that it goes
      // straight back to the creator if they're here (this is also how the
      // owner kicking the stand-in host works). Otherwise hold it for the
      // host to reconnect before anyone else can take it.
      const sibling = [...room.users.entries()].find(
        ([, u]) => u.clientId === room.hostClientId
      );
      const owner = !sibling && ownerEntry(room);
      if (sibling) {
        setHost(room, sibling[0]);
      } else if (owner) {
        setHost(room, owner[0]);
        emitSystem(room, `${owner[1].name} (room creator) is the host again`);
      } else {
        room.hostId = null;
        io.to(code).emit("room:host", null);
        clearTimeout(room.hostTimer);
        room.hostTimer = setTimeout(() => {
          room.hostTimer = null;
          if (rooms.get(code) !== room) return;
          if (room.hostId || room.users.size === 0) return;
          const back = ownerEntry(room);
          const [nextId, next] = back || room.users.entries().next().value;
          setHost(room, nextId);
          emitSystem(
            room,
            back
              ? `${next.name} (room creator) is the host again`
              : `${next.name} is now the host`
          );
        }, opts.hostGraceMs);
      }
    }

    if (room.users.size === 0) {
      scheduleDelete(room, opts.emptyRoomTtlMs);
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
        }, opts.leaveAnnounceMs)
      );
    }
    broadcastUsers(room);
    if (room.isPublic) broadcastLobby();
  }

  // Drop every call seat held by one browser (e.g. calls revoked).
  function dropFromCall(room, clientId) {
    for (const [sid, u] of room.users) {
      if (u.clientId !== clientId || !room.callers.delete(sid)) continue;
      io.to(room.code).emit("call:left", sid);
      io.to(sid).emit("call:revoked");
    }
  }

  function roomOf(socket) {
    const room = socket.data.code && rooms.get(socket.data.code);
    return room && room.users.has(socket.id) ? room : null;
  }

  /* May `cid` walk into room `code` right now? Returns { deny } with the
     room:denied payload, or { existing, needsPassword }. `verified` is a
     stored password this person already proved they know. */
  function admission(code, cid, verified = null) {
    const endedAt = endedCodes.get(code);
    if (endedAt && Date.now() - endedAt < opts.endedTtlMs) {
      return { deny: { reason: "ended" } };
    }
    endedCodes.delete(code);

    const existing = rooms.get(code);
    if (!existing && rooms.size >= opts.maxRooms) return { deny: { reason: "full" } };
    if (existing && existing.banned.has(cid)) return { deny: { reason: "removed" } };
    const known =
      !!existing &&
      (existing.members.has(cid) ||
        existing.ownerClientId === cid ||
        existing.hostClientId === cid);
    if (existing && existing.locked && !known) return { deny: { reason: "locked" } };
    if (existing && existing.password && !known && existing.password !== verified) {
      return { existing, needsPassword: true };
    }
    if (existing && !known && headcount(existing) >= opts.maxUsersPerRoom) {
      return { deny: { reason: "full" } };
    }
    return { existing, needsPassword: false };
  }

  /* ---- Server-wide limits ----
     Per-socket buckets reset with every new connection, so password guesses
     (and password changes, which hash too) are also counted per room and
     per client address, across all connections. */

  const shared = createSharedLimiter();
  const sweepTimer = setInterval(() => shared.sweep(), 60_000);
  sweepTimer.unref?.();

  function clientAddress(socket) {
    if (opts.trustProxy) {
      // The last hop is the one our proxy added; earlier ones are the
      // client's own say-so.
      const fwd = String(socket.handshake.headers["x-forwarded-for"] || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      if (fwd.length) return fwd[fwd.length - 1];
    }
    return socket.handshake.address || "unknown";
  }

  // One password guess at `code`: the socket's own limit, its address's, and
  // the room's. Checked in that order so a refusal doesn't spend the rest.
  function allowPasswordTry(socket, code) {
    return (
      socket.data.allow("password", 5, 60_000) &&
      shared.allow(`pw-addr:${clientAddress(socket)}`, ...opts.passwordPerAddress) &&
      shared.allow(`pw-room:${code}`, ...opts.passwordPerRoom)
    );
  }

  /* ---- Shared context for feature modules ---- */

  const ctx = {
    io,
    rooms,
    opts,
    media,
    roomOf,
    currentTime,
    headcount,
    isAdmin,
    isOwnerId,
    canRunRoom,
    canTarget,
    effectivePerms,
    browserTag,
    msgId,
    pushMessage,
    publicMessage,
    emitSystem,
    noticeTo,
    noticeAdmins,
    broadcastUsers,
    broadcastSettings,
    broadcastLobby,
    setMedia,
    handleEnded,
    onMedia: (fn) => mediaHooks.push(fn),
    onSettings: (fn) => settingsHooks.push(fn),
    onDetach: (fn) => detachHooks.push(fn),
    onJoin: (fn) => joinHooks.push(fn),
    addSnapshot: (fn) => snapshotParts.push(fn),
    // Filled in by the queue module.
    playNext: () => false,
    nextReady: () => null,
    broadcastQueue: () => {},
    // Called after anything that can change who may drive the stage
    // (host:perm, host:playback, the crown moving). Set by the stage module.
    permsChanged: () => {},
  };

  const features = [
    registerQueue(ctx),
    registerSocial(ctx),
    registerPolls(ctx),
    registerStage(ctx),
  ];

  /* ---- Persistence ---- */

  const store = opts.dataFile ? createStore(opts.dataFile) : null;

  function serialize(room) {
    // A live share can't outlive its presenter's connection: never saved.
    const timed = media.isTimed(room.media);
    return {
      code: room.code,
      title: room.title,
      isPublic: room.isPublic,
      createdAt: room.createdAt,
      media: timed ? room.media : null,
      time: timed ? currentTime(room) : 0,
      duration: timed ? room.duration : null,
      ownerClientId: room.ownerClientId,
      hostClientId: room.hostClientId,
      playback: room.playback,
      settings: room.settings,
      password: room.password,
      perms: [...room.perms],
      locked: room.locked,
      members: [...room.members],
      colors: [...room.colors],
      banned: [...room.banned],
      messages: room.messages.slice(-100),
      pinnedId: room.pinnedId,
      moments: timed ? room.moments : { key: null, list: [] },
      queue: room.queue.map((q) => ({ ...q, votes: [...q.votes] })),
      history: room.history,
    };
  }

  /* The snapshot on disk is trusted no more than a client: it may be from an
     older version, hand-edited, or half-corrupt. Every field is rebuilt to
     the shape the handlers expect, and a room that still won't restore is
     skipped rather than taking startup down with it. */

  const list = (x) => (Array.isArray(x) ? x : []);
  const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
  const isId = (x) => typeof x === "string" && x.length > 0 && x.length <= 64;
  const finite = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const diskStr = (x, max) =>
    typeof x === "string" ? x.trim().slice(0, max) || null : null;

  // Media from disk: only what fromClient accepts, plus its display text.
  function mediaFromDisk(x) {
    const m = media.fromClient(x);
    if (!m) return null;
    for (const [field, max] of [["title", 120], ["author", 60], ["thumb", 300]]) {
      const v = diskStr(x[field], max);
      if (v) m[field] = v;
    }
    return m;
  }

  function queueItemFromDisk(q) {
    if (!isObj(q) || !isId(q.cid)) return null;
    const m = mediaFromDisk(q.media);
    if (!m) return null;
    const by = isObj(q.by) ? q.by : {};
    return {
      id: diskStr(q.id, 80) || msgId("q"),
      media: m,
      by: {
        name: diskStr(by.name, 24) || "Guest",
        color: diskStr(by.color, 20) || COLORS[0],
      },
      cid: q.cid,
      votes: new Set(list(q.votes).filter(isId)),
      status: oneOf(q.status, ["ready", "pending"]) || "pending",
      next: q.next === true,
      addedAt: finite(q.addedAt) ?? Date.now(),
      seq: finite(q.seq) ?? 0,
    };
  }

  function messageFromDisk(m) {
    if (!isObj(m) || typeof m.text !== "string") return null;
    const out = {
      id: diskStr(m.id, 80) || msgId("r"),
      text: m.text.slice(0, 600),
      ts: finite(m.ts) ?? Date.now(),
    };
    const name = diskStr(m.name, 24);
    const color = diskStr(m.color, 20);
    if (name) out.name = name;
    if (color) out.color = color;
    if (m.system === true) {
      out.system = true;
      return out;
    }
    if (isId(m.cid)) out.cid = m.cid;
    if (m.announce === true) out.announce = true;
    if (isObj(m.replyTo) && isId(m.replyTo.id) && typeof m.replyTo.text === "string") {
      out.replyTo = { id: m.replyTo.id, text: m.replyTo.text.slice(0, 90) };
      const replyName = diskStr(m.replyTo.name, 24);
      if (replyName) out.replyTo.name = replyName;
    }
    if (isObj(m.reactions)) {
      const reactions = {};
      for (const emoji of CHAT_REACTIONS) {
        const cids = [...new Set(list(m.reactions[emoji]).filter(isId))].slice(0, 100);
        if (cids.length) reactions[emoji] = cids;
      }
      if (Object.keys(reactions).length) out.reactions = reactions;
    }
    return out;
  }

  // Salt + hash from disk, only if both look exactly like what we write.
  function passwordFromDisk(x) {
    if (!isObj(x)) return null;
    const hex = (v, bytes) =>
      typeof v === "string" && v.length === bytes * 2 && /^[0-9a-f]+$/.test(v);
    return hex(x.salt, SALT_BYTES) && hex(x.hash, HASH_BYTES)
      ? { salt: x.salt, hash: x.hash }
      : null;
  }

  // The reactions timeline, only if it belongs to the restored video.
  function momentsFromDisk(x, m) {
    const k = media.key(m);
    if (!k || !isObj(x) || x.key !== k) return { key: k, list: [] };
    return {
      key: k,
      list: list(x.list)
        .filter((e) => isObj(e) && finite(e.t) !== null && e.t >= 0 && oneOf(e.e, LIVE_REACTIONS))
        .map((e) => ({ t: e.t, e: e.e }))
        .slice(-MAX_MOMENTS),
    };
  }

  function restoreRoom(s) {
    const room = newRoom(s.code);
    const defaults = room.settings;
    const settings = isObj(s.settings) ? s.settings : {};
    const m = mediaFromDisk(s.media);
    const duration = m ? validDuration(s.duration) : null;
    // Everyone was cut off mid-video, so come back paused where we were.
    const time = Math.max(0, finite(s.time) ?? 0);
    const seen = new Set();

    Object.assign(room, {
      title: diskStr(s.title, 60),
      isPublic: s.isPublic === true,
      createdAt: finite(s.createdAt) ?? Date.now(),
      media: m,
      time: m ? (duration ? Math.min(time, duration) : time) : 0,
      isPlaying: false,
      updatedAt: Date.now(),
      duration,
      ownerClientId: isId(s.ownerClientId) ? s.ownerClientId : null,
      hostClientId: isId(s.hostClientId) ? s.hostClientId : null,
      playback: s.playback === "everyone" ? "everyone" : "host",
      settings: {
        approval:
          typeof settings.approval === "boolean" ? settings.approval : defaults.approval,
        order: oneOf(settings.order, ["votes", "manual"]) || defaults.order,
        autoplay:
          typeof settings.autoplay === "boolean" ? settings.autoplay : defaults.autoplay,
        voteSkip:
          typeof settings.voteSkip === "boolean" ? settings.voteSkip : defaults.voteSkip,
      },
      password: passwordFromDisk(s.password),
      perms: new Map(
        list(s.perms)
          .filter((e) => Array.isArray(e) && isId(e[0]) && isObj(e[1]))
          .map(([cid, p]) => {
            const clean = {};
            for (const k of ["video", "chat", "call"]) {
              if (typeof p[k] === "boolean") clean[k] = p[k];
            }
            return [cid, clean];
          })
      ),
      locked: s.locked === true,
      members: new Set(list(s.members).filter(isId)),
      colors: new Map(
        list(s.colors).filter(
          (e) => Array.isArray(e) && isId(e[0]) && diskStr(e[1], 20)
        ).map(([cid, c]) => [cid, diskStr(c, 20)])
      ),
      banned: new Set(list(s.banned).filter(isId)),
      messages: list(s.messages).map(messageFromDisk).filter(Boolean).slice(-100),
      queue: list(s.queue)
        .map(queueItemFromDisk)
        .filter((q) => {
          // One entry per video, and never the one that's on stage.
          const k = q && media.key(q.media);
          if (!k || seen.has(k) || k === media.key(m)) return false;
          seen.add(k);
          return true;
        })
        .slice(0, 50),
      history: list(s.history)
        .map((h) => {
          const hm = isObj(h) && mediaFromDisk(h.media);
          return hm ? { media: hm, playedAt: finite(h.playedAt) ?? Date.now() } : null;
        })
        .filter(Boolean)
        .slice(0, 20),
      moments: momentsFromDisk(s.moments, m),
    });
    // A pin only survives if the message it points at did.
    const pinned = room.messages.find((x) => x.id === s.pinnedId && !x.system);
    room.pinnedId = pinned ? pinned.id : null;
    return room;
  }

  function restore() {
    if (!store) return;
    for (const s of list(store.load())) {
      try {
        if (!isObj(s) || typeof s.code !== "string") continue;
        if (!ROOM_CODE.test(s.code) || rooms.has(s.code)) continue;
        const room = restoreRoom(s);
        rooms.set(room.code, room);
        scheduleDelete(room, opts.restoredTtlMs);
      } catch (err) {
        console.error("[persist] skipped a room that could not be restored:", err);
      }
    }
    if (rooms.size) console.log(`> Restored ${rooms.size} room(s) from disk`);
  }

  function flush() {
    if (!store) return;
    const now = Date.now();
    store.save(
      [...rooms.values()]
        .filter((r) => !(endedCodes.get(r.code) > now - opts.endedTtlMs))
        .map(serialize)
    );
  }

  restore();
  const saveTimer = store ? setInterval(flush, opts.saveEveryMs) : null;

  /* ---- Sync heartbeat ----
     Every few seconds each room hears the authoritative playhead. Clients
     compare it with their own player and quietly correct drift; the server
     also notices a video that ran out even if nobody reported it. A live
     share has no shared timeline, so it gets no ticks. */

  const tickTimer = setInterval(() => {
    for (const room of rooms.values()) {
      if (!room.users.size || !media.isTimed(room.media)) continue;
      if (
        room.isPlaying &&
        room.duration &&
        room.time + (Date.now() - room.updatedAt) / 1000 > room.duration + 3
      ) {
        handleEnded(room);
        continue;
      }
      io.to(room.code).emit("player:tick", {
        key: media.key(room.media),
        time: currentTime(room),
        isPlaying: room.isPlaying,
        at: Date.now(),
      });
    }
  }, opts.tickMs);

  /* ---- Connections ---- */

  io.on("connection", (socket) => {
    socket.data.code = null;
    socket.data.allow = createLimiter();
    const allow = socket.data.allow;
    const on = (event, fn) => socket.on(event, safe(event, fn));

    // Clock sync: the client measures round-trip and offset from this.
    on("time:ping", (_p, ack) => ack({ now: Date.now() }));

    on("room:join", async (p) => {
      if (!allow("join", 8, 10_000)) return;
      const code = str(p.code, 20).toUpperCase();
      if (!ROOM_CODE.test(code)) {
        socket.emit("room:denied", { reason: "invalid" });
        return;
      }
      const cid = str(p.clientId, 64) || socket.id;
      const displayName = str(p.name, 24) || "Guest";
      // Every join supersedes any earlier one still checking a password.
      const seq = (socket.data.joinSeq = (socket.data.joinSeq || 0) + 1);

      // Same socket asking for the same room again (a remount): resend state.
      const already = rooms.get(code);
      if (socket.data.code === code && already?.users.has(socket.id)) {
        socket.emit("room:state", {
          ...snapshot(already, socket),
          selfBrowser: browserTag(cid),
        });
        return;
      }
      if (socket.data.code) detach(socket, { announce: false });

      let verdict = admission(code, cid);
      if (verdict.deny) {
        socket.emit("room:denied", verdict.deny);
        return;
      }
      // Password rooms: only for people who haven't been admitted before.
      if (verdict.needsPassword) {
        if (typeof p.password !== "string" || !p.password) {
          socket.emit("room:denied", { reason: "password" });
          return;
        }
        // Guessing is slow on purpose, on top of the join limit.
        if (!allowPasswordTry(socket, code)) {
          socket.emit("room:notice", "Too many password attempts — wait a minute");
          socket.emit("room:denied", { reason: "password", limited: true });
          return;
        }
        const stored = verdict.existing.password;
        const ok = await passwordMatches(stored, p.password);
        // Hashing took a while: the socket may be gone, or have moved on to
        // another join since. Either way this attempt is stale.
        if (!socket.connected || socket.data.joinSeq !== seq || socket.data.code) return;
        if (!ok) {
          socket.emit("room:denied", { reason: "password", wrong: true });
          return;
        }
        // The room may have changed meanwhile (ended, locked, filled up, a
        // new password); check again, counting the password just verified.
        verdict = admission(code, cid, stored);
        if (verdict.deny) {
          socket.emit("room:denied", verdict.deny);
          return;
        }
        if (verdict.needsPassword) {
          socket.emit("room:denied", { reason: "password", wrong: true });
          return;
        }
      }

      const { existing } = verdict;
      const isNew = !existing;
      const room = getRoom(code);
      clearTimeout(room.deleteTimer);
      room.deleteTimer = null;

      // The first person in the room (its creator) sets its metadata. A room
      // restored from disk already has an owner.
      if (isNew || !room.ownerClientId) {
        room.isPublic = !!p.isPublic;
        room.title = str(p.title, 60) || null;
        room.ownerClientId = cid;
      }

      // Back within the grace window, or just another tab: no "joined" line.
      const quietJoin =
        room.pendingLeaves.has(cid) ||
        [...room.users.values()].some((u) => u.clientId === cid);
      clearTimeout(room.pendingLeaves.get(cid));
      room.pendingLeaves.delete(cid);

      socket.data.code = code;
      socket.join(code);
      let color = room.colors.get(cid);
      if (!color) {
        color = COLORS[room.colors.size % COLORS.length];
        room.colors.set(cid, color);
      }
      room.members.add(cid);
      room.users.set(socket.id, { name: displayName, color, clientId: cid });

      // The creator always takes the crown back. Otherwise a host returning
      // from a blip reclaims it, and an unclaimed room goes to whoever walks
      // in (unless we're still holding it for someone's reconnect).
      let reclaimed = false;
      if (cid === room.ownerClientId) {
        const holder = room.hostId && room.users.get(room.hostId);
        reclaimed = !!holder && holder.clientId !== cid;
        setHost(room, socket.id);
      } else if (!room.hostId && (room.hostClientId === cid || !room.hostTimer)) {
        setHost(room, socket.id);
      }

      socket.emit("room:state", {
        ...snapshot(room, socket),
        selfBrowser: browserTag(cid),
      });

      if (!quietJoin) emitSystem(room, `${displayName} joined the room`);
      if (reclaimed) {
        emitSystem(room, `${displayName} (room creator) is back in charge`);
      }
      broadcastUsers(room);
      if (room.isPublic) broadcastLobby();
      for (const hook of joinHooks) hook(room, socket.id);
    });

    on("room:leave", (p) => {
      if (p.code && str(p.code, 20).toUpperCase() !== socket.data.code) return;
      detach(socket);
    });

    // ---- Host controls ----
    on("host:kick", ({ targetId }) => {
      const room = roomOf(socket);
      if (!room || !canTarget(room, socket.id, targetId)) return;
      const target = room.users.get(targetId);
      room.banned.add(target.clientId);
      room.members.delete(target.clientId);
      // Presenting? The share ends while they're still in the room, so
      // their own tab hears the stage clear too (before being removed).
      const m = room.media;
      if (isLive(m) && room.users.get(m.presenter)?.clientId === target.clientId) {
        setMedia(room, null, { playing: false });
        emitSystem(room, `${m.by}'s share ended`);
      }
      // Every tab that browser has open in this room goes, not just one.
      for (const [sid, u] of [...room.users.entries()]) {
        if (u.clientId !== target.clientId) continue;
        const s = io.sockets.sockets.get(sid);
        if (!s) continue;
        // Watching someone else's share: let go of it before leaving.
        if (isLive(room.media)) s.emit("player:action", stageCleared());
        s.emit("room:denied", { reason: "removed" });
        detach(s, { announce: false });
      }
      emitSystem(room, `${target.name} was removed by the host`);
    });

    on("host:transfer", ({ targetId }) => {
      const room = roomOf(socket);
      if (!room || !isAdmin(room, socket.id) || targetId === socket.id) return;
      const target = room.users.get(targetId);
      if (!target) return;
      // Handing the crown back to the creator is always fine.
      if (!isOwnerId(room, targetId) && !canTarget(room, socket.id, targetId)) {
        return;
      }
      setHost(room, targetId);
      emitSystem(room, `${target.name} is now the host`);
    });

    // The creator takes the crown back from whoever holds it.
    on("host:reclaim", () => {
      const room = roomOf(socket);
      if (!room || !isOwnerId(room, socket.id) || room.hostId === socket.id) {
        return;
      }
      setHost(room, socket.id);
      const me = room.users.get(socket.id);
      emitSystem(room, `${me.name} (room creator) took back the host`);
    });

    on("host:mute", ({ targetId }) => {
      const room = roomOf(socket);
      if (!room || !canTarget(room, socket.id, targetId)) return;
      if (!room.callers.has(targetId)) return;
      io.to(targetId).emit("call:force-mute");
    });

    // Per-person overrides: video control, chat, joining the call.
    on("host:perm", ({ targetId, perm, value }) => {
      const room = roomOf(socket);
      if (!room || !canTarget(room, socket.id, targetId)) return;
      if (!oneOf(perm, ["video", "chat", "call"])) return;
      const target = room.users.get(targetId);
      const p = { ...(room.perms.get(target.clientId) || {}) };
      p[perm] = !!value;
      room.perms.set(target.clientId, p);

      if (perm === "call" && !value) dropFromCall(room, target.clientId);
      const NOTICE = {
        video: value
          ? "The host let you control the video"
          : "The host took back video control",
        chat: value ? "The host turned your chat back on" : "The host turned off your chat",
        call: value ? "You can join the call again" : "The host removed you from the call",
      };
      noticeTo(room, target.clientId, NOTICE[perm]);
      broadcastUsers(room);
      ctx.permsChanged(room);
    });

    on("host:playback", ({ mode }) => {
      const room = roomOf(socket);
      if (!room || !canRunRoom(room, socket.id)) return;
      if (!oneOf(mode, ["host", "everyone"])) return;
      room.playback = mode;
      broadcastSettings(room);
      emitSystem(
        room,
        mode === "everyone"
          ? "Everyone can now control the video"
          : "Only the host controls the video now"
      );
      broadcastUsers(room);
      ctx.permsChanged(room);
    });

    // Room switches: approval, order, autoplay, skip/replay votes.
    on("host:settings", (p) => {
      const room = roomOf(socket);
      if (!room || !canRunRoom(room, socket.id)) return;
      if (!allow("host:settings", 12, 10_000)) return;
      const s = room.settings;
      if (typeof p.approval === "boolean") s.approval = p.approval;
      if (oneOf(p.order, ["votes", "manual"])) s.order = p.order;
      if (typeof p.autoplay === "boolean") s.autoplay = p.autoplay;
      if (typeof p.voteSkip === "boolean") s.voteSkip = p.voteSkip;
      broadcastSettings(room);
      for (const hook of settingsHooks) hook(room);
    });

    // Set (4–64 characters) or clear (null) the room password. Only new
    // people are asked for it; everyone already admitted stays admitted.
    on("host:password", async ({ password }, reply) => {
      const room = roomOf(socket);
      if (!room || !canRunRoom(room, socket.id)) {
        return reply({ ok: false, error: "Only the room's creator can do that" });
      }
      const valid =
        password === null ||
        (typeof password === "string" &&
          password.length >= PASSWORD_MIN &&
          password.length <= PASSWORD_MAX);
      if (!valid) {
        return reply({
          ok: false,
          error: `Passwords are ${PASSWORD_MIN}–${PASSWORD_MAX} characters`,
        });
      }
      // Hashing is deliberately slow, so changes are rate limited (per
      // socket, and per address across reconnects).
      if (
        !allow("host:password", 5, 30_000) ||
        !shared.allow(`pw-set:${clientAddress(socket)}`, ...opts.passwordSetPerAddress)
      ) {
        return reply({ ok: false, error: "Slow down a little" });
      }
      // Changes land in the order they were asked for, even though setting
      // one has to wait for the hash.
      const seq = ++room.passwordSeq;
      if (password === null) {
        if (!room.password) return reply({ ok: true });
        room.password = null;
        reply({ ok: true });
        broadcastSettings(room);
        emitSystem(room, "The host removed the room password");
        return;
      }
      const salt = crypto.randomBytes(SALT_BYTES);
      const hash = await hashPassword(password, salt);
      // While hashing: the room may have ended, this socket may have lost
      // the right to do this, or a newer change may have come in.
      if (roomOf(socket) !== room || !canRunRoom(room, socket.id)) {
        return reply({ ok: false, error: "Only the room's creator can do that" });
      }
      if (room.passwordSeq !== seq) {
        return reply({ ok: false, error: "The password was changed again meanwhile" });
      }
      room.password = { salt: salt.toString("hex"), hash: hash.toString("hex") };
      reply({ ok: true });
      broadcastSettings(room);
      emitSystem(room, "The host set a room password");
    });

    on("host:lock", ({ locked }) => {
      const room = roomOf(socket);
      if (!room || !canRunRoom(room, socket.id)) return;
      room.locked = !!locked;
      broadcastSettings(room);
      emitSystem(
        room,
        room.locked
          ? "The host locked the room — no new people can join"
          : "The host unlocked the room"
      );
    });

    on("host:end", () => {
      const room = roomOf(socket);
      if (!room || !canRunRoom(room, socket.id)) return;
      // A live share dies with the room: everyone lets go of it first.
      const live = isLive(room.media);
      for (const sid of room.users.keys()) {
        const s = io.sockets.sockets.get(sid);
        if (!s) continue;
        if (live) s.emit("player:action", stageCleared());
        s.emit("room:denied", { reason: "ended" });
        s.leave(room.code);
        s.data.code = null;
      }
      const wasPublic = room.isPublic;
      destroyRoom(room);
      const now = Date.now();
      for (const [c, t] of endedCodes) {
        if (now - t >= opts.endedTtlMs) endedCodes.delete(c);
      }
      endedCodes.set(room.code, now);
      if (wasPublic) broadcastLobby();
      flush();
    });

    // ---- Playback ----
    on("player:action", (p) => {
      const room = roomOf(socket);
      if (!room) return;
      if (!allow("player", 12, 4_000)) return;
      const type = oneOf(p.type, ["load", "play", "pause", "seek"]);
      if (!type) return;

      const snapBack = () =>
        socket.emit("player:action", {
          type: room.isPlaying ? "play" : "pause",
          time: currentTime(room),
          media: room.media,
          isPlaying: room.isPlaying,
          at: Date.now(),
          denied: true,
        });

      // Not allowed to drive: snap this viewer back to the room's position.
      if (!effectivePerms(room, socket.id).video) return snapBack();

      if (type === "load") {
        const next = media.fromClient(p.media) || media.parseInput(str(p.input, 2000));
        if (!next) {
          return socket.emit("room:notice", "That doesn't look like a YouTube link");
        }
        setMedia(room, next, { by: socket.id });
        return;
      }

      // Play/pause/seek only make sense for the video that's on now; a stale
      // one (sent just before someone changed it) is dropped. A live share
      // has no timeline to drive.
      if (!media.isTimed(room.media) || p.key !== media.key(room.media)) return;
      const time = num(p.time, 0, room.duration || 1e9);

      if (type === "play") room.isPlaying = true;
      if (type === "pause") room.isPlaying = false;
      if (time !== null) room.time = time;
      else room.time = currentTime(room);
      room.updatedAt = Date.now();
      if (type !== "pause") room.endedKey = null;

      socket.to(room.code).emit("player:action", {
        type,
        time: room.time,
        media: room.media,
        isPlaying: room.isPlaying,
        at: Date.now(),
        by: room.users.get(socket.id)?.name,
        byId: socket.id,
      });
    });

    // Someone's player learned the duration. It decides when the server
    // calls "ended", so it's taken straight from people who could skip
    // anyway; from viewers only once two different people agree on it.
    on("player:meta", (p) => {
      const room = roomOf(socket);
      if (!room || room.duration || !media.isTimed(room.media)) return;
      if (p.key !== media.key(room.media)) return;
      const d = validDuration(p.duration);
      if (!d) return;
      if (effectivePerms(room, socket.id).video) {
        room.duration = d;
        return;
      }
      const cid = room.users.get(socket.id).clientId;
      room.durationReports.set(cid, d);
      const agree = [...room.durationReports].filter(
        ([other, x]) => other !== cid && Math.abs(x - d) < 1.5
      );
      if (agree.length) room.duration = d;
    });

    // A player hit the end. Trusted from controllers; from anyone else only
    // once the room's own clock agrees the video is (nearly) over.
    on("player:ended", (p) => {
      const room = roomOf(socket);
      if (!room || !media.isTimed(room.media)) return;
      if (p.key !== media.key(room.media)) return;
      if (!allow("ended", 4, 10_000)) return;
      const nearEnd = room.duration && currentTime(room) >= room.duration - 5;
      if (effectivePerms(room, socket.id).video || nearEnd) handleEnded(room);
    });

    // Resync: the authoritative state, right now.
    on("player:request-sync", () => {
      const room = roomOf(socket);
      if (!room || !allow("sync", 10, 10_000)) return;
      socket.emit("player:action", {
        type: room.isPlaying ? "play" : "pause",
        time: currentTime(room),
        media: room.media,
        isPlaying: room.isPlaying,
        at: Date.now(),
      });
    });

    // Chat lives in server/social.js.

    // ---- Voice / video calls (WebRTC mesh, signaled through here) ----
    // Acked, so a call:join that arrives before room:join (buffered while the
    // socket was reconnecting) fails loudly instead of leaving a ghost seat.
    on("call:join", ({ mic, cam }, reply) => {
      const room = roomOf(socket);
      if (!room || !allow("call:join", 4, 10_000)) return reply({ ok: false });
      if (!effectivePerms(room, socket.id).call) {
        return reply({ ok: false, reason: "blocked" });
      }
      const peers = [...room.callers.entries()]
        .filter(([id]) => id !== socket.id)
        .map(([id, c]) => ({ id, session: c.session }));
      // Each seat gets a fresh session id; signals are addressed to a session.
      const session = crypto.randomUUID();
      room.callers.set(socket.id, { mic: !!mic, cam: !!cam, session });
      reply({ ok: true, session, peers });
      broadcastUsers(room);
    });

    on("call:signal", ({ to, toSession, data }) => {
      const room = roomOf(socket);
      const from = room && room.callers.get(socket.id);
      const target = room && room.callers.get(to);
      if (!from || !target || target.session !== toSession) return;
      if (!allow("signal", 200, 10_000)) return;
      io.to(to).emit("call:signal", {
        from: socket.id,
        fromSession: from.session,
        data,
      });
    });

    on("call:state", ({ mic, cam }) => {
      const room = roomOf(socket);
      const seat = room && room.callers.get(socket.id);
      if (!seat || !allow("call:state", 10, 2_000)) return;
      seat.mic = !!mic;
      seat.cam = !!cam;
      broadcastUsers(room);
    });

    on("call:leave", () => {
      const room = roomOf(socket);
      if (!room || !room.callers.delete(socket.id)) return;
      io.to(room.code).emit("call:left", socket.id);
      broadcastUsers(room);
    });

    // ---- Public lobby ----
    on("lobby:subscribe", () => {
      if (!allow("lobby", 4, 10_000)) return;
      socket.join(LOBBY_CHANNEL);
      socket.emit("lobby:list", publicRoomList());
    });
    on("lobby:unsubscribe", () => socket.leave(LOBBY_CHANNEL));

    // ---- Anonymous venting feed ----
    on("vent:list", () => {
      socket.emit("vent:list", vents.slice(-60));
    });
    on("vent:post", ({ text }) => {
      if (!allow("vent", 3, 30_000)) {
        socket.emit("room:notice", "Take a breath — you can post again shortly");
        return;
      }
      const clean = str(text, 400);
      if (!clean) return;
      const seed = vents.length + socket.id.charCodeAt(0);
      const vent = {
        id: msgId("v"),
        alias: VENT_ALIASES[seed % VENT_ALIASES.length],
        emoji: VENT_EMOJIS[seed % VENT_EMOJIS.length],
        text: clean,
        ts: Date.now(),
      };
      vents.push(vent);
      if (vents.length > 300) vents.shift();
      io.emit("vent:new", vent);
    });

    for (const f of features) f.connection?.(socket, on);

    socket.on("disconnect", () => detach(socket));
  });

  return {
    rooms,
    flush,
    close() {
      clearInterval(tickTimer);
      clearInterval(saveTimer);
      clearInterval(sweepTimer);
      flush();
      for (const room of rooms.values()) destroyRoom(room);
    },
  };
}

module.exports = { attachRealtime, SOCKET_OPTIONS };
