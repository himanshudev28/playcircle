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
- **Sound** (`AppAudioCapture`) uses Android's playback capture on the same
  screen-capture permission. It's fed into WebRTC through the audio record
  hook in LiveKit's WebRTC build (`io.github.webrtc-sdk:android`), which
  replaces the microphone buffer (or mixes into it) just before encoding.
- **TURN relay.** The page passes the server's `/api/ice` list (STUN plus the
  ExpressTURN relay) to the app, so connections work across different
  networks and mobile data.

## Install on your phone

You need Android 8 or newer. Sharing the whole screen with sound needs Android
10+.

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
2. **Share → Entire screen**, then tap **Start** in Android's dialog. The
   first time, also allow notifications (the Stop button) and the microphone
   (for sound).
3. Switch to any app. Everyone in the room sees your screen.
4. Stop from the room page, the notification, or Android's status-bar chip.
   Locking the phone also stops it on Android 15+.

**Sound:** other apps' sound (gallery videos, games, music) is shared too,
on Android 10+, once you allow the microphone permission. Android files
capturing other apps' audio under it, so the green mic dot shows while
sharing. Only the app sound is sent. Turn on **My voice** on the room page
to mix in your microphone. Calls and notification sounds are never captured.
Sound plays through the phone's own speaker, so a muted phone sends
silence.

Netflix, banking apps and other protected apps show black and stay silent.
That's Android's rule and can't be changed.

## Calls in the app

Calls are the website's, so they work the same on PC and phone. On top:

- **Flip camera:** the ↻ button next to the camera switches front ↔ back
  without dropping the call (shown when the phone has two cameras).
- **Floating call:** the picture-in-picture button floats everyone's camera
  over the room — drag it to any corner, shrink it to a pill, or bring it
  back. In full screen the call floats on top of the video by itself.
- **Pop-up (cameras only):** while you're in a call, leaving the app (home
  button or gesture) shrinks PlayCircle into Android's picture-in-picture
  window showing just the cameras. Tap it to come back. If it doesn't
  appear: Settings → Apps → PlayCircle → Picture-in-picture → Allow.
  It also works while you share your screen, so the call keeps its camera
  and sound while you're in another app — viewers see the small camera
  window in your share.
- **No echo:** while you're in a call, your voice goes out through the call
  only — the screen share's **My voice** switch reads "via the call" and
  stays off, so nobody hears you twice. The share's microphone runs Android's
  echo canceller. On speaker the mic can still hear the phone's own sound;
  headphones remove that completely.

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
