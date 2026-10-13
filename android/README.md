# PlayCircle for Android

The Android app is the PlayCircle website in an app, plus the one thing phone
browsers can't do: **share your whole phone screen** to a room. PC and phone
users join the same rooms and see the same things.

## How it works

- **Everything except screen sharing is the website.** `MainActivity` opens
  the site in a WebView, so rooms, sync, chat, queue, polls, reactions,
  calls, host controls, and camera and file sharing behave exactly as they do
  on the web. A website update reaches the app without reinstalling.
- **Screen sharing is native.** In a room, **Share → Entire screen** calls
  `window.PlayCircleAndroid` (`WebBridge`). The app then:
  1. asks Android for permission to capture the screen,
  2. starts `ScreenShareService`, a foreground service with a notification
     that has a Stop button,
  3. runs `StagePresenter`, which connects to the room a second time as a
     hidden **companion** connection with the same identity, so it has the
     same rights. It claims the stage with `stage:start` and streams the
     screen to every viewer over WebRTC, using the same `stage:*` protocol as
     the web presenter in `components/room/useLiveStage.ts`.

  Viewers on PC or phone see an ordinary live share. Nothing changes for them.
- **TURN relay.** The page passes the server's `/api/ice` list (STUN plus the
  ExpressTURN relay) to the app, so connections work across different
  networks and mobile data.

## Install on your phone

You need Android 8 or newer. Sharing the whole screen needs Android 10+, and
14+ adds the "single app / entire screen" choice.

**Option A: copy the APK.** Copy
`app/build/outputs/apk/release/app-release.apk` to the phone (Drive,
WhatsApp, USB), open it and allow "Install unknown apps" when asked.

**Option B: over USB.** Turn on USB debugging on the phone, plug it in, then:

```bash
~/Library/Android/sdk/platform-tools/adb install -r app/build/outputs/apk/release/app-release.apk
```

After installing:

- Set the app's battery use to **Unrestricted** (Settings → Apps →
  PlayCircle → Battery). Some brands (Xiaomi, Samsung, Oppo, Vivo) otherwise
  kill sharing in the background.
- The first open can take up to a minute while the free Render server wakes
  up.

## Using screen sharing

1. Open a room in the app. You need video control: the host, the room
   creator, or "Everyone can control" playback.
2. **Share → Entire screen**, then tap **Start now** in Android's dialog. On
   Android 14+, pick **Entire screen**.
3. Switch to any app. Everyone in the room sees your screen.
4. Stop from the room page, the notification, or Android's status-bar chip.
   Locking the phone also stops it on Android 15+.

Netflix, banking apps and other protected apps show black. That's Android's
rule and can't be changed. Sound isn't shared yet; use a call in the room to
talk.

## Build it yourself

You need Android Studio (for the SDK and JDK 21).

```bash
cd android
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew assembleRelease          # → app/build/outputs/apk/release/app-release.apk
./gradlew assembleDebug            # debug build: chrome://inspect works, http:// allowed
```

The server the app opens is `playcircleServer` in `gradle.properties`.
Override it per build with `-PplaycircleServer=https://…`. If that server
can't be reached, the app shows **Change server**. The address is saved on the
phone.

The release build is signed with your local debug key. That's fine for
installing on your own phones, but an update must be signed by the same
computer, or you have to uninstall first.
