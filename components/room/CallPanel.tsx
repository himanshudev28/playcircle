"use client";

import { useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import type { RoomUser } from "@/lib/socket";
import {
  isAndroidApp,
  setPipPreference,
  useAndroidPip,
  useAndroidPipClosed,
  useCallPip,
  usePipFlip,
  usePipPreference,
} from "@/lib/nativePip";
import { CallFloat, CallPip, useFullscreenHost, useSystemPip } from "./CallFloat";
import { Avatar, CallAudio, Tile } from "./CallTile";
import type { CallApi } from "./useCall";

export { Avatar };

/* The call bar under the player. In a call it shows everyone's tiles, or —
   popped out, in full screen, or in the Android app's picture-in-picture
   window — hands them to the floating call window (CallFloat). Sound never
   moves: CallAudio plays every voice from here, whichever view is up. */

export function CallPanel({
  call,
  users,
  selfId,
  canCall,
}: {
  call: CallApi;
  users: RoomUser[];
  selfId: string | null;
  canCall: boolean;
}) {
  const callers = users.filter((u) => u.call);
  const others = callers.filter((u) => u.id !== selfId);
  const self = users.find((u) => u.id === selfId);
  const [popped, setPopped] = useState(false);
  const host = useFullscreenHost();
  const androidPip = useAndroidPip();
  const pipPref = usePipPreference();
  useCallPip(call.inCall && pipPref);
  usePipFlip(call.inCall && call.cam && call.canFlip, call.flipCam);
  useAndroidPipClosed(call.leave);
  // Lives here, not in the floating window: the pop-out must outlast it
  // (leaving full screen — which switching tabs does — unmounts the window).
  const pip = useSystemPip(call, users, selfId);

  if (!call.inCall) {
    return (
      <div className="flex flex-col gap-3 rounded-panel border border-edge bg-film p-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3 px-1">
          {callers.length > 0 ? (
            <div className="flex -space-x-2">
              {callers.slice(0, 4).map((u) => (
                <Avatar key={u.id} user={u} size={30} ring="border-film" />
              ))}
            </div>
          ) : (
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-edge bg-ink text-dim">
              <Icon name="headphones" size={17} />
            </span>
          )}
          <div className="min-w-0">
            <p className="text-sm font-semibold">
              {callers.length > 0
                ? `${callers.length} in the call`
                : "Voice & video"}
            </p>
            <p className="truncate text-xs text-smoke">
              {!canCall
                ? "The host turned off calls for you."
                : callers.length > 0
                ? callers.map((u) => u.name).join(", ")
                : "Talk face-to-face or voice-only while you watch."}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => call.join(false)}
            disabled={call.joining || !canCall}
            className="flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-card border border-edge bg-bone/5 px-4 py-2.5 text-sm font-medium transition hover:bg-bone/10 disabled:opacity-50 sm:flex-none"
          >
            <Icon name="mic" size={16} />
            Join voice
          </button>
          <button
            onClick={() => call.join(true)}
            disabled={call.joining || !canCall}
            className="flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-card bg-signal px-4 py-2.5 text-sm font-semibold transition hover:bg-signal-hot active:scale-95 disabled:opacity-50 sm:flex-none"
          >
            <Icon name="video" size={16} />
            {call.joining ? "Connecting…" : "Join with video"}
          </button>
        </div>
      </div>
    );
  }

  // Full screen always floats: it hides everything outside it.
  const floating = popped || !!host;

  return (
    <div className="rounded-panel border border-edge bg-film p-3">
      <CallAudio streams={call.remoteStreams} />
      {androidPip ? (
        <CallPip call={call} users={users} selfId={selfId} />
      ) : (
        floating && (
          <CallFloat
            call={call}
            users={users}
            selfId={selfId}
            host={host}
            pip={pip}
            onDock={() => setPopped(false)}
          />
        )
      )}

      {floating ? (
        <button
          type="button"
          onClick={() => setPopped(false)}
          className="flex w-full items-center gap-3 rounded-card border border-dashed border-edge px-3 py-2.5 text-left text-sm text-smoke transition hover:bg-bone/5"
        >
          <span className="flex -space-x-2">
            {callers.slice(0, 4).map((u) => (
              <Avatar key={u.id} user={u} size={24} ring="border-film" />
            ))}
          </span>
          <span className="min-w-0 flex-1 truncate">
            Call is in the floating window
          </span>
          <span className="shrink-0 text-xs font-semibold text-bone">Bring back</span>
        </button>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
          {self && (
            <Tile
              user={self}
              stream={call.localStream}
              mic={call.mic}
              cam={call.cam}
              isSelf
              mirror={call.facing === "user"}
            />
          )}
          {others.map((u) => (
            <Tile
              key={u.id}
              user={u}
              stream={call.remoteStreams[u.id] || null}
              mic={!!u.call?.mic}
              cam={!!u.call?.cam}
            />
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="min-w-0 px-1">
          <p className="text-xs text-smoke">
            {others.length === 0
              ? "You're the only one here — others can join from their call bar."
              : `${callers.length} in the call`}
          </p>
          {isAndroidApp() && (
            <button
              type="button"
              role="switch"
              aria-checked={pipPref}
              onClick={() => setPipPreference(!pipPref)}
              className="mt-1.5 flex items-center gap-2 text-xs text-smoke transition hover:text-bone"
            >
              <span
                className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${
                  pipPref ? "bg-signal" : "bg-bone/20"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-3 w-3 rounded-full bg-bone transition-[left] ${
                    pipPref ? "left-[0.875rem]" : "left-0.5"
                  }`}
                />
              </span>
              Pop-up when I leave the app
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <ControlButton
            onClick={call.toggleMic}
            icon={call.mic ? "mic" : "micOff"}
            label={call.mic ? "Mute" : "Unmute"}
            off={!call.mic}
          />
          <ControlButton
            onClick={call.toggleCam}
            icon={call.cam ? "video" : "videoOff"}
            label={call.cam ? "Turn camera off" : "Turn camera on"}
            off={!call.cam}
          />
          {call.cam && call.canFlip && (
            <ControlButton
              onClick={call.flipCam}
              icon="flip"
              label={
                call.facing === "user" ? "Switch to back camera" : "Switch to front camera"
              }
              off={false}
              toggle={false}
            />
          )}
          {!floating && (
            <ControlButton
              onClick={() => setPopped(true)}
              icon="pip"
              label="Float the call over the video"
              off={false}
              toggle={false}
            />
          )}
          <button
            onClick={call.leave}
            title="Leave call"
            aria-label="Leave call"
            className="grid h-10 w-14 place-items-center rounded-card bg-signal transition hover:bg-signal-hot active:scale-95"
          >
            <Icon name="phoneOff" size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

function ControlButton({
  onClick,
  icon,
  label,
  off,
  toggle = true,
}: {
  onClick: () => void;
  icon: IconName;
  label: string;
  off: boolean;
  /** An on/off switch (mic, camera) rather than a one-shot action. */
  toggle?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={toggle ? !off : undefined}
      className={`grid h-10 w-10 place-items-center rounded-card border transition active:scale-95 ${
        off
          ? "border-signal/40 bg-signal/15 text-signal-hot hover:bg-signal/25"
          : "border-edge bg-bone/5 hover:bg-bone/10"
      }`}
    >
      <Icon name={icon} size={18} />
    </button>
  );
}
