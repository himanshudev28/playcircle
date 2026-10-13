"use client";

import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import {
  getSocket,
  type Reply,
  type Perms,
  type RoomSettings,
  type RoomUser,
} from "@/lib/socket";
import { Avatar } from "./CallPanel";

/* Who can do what:
   - The creator ("owner") has permanent first right. Whenever they're here
     they hold the crown, and nobody else can act on them.
   - The host is whoever holds the crown now. Owner and host are both admins:
     they can hand over the crown, set per-person permissions, mute, remove.
   - Room-wide switches (video mode, lock, end) belong to the owner, or to the
     host standing in while the owner is away. The server enforces all of it;
     this panel only decides what to show. */

export function PeoplePanel({
  users,
  selfId,
  selfBrowser,
  hostId,
  settings,
  selfIsAdmin,
}: {
  users: RoomUser[];
  selfId: string | null;
  selfBrowser: string | null;
  hostId: string | null;
  settings: RoomSettings;
  selfIsAdmin: boolean;
}) {
  const self = users.find((u) => u.id === selfId);
  const selfIsOwner = !!self?.owner;
  const ownerHere = users.some((u) => u.owner);
  const canRunRoom = selfIsOwner || (selfId === hostId && !ownerHere);

  // Creator first, then the host, then you, then everyone else in join order.
  const rank = (u: RoomUser) =>
    (u.owner ? 4 : 0) + (u.id === hostId ? 2 : 0) + (u.id === selfId ? 1 : 0);
  const sorted = [...users].sort((a, b) => rank(b) - rank(a));

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
            // Your other tabs are still you, and only the creator may touch
            // the creator.
            canManage={selfIsAdmin && u.browser !== selfBrowser && !u.owner}
            canTakeBack={u.id === selfId && selfIsOwner && hostId !== selfId}
          />
        ))}
        {!hostId && (
          <li className="px-2 pt-2 text-xs text-faint">
            The host dropped off — waiting a moment for them to reconnect.
          </li>
        )}
      </ul>

      {canRunRoom ? (
        <HostControls settings={settings} />
      ) : (
        selfIsAdmin && (
          <p className="border-t border-edge px-4 py-3 text-xs text-smoke">
            You&apos;re hosting. Room settings stay with the room&apos;s creator.
          </p>
        )
      )}
    </div>
  );
}

