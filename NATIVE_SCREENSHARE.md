# Sharing a whole phone screen (Android, personal use)

Plan written 2026-10-13. The scope is **Android only, for personal use**,
installed as a sideloaded APK. There is no Play Store and no iPhone. iOS is
out of scope; it would need a ReplayKit broadcast extension and an Apple
account.

## Why the website can't do it

No mobile browser supports `getDisplayMedia` (Chrome Android, Samsung
Internet and Firefox Android). Installing the site as a PWA doesn't change
that. In the web app, phones can share their **camera** (front or back) or a
**video file** from the gallery. Tab and screen are greyed out with "Phone
browsers can't share the screen". To share the whole phone screen, you need
either a computer in the middle (option 1) or a small native app (option 2).

---

## Option 1: no code (try this first)

Mirror the phone onto a computer, then share that window from the desktop
browser with the existing **Share → Entire screen** flow.

**scrcpy** (free, open source, works on Mac, Windows and Linux):

1. On the phone, turn on Developer options, then **USB debugging**.
2. On the computer, install scrcpy (`brew install scrcpy` on a Mac). Plug in
   the phone and run `scrcpy`. A window opens showing the phone screen.
   - For Wi-Fi instead of USB, connect over USB once and run
     `scrcpy --tcpip`. On Android 11+ you can also pair with Wireless
     debugging.
3. In the room on the desktop browser, choose **Share → Entire screen**. In
   Chrome's picker, open the **Window** tab and pick the scrcpy window.

**Audio:** scrcpy forwards phone audio to the computer on **Android 11+**,
and this is on by default. On Android 11 the phone must be unlocked when
scrcpy starts. Apps that block capture stay silent. Getting that audio into
the room is a separate step, and it depends on the desktop. Chrome on
Windows can send it when you share the entire screen and tick "Share system
audio". Chrome on a Mac usually can't send system or window audio, so viewers
get video only.

**Limits:** the computer must stay on and in the room, and it does the
sending. Quality depends on the USB or Wi-Fi link. DRM apps (Netflix and
similar) show black, the same as everywhere else.

If this is good enough, stop here. Everything below is the native app.

---

## Option 2: a small companion app

### Recommendation

