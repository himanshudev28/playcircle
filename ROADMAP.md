# PlayCircle roadmap

What's built, what's next, and why some items are on hold. Update this file
whenever a batch ships or a decision changes.

_Last updated: 2026-10-13_

## Decisions so far

| Date | Decision |
| --- | --- |
| 2026-10-13 | Build **Phase 1 (Reliability)** and **Phase 2 (Shared watch queue)** first. Everything else waits. |
| 2026-10-13 | Skip anything that needs an outside service or paid key for now (see [On hold: needs outside services](#on-hold-needs-outside-services)). |
| 2026-10-13 | Batch 2: **Phase 3 (Social)** + **Share anything** (tab, screen, local file). Video-URL sharing left out. |
| 2026-10-13 | Batch 3: **paste any link**. The server resolves what was pasted; only openly shared video, no page JavaScript run, nothing protected bypassed. Dailymotion left as is (its player needs a partner Player ID). |
| 2026-10-13 | Room state is saved to a local file (`.data/rooms.json`) so rooms survive a restart. No Redis. Turn it off with `PERSIST=0`. |
| Earlier | Google sign-in deferred; people join with a display name only. |
| Earlier | The room's creator keeps "first right": they always hold the crown and nobody can act on them. |

## Batch 1 — done (2026-10-13, not yet committed)

### Phase 1 · Reliability

- [x] Every socket event validated, and a bad payload can never crash the server
- [x] Rate limits on chat, player actions, joins, queue actions, signaling
- [x] Caps on room count, people per room, message size
- [x] Room codes validated (`PC-XXXX` style only)
- [x] Host permissions checked on the server for every privileged event
- [x] Drift detection: server broadcasts the true playhead every 3s; clients
      that drift more than ~1.5s resync automatically
- [x] Sync status shown to each viewer (in sync / catching up / buffering /
      reconnecting)
- [x] Reconnect: rejoin and resync automatically after a dropped connection
- [x] Room state restored after a server restart (comes back paused)
- [x] Stale rooms cleaned up (empty rooms, restored rooms nobody returns to)
- [x] Automated tests for sync, permissions and the queue (`npm test`)

### Phase 2 · Shared watch queue

- [x] Anyone can suggest a YouTube video to "Up next"
- [x] Host approval for suggestions (creator can turn approval off)
- [x] Votes; order by votes or by hand (creator's choice)
- [x] Host can approve, reorder, play now, skip, remove, clear
- [x] People can withdraw their own suggestions
- [x] Next video starts automatically when one ends (creator can turn off)
- [x] Thumbnails and titles; "Recently played" with "queue again"

Also in this batch: the creator gets the crown back immediately when their
stand-in host leaves; live streams are detected and never seeked; viewers'
reported video lengths count once two people agree (so one person can't fake
an early end).

Verified 2026-10-13: 23 server tests (`npm test`), a 59-check protocol
regression, and a two-person browser run (join mid-video, snap-back, seek,
pause, restart recovery, approval, auto-advance, live stream).

Known limit: a queued video's **length** isn't known until it has played,
because the free YouTube lookup (oEmbed) has no duration. A YouTube Data API
key would fix this (on hold, see below).

## Batch 2 — done (2026-10-13, not yet committed)

### Phase 3 · Social experience

- [x] Live emoji reactions floating over the video, tied to the playback timestamp
- [x] "Room reactions" moments strip of the most-reacted parts; click to jump
- [x] Chat: clickable timestamps, "📍 Moment" button, replies, message
      reactions, pinning, host announcements, search
- [x] Moderation: delete messages, block (hides someone for you), report to host
- [x] Polls: quick polls with a deadline and live results; vote to skip / replay
      (two-click confirm); "what should we watch next?" (host chooses binding)
- [x] Password-protected rooms (no accounts needed; people already in skip it)

### Share anything

- [x] Share a browser tab (with audio) or the entire screen
- [x] Stream a local video file live (presenter controls pause/seek for everyone)
- [x] Presenter quality cap (Auto/1080p/720p/480p) + each viewer's own quality
      choice; live stats; auto-retry; "Tap to unmute" when autoplay blocks sound
- [ ] Paste a direct video URL (.mp4 / .m3u8) — not built here; done in
      Batch 3 below

Decisions made while building:

- Skip/replay votes are **on by default**; the creator can switch them off
  ("Vote to skip" in Up next → Queue settings). A passed vote is binding.
- Up to **8 viewers per share** (mesh, no SFU); more get a warning.
- Block / report rely on the per-browser ID (no accounts) — a private window
  gets around them; reports go to the room's host only.

Limits that still apply: copy-protected sites (Netflix, Prime, Disney+,
Hotstar…) show black; tab audio only in desktop Chrome/Edge; phone browsers
can't share their screen (no `getDisplayMedia` on any mobile browser, PWA or
not); local-file streaming is re-encoded (not original quality); strict
networks need a TURN server (`NEXT_PUBLIC_ICE_SERVERS`).

### Mobile sharing + installable app (2026-10-13)

- [x] Camera on the stage (front/back, live flip; mic left out while in a call)
- [x] Video file from a phone (Android: native capture; Safari/iOS: canvas +
      Web Audio fallback, which also fixes desktop Safari)
- [x] Share menu becomes a bottom sheet on phones
- [x] PWA: manifest, icons, offline page, service worker (production only),
      "Install app" button where Chrome offers it
- [ ] Whole-screen share from an Android phone — needs a native companion
      app; plan in `NATIVE_SCREENSHARE.md` (or scrcpy, no code)

Camera and the install prompt need a secure origin: on a phone use the
HTTPS deploy (or a tunnel); a plain `http://<LAN-IP>:3000` disables them.

Verified 2026-10-13: server test suite (`npm test`) plus a two-browser run —
tab share start/view/stop, floating reactions + moments, clickable chat
timestamps, pin, quick poll voting, password set / wrong / right.

## Batch 3 — paste any link (2026-10-13, in progress / not yet committed)

The link box (and Up next) accepts almost any link; the server works out the
video. Everything plays synced with the queue, reactions, polls and moments.

- [x] YouTube (as before)
- [x] Vimeo
- [x] Twitch past broadcasts (synced) and live channels (shown as *Live*)
- [x] Paste a direct video URL: `.mp4` / `.m4v` / `.webm` / `.mov` / `.ogv`
      files, and `.m3u8` HLS streams (via hls.js), synced like YouTube
- [x] Streamable, Internet Archive and PeerTube through their public APIs
- [x] Any other page that shares its video openly: Open Graph `og:video`,
      Twitter player stream, schema.org `VideoObject`, `<video>`/`<source>`,
      oEmbed, or an embedded YouTube / Vimeo / Twitch player
- [x] Clear errors instead of broken players: pages that don't share their
      video ("use Share → Browser tab instead"), copy-protected services
      (Netflix, Prime Video, Disney+, Hotstar, Crunchyroll, Max, Hulu,
      Apple TV), Twitch clips (no player API), sites that block other players
      (e.g. TED's stream, some hosts without CORS), dead links
- [x] Safe fetching: public internet addresses only (private, loopback,
      link-local and metadata ranges blocked), DNS pinned against rebinding,
      every redirect re-checked, 6 s / 2 MB limits, results cached 10 min,
      rate-limited per connection and per address; file / HLS links on
      private hosts refused so viewers' browsers aren't sent into their own
      networks
- [x] One `StagePlayer` interface (`components/room/players/`) with adapters
      for YouTube, HTML5 video (files + HLS), Vimeo, Dailymotion and Twitch;
      `useSyncedPlayer` drives any of them with the same drift correction,
      echo handling and live detection
- [x] Full-screen button on the player box (floating call bubbles stay
      visible)
- [x] Protocol: `player:action {type:"load", input}` and `queue:add {input}`
      resolve on the server and ack `{ok}` / `{ok:false, error}`; media kinds
      `youtube` / `file` / `hls` / `vimeo` / `dailymotion` / `twitch` / `live`
- [ ] Dailymotion — left as is: its player shows "Forbidden" without a partner Player ID (see
      [On hold](#on-hold-needs-outside-services))

Limits that still apply: Twitch only plays on https pages (or `localhost`);
a page whose video only appears by running its own JavaScript isn't found
(use Share → Browser tab); copy-protected services stay out.

Verified 2026-10-13 in a browser. `npm test` also covers link resolution, the
safe fetcher (private / loopback / metadata addresses refused) and loading or
queueing by link over sockets.

## Ideas not started

- Original-quality file sharing (upload once; needs storage)

## On hold: needs outside services

Skipped for now (2026-10-13). Each needs a choice of provider, credentials,
and usually money.

| Item | What it needs | Notes |
| --- | --- | --- |
| Accounts, friends, saved/favourite rooms, profiles (Phase 4) | A sign-in provider (Google / email) **and** a database | The room layer keys on a display name + browser ID, so accounts can slot in later. |
| Redis-backed room state | A hosted Redis | Only needed to run more than one server instance. The file save covers restarts on one server. |
| SFU for larger calls and shares | LiveKit (hosted or self-run) or mediasoup | Calls are a WebRTC mesh today, fine for ~6 people. |
| TURN relay | Twilio, Cloudflare, Metered, or your own coturn | Already supported: set `NEXT_PUBLIC_ICE_SERVERS`. Without it, some strict networks can't connect calls. |
| AI group recommendations | An AI API key + a YouTube Data API key | Build after the queue and voting exist. |
| Queue video lengths | A YouTube Data API key | Without it, lengths appear only after a video has played. |
| Dailymotion | A Dailymotion partner account and its registered **Player ID** | Links are recognised, but Dailymotion's player shows "Forbidden" without one. Left as is for now (decided 2026-10-13); use tab share. |

## Hosting notes

- The app runs a long-lived Node server (Next.js + Socket.IO in `server.js`).
  **Vercel can't run it.** Use Render, Railway, Fly.io or a VPS.
- The room save file needs a **persistent disk**; on hosts with ephemeral
  disks, rooms won't survive a redeploy.
