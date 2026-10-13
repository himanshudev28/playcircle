"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { getSocket, type RoomUser } from "@/lib/socket";
import { Avatar } from "./CallPanel";

export function PeoplePanel({
  users,
  selfId,
  selfBrowser,
  hostId,
  locked,
}: {
  users: RoomUser[];
  selfId: string | null;
  selfBrowser: string | null;
  hostId: string | null;
  locked: boolean;
}) {
  const isHost = !!selfId && selfId === hostId;
  // Host first, then you, then everyone else in join order.
  const sorted = [...users].sort(
    (a, b) =>
      Number(b.id === hostId) - Number(a.id === hostId) ||
      Number(b.id === selfId) - Number(a.id === selfId)
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ul className="flex-1 space-y-1 overflow-y-auto px-2 py-2">
        {sorted.map((u) => (
          <PersonRow
            key={u.id}
            user={u}
            isSelf={u.id === selfId}
            isOwnTab={u.id !== selfId && u.browser === selfBrowser}
            isHost={u.id === hostId}
            // Your other tabs are still you: removing one would remove you.
            canManage={isHost && u.browser !== selfBrowser}
          />
        ))}
        {!hostId && (
          <li className="px-2 pt-2 text-xs text-faint">
            The host dropped off — waiting a moment for them to reconnect.
          </li>
        )}
      </ul>

      {isHost && <HostControls locked={locked} />}
    </div>
  );
}

function PersonRow({
  user,
  isSelf,
  isOwnTab,
  isHost,
  canManage,
}: {
  user: RoomUser;
  isSelf: boolean;
  isOwnTab: boolean;
  isHost: boolean;
  canManage: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [confirmKick, setConfirmKick] = useState(false);
  const ref = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
        setConfirmKick(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function act(event: string) {
    getSocket().emit(event, { targetId: user.id });
    setOpen(false);
    setConfirmKick(false);
  }

  return (
    <li
      ref={ref}
      className="relative flex items-center gap-3 rounded-card px-2 py-2 transition hover:bg-bone/4"
    >
      <Avatar user={user} size={32} ring="border-film" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-sm font-medium">
          <span className="truncate">{user.name}</span>
          {isSelf && <span className="text-smoke">(you)</span>}
          {isOwnTab && <span className="text-smoke">(you, other tab)</span>}
          {isHost && (
            <span className="flex items-center gap-1 rounded-full bg-tungsten/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-tungsten">
              <Icon name="crown" size={10} />
              Host
            </span>
          )}
        </p>
        {user.call && (
          <p className="mt-0.5 flex items-center gap-1 text-xs text-smoke">
            <Icon
              name={user.call.mic ? "mic" : "micOff"}
              size={12}
              className={user.call.mic ? "" : "text-signal-hot"}
            />
            <Icon name={user.call.cam ? "video" : "videoOff"} size={12} />
            In call
          </p>
        )}
      </div>

      {canManage && (
        <button
          onClick={() => setOpen((o) => !o)}
          aria-label={`Manage ${user.name}`}
          aria-expanded={open}
          className="grid h-8 w-8 place-items-center rounded-full text-smoke transition hover:bg-bone/8 hover:text-bone"
        >
          <Icon name="more" size={18} />
        </button>
      )}

      {open && (
        <div
          role="menu"
          className="absolute right-2 top-11 z-20 w-52 overflow-hidden rounded-card border border-edge-strong bg-film-2 py-1 shadow-2xl"
        >
          <MenuItem icon="crown" onClick={() => act("host:transfer")}>
            Make host
          </MenuItem>
          {user.call?.mic && (
            <MenuItem icon="micOff" onClick={() => act("host:mute")}>
              Mute in call
            </MenuItem>
          )}
          {confirmKick ? (
            <MenuItem icon="userMinus" danger onClick={() => act("host:kick")}>
              Yes, remove them
            </MenuItem>
          ) : (
            <MenuItem icon="userMinus" danger onClick={() => setConfirmKick(true)}>
              Remove from room
            </MenuItem>
          )}
        </div>
      )}
    </li>
  );
}

function MenuItem({
  icon,
  danger = false,
  onClick,
  children,
}: {
  icon: "crown" | "micOff" | "userMinus";
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition hover:bg-bone/6 ${
        danger ? "text-signal-hot" : ""
      }`}
    >
      <Icon name={icon} size={15} className="shrink-0" />
      <span className="truncate">{children}</span>
    </button>
  );
}

function HostControls({ locked }: { locked: boolean }) {
  const [confirmEnd, setConfirmEnd] = useState(false);

  useEffect(() => {
    if (!confirmEnd) return;
    const t = setTimeout(() => setConfirmEnd(false), 4000);
    return () => clearTimeout(t);
  }, [confirmEnd]);

  return (
    <div className="space-y-3 border-t border-edge p-3">
      <p className="data px-1 text-dim">Host controls</p>

      <button
        role="switch"
        aria-checked={locked}
        onClick={() => getSocket().emit("host:lock", { locked: !locked })}
        className="flex w-full items-center gap-3 rounded-card px-1 text-left"
      >
        <Icon name="lock" size={17} className="shrink-0 text-smoke" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">Lock room</span>
          <span className="block text-xs text-smoke">
            Only people already here can get back in.
          </span>
        </span>
        <span
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            locked ? "bg-signal" : "bg-film-3"
          }`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-bone transition-transform ${
              locked ? "translate-x-4.5" : "translate-x-0.5"
            }`}
          />
        </span>
      </button>

      <button
        onClick={() =>
          confirmEnd ? getSocket().emit("host:end") : setConfirmEnd(true)
        }
        className={`flex w-full items-center justify-center gap-2 rounded-card border px-4 py-2.5 text-sm font-semibold transition active:scale-[0.98] ${
          confirmEnd
            ? "border-signal bg-signal text-white hover:bg-signal-hot"
            : "border-signal/40 text-signal-hot hover:bg-signal/10"
        }`}
      >
        <Icon name="power" size={16} />
        {confirmEnd ? "Tap again to end for everyone" : "End room for everyone"}
      </button>
    </div>
  );
}
