# watchnparty (clone)

A synchronized watch-party app — create a room, paste a YouTube link, and
everyone watches the same frame at the same time, with live chat. A faithful
clone of the watchnparty.com marketing site plus a **working real-time product**.

Built with **Next.js 16 (App Router) · TypeScript · Tailwind v4 · Framer Motion ·
Socket.IO · YouTube IFrame API**.

## What's included

- **Landing page** (`/`) — intro loading animation, animated hero with rotating
  categories, counting stats, use-case cards, 3-step onboarding, feature grid,
  room preview mockup, dual FAQ accordions, SEO footer. All scroll-reveal
  animated to match the original.
- **Lobby entry** (`/join`) — pick a display name, then create a room (optionally
  named and listed publicly) or join by code.
- **Public lobbies** (`/lobby`) — discover and join open watch parties in real
  time. Cards show the current video thumbnail, viewer count, and who's inside;
  the list updates live as rooms fill, change video, or empty out.
- **Anonymous board** (`/vent`) — a global feed to post thoughts anonymously.
  Each post gets a random alias + emoji; new posts stream in live for everyone.
- **Room** (`/room/[code]`) — the real product:
  - Paste any YouTube link → it loads for everyone in the room.
  - **Synced playback** — play / pause / seek propagate to all viewers in real time.
  - **Time-accurate late-join** — the server tracks elapsed playback, so someone
    joining mid-video lands on the exact current frame.
  - **Live chat** with per-user colors, avatars, and join/leave events.
  - **Presence** — live "N watching" count and avatar stack.
  - **Invite** — copy the room link; **Resync** — snap back to the room's position.
  - A "tap to join" overlay handles browsers that block autoplay for late joiners.

## Run it

```bash
npm install
npm run dev          # custom Socket.IO + Next server on http://localhost:3000
```

Open two browser windows on the same room code to see sync in action.

```bash
npm run build && npm start   # production
```

## Architecture

- `server.js` — custom Node HTTP server that runs Next.js **and** Socket.IO.
  Holds room state in memory (`Map<code, Room>`): current video, play state,
  playhead + `updatedAt` timestamp, user list, and recent chat. Late joiners get
  `time + elapsed` so they sync to the live position. Swap the in-memory `Map`
  for Redis to run multiple instances.
- `components/room/RoomClient.tsx` — owns the socket connection and the YouTube
  player. An `applyingRemote` flag prevents the feedback loop where applying a
  remote action re-broadcasts it. Seeks are detected by sampling `getCurrentTime`.
- `lib/socket.ts` — singleton `socket.io-client` + shared event types.
- `lib/youtube.ts` — URL → video-id parsing and room-code generation.

### Socket events

| Event | Direction | Purpose |
|---|---|---|
| `room:join` | client → server | join a room with a display name |
| `room:state` | server → client | full snapshot for a newcomer (video, time, users, chat) |
| `room:users` | server → clients | updated presence list |
| `player:action` | both | `load` / `play` / `pause` / `seek` broadcast |
| `player:request-sync` | client → server | ask for the authoritative position (Resync) |
| `chat:message` | both | live chat |
| `lobby:subscribe` / `lobby:list` | both | live list of public rooms for `/lobby` |
| `vent:post` / `vent:new` / `vent:list` | both | anonymous global board |

### Live streams vs. VODs

Regular YouTube videos get time-accurate catch-up (a late joiner seeks to the
current position). 24/7 **live streams** report a nonsensical duration and can't
be seeked to a past timestamp, so the client detects them (implausible duration)
and simply joins at the live edge — which is already synchronized by definition.

## Wiring real Google sign-in (optional)

The demo uses a guest display name so it runs with zero config. To add real
"Continue with Google", install NextAuth and provide Google OAuth credentials —
only you can create these in Google Cloud Console:

```bash
npm install next-auth
# .env.local
# AUTH_GOOGLE_ID=...
# AUTH_GOOGLE_SECRET=...
# AUTH_SECRET=...   (openssl rand -base64 32)
```

Then replace the name-based join with the session's name/email. The room and
sync layer already keys on a display name, so no changes are needed there.

## Notes

- YouTube is the supported source (matching the original). The `player:action`
  layer is source-agnostic, so Twitch/Vimeo players can be added behind the same events.
- Some 4K embeds can be slow/flaky on rapid reloads — this is a YouTube embed
  quirk, not the sync layer. Standard videos load instantly.