Use **React Native (Expo, with a development build) and
[`react-native-webrtc`](https://github.com/react-native-webrtc/react-native-webrtc)**,
plus the regular `socket.io-client`. Build it on your Mac and sideload the
APK.

Why this beats the alternatives for a web developer:

| Option | Verdict |
| --- | --- |
| **React Native + react-native-webrtc** | **Pick this.** You write TypeScript with the same `RTCPeerConnection` API and the same `socket.io-client` the web app uses. The presenter code in `useLiveStage.ts` ports almost line for line. On Android, `getDisplayMedia()` is built in. The library ships the MediaProjection foreground service (v118.0.2+), and you turn it on with one flag. You write no Kotlin beyond that flag. |
| Kotlin + WebRTC Android SDK + socket.io-client-java | This works and gives the smallest APK, but you'd rewrite all the signalling in Kotlin and own the foreground service, the MediaProjection lifecycle and the Gradle setup yourself. Google stopped publishing its prebuilt WebRTC for Android, so you'd depend on a third-party build (`io.getstream:stream-webrtc-android` or `io.github.webrtc-sdk:android`). It's more native surface to learn and maintain, and nothing is shared with the web code. |
| Capacitor (wrap the site) | Not suitable. The Android WebView doesn't support `getDisplayMedia` either, so you'd still need a native plugin that does both the capture and the WebRTC. That's the Kotlin option with extra layers. |
| Flutter + flutter_webrtc | Capable, but it means learning Dart and porting the logic to a new language. That's no gain over React Native for you. |

### How it plugs into the existing stage protocol

The app is just **another stage presenter**. Viewers stay on the web app and
nothing changes for them. The presenter makes every offer, and viewers only
answer. Line references below are to the working tree on 2026-10-13.

**Connect:** use `io(SERVER_URL, { transports: ["websocket"] })`. The server
allows any origin (`cors: { origin: "*" }`, `server/realtime.js:97-102`). It
pings every 10 s with an 8 s timeout, so a frozen app drops in about 18 s.

**1. Join the room.** The app sends `room:join` (`server/realtime.js:972`).
There is no ack. The answer arrives as either `room:state` or `room:denied`.

```ts
socket.emit("room:join", {
  code,          // /^[A-Z0-9-]{2,20}$/, upper-cased by the server (server/limits.js:98)
  name,          // ≤24 chars, default "Guest" (realtime.js:980)
  clientId,      // ≤64 chars; a random UUID saved in the app, i.e. the app's identity (realtime.js:979)
  password,      // only needed for a password room the first time this clientId joins (realtime.js:1000-1032)
});
// → "room:state" { media, hostId, settings, users[], ... }  (snapshot, realtime.js:317)
// → "room:denied" { reason: "password" | "locked" | "removed" | "ended" | "full" | "invalid", wrong?, limited? }
```

- **Password:** once a clientId has been admitted, it never needs the
  password again. That's the `members` set in `admission()`,
  `realtime.js:591-614`.
- **Locked room:** a new clientId gets `locked` (`realtime.js:606`), so the
  host must unlock the room or let the app in first.
- **Room code that doesn't exist:** the join **creates** the room, and the
  app becomes its owner (`realtime.js:1041-1046`). This is a pitfall. See
  "Server changes" below.

**2. Permission to share.** `stage:start` needs `effectivePerms(...).video`
(`server/stage.js:80`, `realtime.js:230-240`). The owner and the current host
always have it. Anyone else has it only if the room's playback mode is
"everyone", or if the host granted "video" to that person (`host:perm`,
`realtime.js:1155`). The app joins as a separate person, so in practice it
works like this: the room playback is set to "everyone", or the host taps
"video control" on the app's entry in the people list. If the host later takes
video control back, the server ends the share and sends the app
`room:notice` (`stage.js:62-71`).

**3. Claim the stage.** This call is acked.

```ts
socket.timeout(8000).emit("stage:start",
  { source: "screen", title: "Himanshu's phone" },   // source ∈ tab|screen|file|camera (stage.js:83); title ≤80 chars
  (err, reply) => { /* reply: { ok: true, streamId } | { ok: false, error } */ });
```

The server sets `room.media = { kind: "live", source, streamId, presenter:
socket.id, title, by }` and broadcasts `player:action { type: "load", media }`
(`stage.js:88-102`, `realtime.js:418-437`). The web viewers react to that
broadcast by themselves.

**4. Each viewer asks; the app offers.** For each viewer:

| Direction | Event | Payload |
| --- | --- | --- |
| server → app | `stage:viewer` | `{ id: viewerSocketId, streamId }` (`stage.js:126`) |
| app → server | `stage:signal` | `{ to: id, streamId, data: { sdp: offer, n } }` |
| server → app | `stage:signal` | `{ from: id, streamId, data: { sdp: answer, n } }` (`stage.js:137`) |
| both ways | `stage:signal` | `data: { candidate, n }` |
| server → app | `stage:quality` | `{ id, streamId, level: "auto"\|"1080"\|"720"\|"480" }` (`stage.js:142-152`) |
| server → app | `stage:viewer-left` | `{ id, streamId }` (`stage.js:57`) |

Copy these rules from `useLiveStage.ts` exactly. Web viewers depend on them.

- **One `RTCPeerConnection` per viewer.** Add one video transceiver and one
  audio transceiver up front, both `sendonly` (`useLiveStage.ts:1112-1113`).
  Add the audio transceiver even when there's no audio track, so later audio
  is a `replaceTrack`, not a renegotiation.
- **Negotiation counter `n`.** Use `n = ++counter` per new connection, and
  put it in every offer and candidate. Drop any answer or candidate whose
  `n` doesn't match that viewer's current connection
  (`useLiveStage.ts:1161-1180`).
- **Repeated `stage:viewer`.** A repeat for the same viewer means it's
  retrying. Close that viewer's old connection and offer again.
- **Queued candidates.** Queue ICE candidates that arrive before the answer,
  and apply them after `setRemoteDescription`.
- **Quality and bitrate.** On `stage:quality`, set the video sender's
  `maxBitrate` and `scaleResolutionDownBy` with the same values as
  `MAX_BITRATE` and `TARGET_HEIGHT` (`useLiveStage.ts:75-84`, `1219-1260`).
  For a screen, use `degradationPreference: "maintain-resolution"`.
- **Signal size.** Each signal object must be at most 32 kB
  (`stage.js:24`). Normal SDP is a few kB.

**5. Stop.** Send `stage:stop { streamId }` (`stage.js:105`). The share also
ends on its own when the app's socket disconnects (`stage.js:50-55`).

**6. Things the app must listen for:**

- **`player:action`:** if `type === "load"` and `media?.streamId` is no
  longer ours, the share was ended or replaced. Stop capture locally.
- **`room:denied` or `disconnect`:** the server has already dropped the
  share. Stop capture. After a reconnect, rejoin and send a new
  `stage:start`; it gets a new streamId. Viewers follow automatically.
- **`room:notice`:** show it as a toast.
- **More than 8 viewers:** skip extra `stage:viewer` requests and warn, the
  same as the web app does.

### App screens (three)

1. **Join:** server URL (saved), room code, display name, and password
   (optional). Join button. Show `room:denied` reasons in plain words.
2. **In room:** the room title and the people count. A big **Share screen**
   button, a quality cap (Auto/720p/480p) and a hint: "Ask the host for video
   control" if `users[].perms.video` is false for the app.
3. **Sharing:** "Live: N viewers" and a **Stop** button. Android also shows its
   own notification and, on 15 QPR1+, a status-bar chip that stops the share
   when tapped.

### Android build steps

1. **Tools:** install Android Studio (it brings the SDK, platform-tools/adb
   and JDK 17) and Node 20+. Use a real Android 10+ phone with USB debugging
   on. Emulators can't really test screen capture.
2. **Create the project:**
   `npx create-expo-app playcircle-share`, then
   `npx expo install react-native-webrtc @config-plugins/react-native-webrtc socket.io-client @react-native-async-storage/async-storage`.
   Add the config plugin to `app.json`. Expo Go can't load WebRTC, so you need
   a development build.
3. **Generate native code once:** run `npx expo prebuild -p android`, then
   commit `android/` and edit it directly. That's simplest for a single
   personal app.
   - In `AndroidManifest.xml`, add these permissions: `INTERNET`,
     `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PROJECTION`,
     `POST_NOTIFICATIONS`, and `RECORD_AUDIO` (only if you add audio later).
   - In `MainActivity.kt` `onCreate`, before `super.onCreate`, add
     `WebRTCModuleOptions.getInstance().enableMediaProjectionService = true`.
     This starts the library's `mediaProjection`-type foreground service,
     which Android 14+ requires.
   - If you test against `http://<your-LAN-IP>:3000`, add
     `android:usesCleartextTraffic="true"`. Android blocks plain HTTP and WS by
     default. A deployed `https://` server doesn't need it.
4. **Capture:** call `mediaDevices.getDisplayMedia()` from react-native-webrtc.
   Android shows its consent dialog, and on 14+ it asks "single app" or
   "entire screen". Pick **Entire screen**. Android asks again for every
   share, because a MediaProjection token is single-use. Listen for the
   video track's `ended` event so that a stop from the status-bar chip, a
   screen lock or the notification ends the share.
5. **Port the presenter code:** copy `StageEngine`'s presenter half (the
   attach handlers, `startShare` for `"screen"`, `offerTo`,
   `onPresenterSignal`, `applyParams`, `closePeer`) into one `stage.ts`. Drop
   the viewer half and all the file and tab code.