function PersonRow({
  user,
  isSelf,
  isOwnTab,
  isHost,
  canManage,
  canTakeBack,
}: {
  user: RoomUser;
  isSelf: boolean;
  isOwnTab: boolean;
  isHost: boolean;
  canManage: boolean;
  canTakeBack: boolean;
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

  function setPerm(perm: keyof Perms, value: boolean) {
    getSocket().emit("host:perm", { targetId: user.id, perm, value });
  }

  // Admins already have every permission, so only show limits for others.
  const limits: { icon: IconName; label: string; tone: string }[] = [];
  if (!user.owner && !isHost) {
    if (user.perms.video) {
      limits.push({ icon: "play", label: "Controls video", tone: "text-emerald-400" });
    }
    if (!user.perms.chat) {
      limits.push({ icon: "message", label: "Chat off", tone: "text-signal-hot" });
    }
    if (!user.perms.call) {
      limits.push({ icon: "headphones", label: "Calls off", tone: "text-signal-hot" });
    }
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
          {user.owner && <Badge tone="tungsten">Creator</Badge>}
          {isHost && !user.owner && <Badge tone="bone">Host</Badge>}
        </p>
        {(user.call || limits.length > 0) && (
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-smoke">
            {user.call && (
              <span className="flex items-center gap-1">
                <Icon
                  name={user.call.mic ? "mic" : "micOff"}
                  size={12}
                  className={user.call.mic ? "" : "text-signal-hot"}
                />
                <Icon name={user.call.cam ? "video" : "videoOff"} size={12} />
                In call
              </span>
            )}
            {limits.map((l) => (
              <span key={l.label} className={`flex items-center gap-1 ${l.tone}`}>
                <Icon name={l.icon} size={11} />
                {l.label}
              </span>
            ))}
          </p>
        )}
        {canTakeBack && (
          <button
            onClick={() => getSocket().emit("host:reclaim")}
            className="mt-1.5 flex items-center gap-1.5 rounded-full border border-tungsten/40 px-2.5 py-1 text-xs font-semibold text-tungsten transition hover:bg-tungsten/10"
          >
            <Icon name="crown" size={11} />
            Take back host
          </button>
        )}
      </div>

      {canManage && (
        <button
          onClick={() => setOpen((o) => !o)}
          aria-label={`Manage ${user.name}`}
          aria-expanded={open}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-smoke transition hover:bg-bone/8 hover:text-bone"
        >
          <Icon name="more" size={18} />
        </button>
      )}

      {open && (
        <div
          role="menu"
          className="absolute right-2 top-11 z-20 w-60 overflow-hidden rounded-card border border-edge-strong bg-film-2 py-1 shadow-2xl"
        >
          {!isHost && (
            <>
              <p className="data px-3 pb-1 pt-2 text-dim">Allow</p>
              <ToggleItem
                icon="play"
                checked={user.perms.video}
                onChange={(v) => setPerm("video", v)}
              >
                Control the video
              </ToggleItem>
              <ToggleItem
                icon="message"
                checked={user.perms.chat}
                onChange={(v) => setPerm("chat", v)}
              >
                Chat
              </ToggleItem>
              <ToggleItem
                icon="headphones"
                checked={user.perms.call}
                onChange={(v) => setPerm("call", v)}
              >
                Join the call
              </ToggleItem>
              <div className="my-1 h-px bg-edge" />
              <MenuItem icon="crown" onClick={() => act("host:transfer")}>
                Make host
              </MenuItem>
            </>
          )}
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

function Badge({
  tone,
  children,
}: {
  tone: "tungsten" | "bone";
  children: React.ReactNode;
}) {
  const cls =
    tone === "tungsten" ? "bg-tungsten/15 text-tungsten" : "bg-bone/10 text-bone";
  return (
    <span
      className={`flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}
    >
      <Icon name="crown" size={10} />
      {children}
    </span>
  );
}

function MenuItem({
  icon,
  danger = false,
  onClick,
  children,
}: {
  icon: IconName;
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

function ToggleItem({
  icon,
  checked,
  onChange,
  children,
}: {
  icon: IconName;
  checked: boolean;
  onChange: (next: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition hover:bg-bone/6"
    >
      <Icon name={icon} size={15} className="shrink-0 text-smoke" />
      <span className="flex-1 truncate">{children}</span>
      <Switch on={checked} />
    </button>
  );
}

function Switch({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
        on ? "bg-signal" : "bg-film-3"
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-bone transition-transform ${
          on ? "translate-x-4.5" : "translate-x-0.5"
        }`}
      />
    </span>
  );
}

function HostControls({ settings }: { settings: RoomSettings }) {
  const [confirmEnd, setConfirmEnd] = useState(false);

  useEffect(() => {
    if (!confirmEnd) return;
    const t = setTimeout(() => setConfirmEnd(false), 4000);
    return () => clearTimeout(t);
  }, [confirmEnd]);

  const everyone = settings.playback === "everyone";

  return (
    <div className="space-y-3 border-t border-edge p-3">
      <p className="data px-1 text-dim">Room controls</p>

      <SettingRow
        icon="play"
        title="Everyone controls the video"
        body={
          everyone
            ? "Anyone can play, pause, skip or change it."
            : "Only the host and people you allow can."
        }
        on={everyone}
        onToggle={() =>
          getSocket().emit("host:playback", {
            mode: everyone ? "host" : "everyone",
          })
        }
      />

      <SettingRow
        icon="lock"
        title="Lock room"
        body="Only people already here can get back in."
        on={settings.locked}
        onToggle={() =>
          getSocket().emit("host:lock", { locked: !settings.locked })
        }
      />

      <PasswordRow hasPassword={settings.hasPassword} />

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

const PASSWORD_MIN = 4;
const PASSWORD_MAX = 64;
const ACK_TIMEOUT = 8000;

/* Room password: new people need it to get in; anyone already admitted
   never does. The server hashes it — we only ever learn whether one is set. */
function PasswordRow({ hasPassword }: { hasPassword: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // `done` runs only when the server accepted the change.
  function send(password: string | null, done?: () => void) {
    if (busy) return;
    setBusy(true);
    getSocket()
      .timeout(ACK_TIMEOUT)
      .emit("host:password", { password }, (err: Error | null, res?: Reply) => {
        setBusy(false);
        if (err || !res) return setError("Couldn't reach the room — try again");
        if (!res.ok) return setError(res.error || "Couldn't change the password");
        setError(null);
        done?.();
      });
  }

  function save() {
    const pw = value;
    if (pw.length < PASSWORD_MIN || pw.length > PASSWORD_MAX) {
      setError(`Use ${PASSWORD_MIN}–${PASSWORD_MAX} characters.`);
      return;
    }
    send(pw, () => {
      setValue("");
      setEditing(false);
    });
  }

  function cancel() {
    setValue("");
    setError(null);
    setEditing(false);
  }

  return (
    <div className="rounded-card px-1">
      <div className="flex items-center gap-3">
        <Icon name="lock" size={17} className="shrink-0 text-smoke" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-medium">
            Room password
            <span
              className={`rounded-full px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${
                hasPassword
                  ? "bg-emerald-400/15 text-emerald-400"
                  : "bg-bone/8 text-smoke"
              }`}
            >
              {hasPassword ? "On" : "Off"}
            </span>
          </span>
          <span className="block text-xs text-smoke">
            {hasPassword
              ? "New people need it to join. People already here don't."
              : "Anyone with the link can join."}
          </span>
        </span>
        {!editing && (
          <div className="flex shrink-0 gap-1.5">
            <button
              onClick={() => {
                setError(null);
                setEditing(true);
              }}
              className="rounded-full border border-edge bg-bone/5 px-2.5 py-1 text-xs font-semibold transition hover:bg-bone/10"
            >
              {hasPassword ? "Change" : "Set"}
            </button>
            {hasPassword && (
              <button
                onClick={() => send(null)}
                disabled={busy}
                className="rounded-full border border-signal/40 px-2.5 py-1 text-xs font-semibold text-signal-hot transition hover:bg-signal/10"
              >
                Remove
              </button>
            )}
          </div>
        )}
      </div>
      {editing && (
        <form
          className="mt-2 flex gap-1.5 pl-[29px]"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <input
            type="password"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => e.key === "Escape" && cancel()}
            autoFocus
            autoComplete="new-password"
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
            aria-label="New room password"
            aria-invalid={!!error}
            placeholder={`${PASSWORD_MIN}–${PASSWORD_MAX} characters`}
            className="w-full min-w-0 rounded-card border border-edge bg-ink px-3 py-1.5 text-sm outline-none transition focus:border-signal/60"
          />
          <button
            type="submit"
            disabled={value.length === 0 || busy}
            className="rounded-card bg-signal px-3 py-1.5 text-xs font-semibold transition hover:bg-signal-hot active:scale-95 disabled:pointer-events-none disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={cancel}
            aria-label="Cancel"
            className="grid w-8 shrink-0 place-items-center rounded-card text-smoke transition hover:bg-bone/8 hover:text-bone"
          >
            <Icon name="close" size={14} />
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-1 pl-[29px] text-xs text-signal-hot">
          {error}
        </p>
      )}
    </div>
  );
}

function SettingRow({
  icon,
  title,
  body,
  on,
  onToggle,
}: {
  icon: IconName;
  title: string;
  body: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      className="flex w-full items-center gap-3 rounded-card px-1 text-left"
    >
      <Icon name={icon} size={17} className="shrink-0 text-smoke" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-smoke">{body}</span>
      </span>
      <Switch on={on} />
    </button>
  );
}
