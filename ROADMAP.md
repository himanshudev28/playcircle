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
- [ ] Paste a direct video URL (.mp4 / .m3u8) — not built (not requested)

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

## Ideas not started

- Paste a direct video URL (.mp4 / .m3u8, synced like YouTube)
- Original-quality file sharing (upload once; needs storage)
- Twitch / Vimeo (low priority: Twitch is mostly live; Vimeo often blocks embeds)

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

## Hosting notes

- The app runs a long-lived Node server (Next.js + Socket.IO in `server.js`).
  **Vercel can't run it.** Use Render, Railway, Fly.io or a VPS.
- The room save file needs a **persistent disk**; on hosts with ephemeral
  disks, rooms won't survive a redeploy.