6. **Run and install:** with the phone plugged in, run
   `npx expo run:android`. To build an APK you can keep, run
   `cd android && ./gradlew assembleRelease`; it's signed with the debug key,
   which is fine for personal use. Then `adb install -r
   app/build/outputs/apk/release/app-release.apk`, or copy the APK to the
   phone and allow "Install unknown apps".
7. **Phone settings:** set the app's battery use to *Unrestricted*. Some
   brands (Xiaomi, Samsung, Oppo) kill background apps aggressively even when
   a foreground service is running.

There is no Play Console, no foreground-service declaration and no demo
video, because the app isn't published. One thing to watch: Google's
developer verification for sideloaded apps started on 2026-09-30 in Brazil,
Indonesia, Singapore and Thailand, and it expands through 2027. Installing
your own build with `adb` or Android Studio keeps working. A copied APK
might later need the "advanced flow" or a free limited-distribution
registration.

### Server changes

**None are required.** The app uses the existing events unchanged, and
`source: "screen"` is already accepted.

Optional small improvements (about 1 hour each):

1. **`joinOnly` on `room:join`.** If `p.joinOnly` is set and the room doesn't
   exist, send `room:denied { reason: "missing" }` instead of creating the
   room. This prevents a typo from creating a room owned by the app
   (`realtime.js:1036-1046`). Add `"missing"` to `DeniedReason` in
   `lib/socket.ts:119`.
