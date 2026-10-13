"use client";

import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { useInNativeApp } from "@/lib/nativeApp";
import type { ShareSource } from "@/lib/socket";
import { isMobileDevice, type LiveStageApi } from "./useLiveStage";

/* "Share" button + menu: a browser tab, the whole screen, a camera, or a
   video file from this device. While you're presenting it becomes "Stop
   sharing". Phones can't capture their screen from a browser at all, so
   there the camera and file come first — except in the Android app, which
   shares the whole phone screen itself. */

export function ShareMenu({
  api,
  canShare,
  inCall,
}: {
  api: LiveStageApi;
  canShare: boolean;
  /** In a call your voice already reaches everyone: the camera goes silent. */
  inCall: boolean;
}) {
  const [open, setOpen] = useState(false);
  const inApp = useInNativeApp();
  const boxRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (api.isPresenter) {
    const starting = api.status === "starting";
    return (
      <button
        type="button"
        onClick={api.stopShare}
        className="flex items-center gap-2 whitespace-nowrap rounded-card bg-signal px-4 py-2.5 text-sm font-semibold transition hover:bg-signal-hot active:scale-95"
      >
        <svg width={12} height={12} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <rect x="5" y="5" width="14" height="14" rx="2.5" />
        </svg>
        {starting ? "Cancel share" : "Stop sharing"}
      </button>
    );
  }

  if (!canShare) return null;

  // Only rendered after a click, so reading navigator here can't cause a
  // hydration mismatch.
  const mobile = isMobileDevice();
  const reason = (source: ShareSource): string | null => {
    if (api.supported[source]) return null;
    if (source === "camera") return "This browser can't use a camera";
    if (source === "file") return "This browser can't stream files";
    if (inApp) return "Use “Entire screen” — it covers every app";
    return mobile
      ? "Phone browsers can't — use the PlayCircle Android app"
      : "Your browser can't share screens";
  };

  // Called straight from the click: getDisplayMedia needs that gesture.
  function pick(source: "tab" | "screen" | "camera") {
    setOpen(false);
    api.startShare(source, undefined, { withAudio: !inCall }).catch(() => {});
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // picking the same file again still fires change
    if (file) api.startShare("file", file).catch(() => {});
  }

  const screenItems = (
    <>
      <Item
        icon={<Icon name="globe" size={17} />}
        title="Browser tab (with audio)"
        hint="Best for video sites — sound included"
        disabledReason={reason("tab")}
        onClick={() => pick("tab")}
      />
      <Item
        icon={<Icon name="monitor" size={17} />}
        title="Entire screen"
        hint={inApp ? "Your whole phone screen — open any app" : "Everything on one display"}
        disabledReason={reason("screen")}
        onClick={() => pick("screen")}
      />
    </>
  );
  const fileItem = (
    <Item
      icon={<Icon name="film" size={17} />}
      title="Video file from this device"
      hint={mobile ? "From your gallery — streams to everyone" : "Plays here, streams to everyone"}
      disabledReason={reason("file")}
      onClick={() => {
        setOpen(false);
        // Inside the tap: Safari only starts audio from a gesture.
        api.primeFileShare();
        fileRef.current?.click();
      }}
    />
  );
  const cameraItem = (
    <Item
      icon={<Icon name="video" size={17} />}
      title="Camera"
      hint={
        inCall
          ? "Live on the stage — your call carries the sound"
          : mobile
            ? "Front or back camera, live on the stage"
            : "Your webcam, live on the stage"
      }
      disabledReason={reason("camera")}
      onClick={() => pick("camera")}
    />
  );

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 whitespace-nowrap rounded-card border border-edge bg-bone/5 px-4 py-2.5 text-sm font-medium transition hover:bg-bone/10"
      >
        <Icon name="broadcast" size={16} />
        Share
        <Icon name="chevronDown" size={14} className="text-smoke" />
      </button>

      <input
        ref={fileRef}
        type="file"
        accept="video/*"
        className="hidden"
        tabIndex={-1}
        onChange={onFile}
      />

      {open && (
        <div
          role="menu"
          aria-label="Share to the room"
          // Phones: a bottom sheet — the button can sit anywhere in the
          // wrapped toolbar, so an anchored popover would run off-screen.
          className="fixed inset-x-3 bottom-3 z-50 overflow-hidden rounded-card border border-edge bg-film-2 p-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] shadow-2xl sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:z-40 sm:mt-2 sm:w-72 sm:pb-1.5"
        >
          {inApp ? (
            <>
              {screenItems}
              {fileItem}
              {cameraItem}
            </>
          ) : mobile ? (
            <>
              {fileItem}
              {cameraItem}
              {screenItems}
            </>
          ) : (
            <>
              {screenItems}
              {fileItem}
              {cameraItem}
            </>
          )}
          <p className="mt-1 border-t border-edge px-3 pb-1.5 pt-2.5 text-[11px] leading-snug text-dim">
            {inApp
              ? "Screen sharing keeps going in other apps. Netflix and banking apps show black."
              : mobile
                ? "Keep this tab open while you share — switching apps pauses it."
                : "Copy-protected sites (Netflix etc.) show black."}
          </p>
        </div>
      )}
    </div>
  );
}

function Item({
  icon,
  title,
  hint,
  disabledReason,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  disabledReason: string | null;
  onClick: () => void;
}) {
  const disabled = !!disabledReason;
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled}
      className="flex w-full items-start gap-3 rounded-[0.9rem] px-3 py-2.5 text-left transition hover:bg-bone/5 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full border border-edge bg-ink text-smoke">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-smoke">{disabledReason ?? hint}</span>
      </span>
    </button>
  );
}