2. **A `"phone"` source.** Add it to `SOURCE_TITLES` and `oneOf` in
   `stage.js`, to `ShareSource` in `lib/socket.ts`, and to `SOURCE_NOUN` in
   `LiveStageView.tsx`, so viewers see "Connecting to X's phone…". Purely
   cosmetic: a `title` like "Himanshu's phone" already does most of this.
3. **Serve the ICE list.** Add `GET /ice.json`, which returns the same JSON as
   `NEXT_PUBLIC_ICE_SERVERS`, so the app fetches it instead of hard-coding it.
   This also lets you rotate TURN credentials in one place.
4. **Web hint.** Change ShareMenu's "Phone browsers can't share the screen"
   to point at the app, or at the scrcpy option above.

### TURN

A phone on mobile data is usually behind carrier-grade NAT, so direct
connections often fail. Plan on a TURN relay (Cloudflare, Metered, Twilio or
your own coturn). The web app already supports one through
`NEXT_PUBLIC_ICE_SERVERS`. The app needs the **same list**, either pasted
into its config or fetched with optional change 3. Without TURN, expect
viewers stuck on "Connecting…" when the phone is on mobile data.

### Audio

- **Phase 1 is video only.** Stock react-native-webrtc returns no audio
  track from `getDisplayMedia`.
- **App audio is technically possible on Android 10+** through
  `AudioPlaybackCaptureConfiguration` (needs `RECORD_AUDIO` and the same
  MediaProjection). It only captures apps whose audio usage is media, game or
  unknown, and that haven't opted out. Many streaming and DRM apps opt out.
  Notifications and calls are never captured.
- **Ways to get it:** switch to Stream's fork `@stream-io/react-native-webrtc`,
  which adds `includeAudio` on Android by mixing app audio into the
  microphone track, or write a small Kotlin native module that feeds an
  `AudioRecord` into the audio track. Treat this as phase 4 and verify it on
  a device before relying on it.
- **Microphone narration is easy:** call `getUserMedia({ audio: true })` and
  put the track on the audio transceiver that already exists.

### Effort (personal Android build, video first)

| Phase | Work | Time |
| --- | --- | --- |
| 0 | Try scrcpy (option 1) | 15–30 min |
| 1 | Install the toolchain, Expo app skeleton, permissions, first sideload | ½–1 day |
| 2 | Join screen, `stage:start`, presenter port (offer per viewer, `n`, candidates, stop) — first live share seen in a web viewer | 1–2 days |
| 3 | Hardening: reconnect/rejoin, `player:action` takeover, quality per viewer, viewer cap, TURN, battery settings | 1 day |
| 4 (optional) | App audio (fork or native module), server tweaks 1–3 | 1–3 days, uncertain |

That's about **3–4 days for a solid video-only share**, assuming you've never
built an Android app before.

### Risks and limits

- **Upload and heat.** In a mesh, the phone encodes and uploads one stream
  per viewer. At 720p (2.5 Mbps) and 8 viewers, that's about 20 Mbps of
  upload and up to 8 hardware encoders. Many phones run out of encoders or
  throttle. Default the cap to 720p or 480p and expect about 3–5 smooth
  viewers. More than that needs an SFU (already on the roadmap: LiveKit or
  mediasoup).
- **Protected content.** DRM and secure windows (Netflix, Prime, Hotstar,
  banking apps, anything using `FLAG_SECURE`) appear black.
- **Single-app mode.** On Android 14+ the user can pick "single app" in the
  consent dialog. Then only that app is shared, and the system bars are
  hidden.
- **Screen lock.** On Android 15 QPR1+, locking the screen stops the share,
  and so does tapping the status-bar chip. The app must treat a stopped track
  as `stage:stop`.
- **Consent every time.** The consent dialog appears on every share, and
  Android doesn't allow skipping it.
- **Socket drops.** A dropped socket (bad network, the OS killing the app)
  ends the share on the server. Viewers see it end, and the app has to start
  a new share.
- **Library changes.** react-native-webrtc and Expo upgrades occasionally
  break native builds. Pin the versions once it works.

### What you need

- A Mac (or a Windows/Linux PC) with **Android Studio**, Node 20+ and
  about 15 GB of free disk.
- An **Android 10+ phone** (14+ to test the newer consent flow) and a USB
  cable.
- The PlayCircle server reachable from the phone: deployed over HTTPS, or the
  LAN IP while developing.
- A **TURN service** for use on mobile data. Several have free tiers.
- No Google Play account and no fees.

---

## Sources

- [react-native-webrtc: Android install (screen-share foreground service, `enableMediaProjectionService`)](https://github.com/react-native-webrtc/react-native-webrtc/blob/master/Documentation/AndroidInstallation.md)
- [Android: Media projection (Android 14 consent and token rules, app screen sharing, 15 QPR1 status-bar chip and stop on lock)](https://developer.android.com/media/grow/media-projection)
- [Android 14: foreground service types required](https://developer.android.com/about/versions/14/changes/fgs-types-required)
- [Android: capture audio playback (AudioPlaybackCapture rules)](https://developer.android.com/media/platform/av-capture)
- [Stream: React Native screen-share setup (Android permissions, `includeAudio` via AudioPlaybackCapture)](https://getstream.io/video/docs/react-native/guides/screensharing/react-native/)
- [react-native-webrtc forum: no system audio from getDisplayMedia](https://react-native-webrtc.discourse.group/t/system-audio-not-support-for-screen-sharing-in-ios/2013)
- [GetStream/react-native-webrtc fork](https://github.com/GetStream/react-native-webrtc)
- [GetStream/webrtc-android (replacement for Google's discontinued prebuilt)](https://github.com/GetStream/webrtc-android)
- [io.github.webrtc-sdk:android on Maven Central](https://mvnrepository.com/artifact/io.github.webrtc-sdk/android/versions)
- [socket.io-client-java (2.x client ↔ Socket.IO v3/v4 server)](https://github.com/socketio/socket.io-client-java)
- [scrcpy audio forwarding (Android 11+)](https://github.com/Genymobile/scrcpy/blob/master/doc/audio.md)
- [scrcpy](https://github.com/Genymobile/scrcpy)
- [Android Authority: sideloading developer-verification rollout](https://androidauthority.com/android-sideloading-developer-verification-first-wave-rollout-3717921)
- [Gigazine: developer-verification timeline](https://gigazine.net/gsc_news/en/20260619-android-developer-verification-timeline/)
- [caniuse: getDisplayMedia](https://caniuse.com/mdn-api_mediadevices_getdisplaymedia)
