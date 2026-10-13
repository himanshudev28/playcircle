"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  type SVGProps,
} from "react";
import { Icon } from "@/components/Icon";
import { CHAT_REACTIONS, getSocket, type ChatMessage, type Reply } from "@/lib/socket";
import { findTimestamps, formatTime } from "@/lib/timestamps";

/* The room chat.
   RoomClient owns `messages` / `pinned` (chat:message, chat:update,
   chat:removed, chat:pinned). This component only renders them and emits
   actions; the server enforces every permission. */

const ACK_TIMEOUT = 8000;
const MAX_LEN = 500;
const NEAR_BOTTOM_PX = 80;
const GROUP_GAP_MS = 3 * 60_000;

type ChatProps = {
  messages: ChatMessage[];
  pinned: ChatMessage | null;
  selfBrowser: string | null;
  canChat: boolean;
  isAdmin: boolean;
  /** Seconds into the current YouTube video, or null (live share / nothing playing). */
  getVideoTime: () => number | null;
  /** Jump the shared video to t; the parent checks permission and toasts if not allowed. */
  onSeek: (t: number) => void;
  onToast: (msg: string) => void;
  /** Rendered above the message list (the active poll card goes here). */
  header?: ReactNode;
};

type MenuState = {
  id: string;
  kind: "menu" | "react" | "report";
  /** Open upward (row sits near the bottom of the list). */
  up: boolean;
};

/* ---------------------------------------------------------------- */
/* Blocked people — this browser only                                */
/* ---------------------------------------------------------------- */

const BLOCK_KEY = "wnp-blocked";
const blockListeners = new Set<() => void>();
let blockCache: string | null = null;

function readBlockedRaw(): string {
  if (blockCache === null) {
    try {
      blockCache = localStorage.getItem(BLOCK_KEY) || "[]";
    } catch {
      blockCache = "[]";
    }
  }
  return blockCache;
}

function parseBlocked(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function setBlocked(browser: string, block: boolean) {
  const list = parseBlocked(readBlockedRaw()).filter((b) => b !== browser);
  if (block) list.push(browser);
  blockCache = JSON.stringify(list);
  try {
    localStorage.setItem(BLOCK_KEY, blockCache);
  } catch {
    /* storage blocked — still applies for this page */
  }
  blockListeners.forEach((l) => l());
}

function subscribeBlocked(cb: () => void) {
  blockListeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== BLOCK_KEY) return;
    blockCache = null;
    cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    blockListeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

function useBlocked(): Set<string> {
  const raw = useSyncExternalStore(subscribeBlocked, readBlockedRaw, () => "[]");
  return useMemo(() => new Set(parseBlocked(raw)), [raw]);
}

/* ---------------------------------------------------------------- */

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

function snippet(text: string, max = 80) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function clockTime(ts: number) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function Chat({
  messages,
  pinned,
  selfBrowser,
  canChat,
  isAdmin,
  getVideoTime,
  onSeek,
  onToast,
  header,
}: ChatProps) {
  const blocked = useBlocked();
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = searchOpen ? query.trim().toLowerCase() : "";

  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [announce, setAnnounce] = useState(false);
  const [videoTime, setVideoTime] = useState<number | null>(null);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [reportReason, setReportReason] = useState("");
  const [flashId, setFlashId] = useState<string | null>(null);

  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRootRef = useRef<HTMLDivElement>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const handledLastId = useRef<string | null | undefined>(undefined);

  const isMine = (m: ChatMessage) => !!selfBrowser && m.browser === selfBrowser;
  const isHidden = (m: ChatMessage) =>
    !m.system && !!m.browser && blocked.has(m.browser) && !revealed.has(m.id);

  /* ---- new-message tracking ---- */
  const last = messages.length ? messages[messages.length - 1] : null;
  const lastId = last?.id ?? null;
  const lastMine = !!last && isMine(last);

  // Adjust during render (not in an effect) when a new message lands while
  // the reader is scrolled up: that's what shows the "New messages" pill.
  const [prevLastId, setPrevLastId] = useState(lastId);
  if (lastId !== prevLastId) {
    setPrevLastId(lastId);
    if (!atBottom && !lastMine && last && !last.system) setUnseen(true);
  }

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const first = handledLastId.current === undefined;
    const isNew = handledLastId.current !== lastId;
    handledLastId.current = lastId;
    // Stick to the bottom while the reader is there (also keeps reactions
    // growing the last row from hiding it); jump for your own messages.
    if (first || atBottom || (isNew && lastMine)) {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: first || !isNew || prefersReducedMotion() ? "auto" : "smooth",
      });
    }
  }, [messages, lastId, lastMine, atBottom]);

  function onListScroll() {
    const el = listRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    setAtBottom(near);
    if (near) setUnseen(false);
  }

  function scrollToBottom() {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    setUnseen(false);
  }

  /* ---- "Moment" availability: poll the player clock ---- */
  const getTimeRef = useRef(getVideoTime);
  useEffect(() => {
    getTimeRef.current = getVideoTime;
  });
  useEffect(() => {
    const read = () => {
      const t = getTimeRef.current();
      setVideoTime(t === null || !Number.isFinite(t) ? null : Math.floor(t));
    };
    const first = setTimeout(read, 0);
    const id = setInterval(read, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);

  /* ---- menu: Esc / outside click ---- */
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRootRef.current?.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      const trigger = menuRootRef.current?.querySelector<HTMLElement>("[data-menu-trigger]");
      setMenu(null);
      trigger?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // Move focus into whatever popover just opened.
  const menuKey = menu ? `${menu.id}:${menu.kind}` : null;
  useEffect(() => {
    if (!menuKey) return;
    const root = menuRootRef.current;
    const target = root?.querySelector<HTMLElement>(
      "[data-autofocus], [role=menuitem]:not([disabled])"
    );
    target?.focus();
  }, [menuKey]);

  useEffect(() => () => clearTimeout(flashTimer.current), []);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  /* ---- actions ---- */

  function openPopover(id: string, kind: MenuState["kind"], trigger: HTMLElement | null) {
    if (menu && menu.id === id && menu.kind === kind) {
      setMenu(null);
      return;
    }
    let up = menu?.id === id ? menu.up : false;
    const list = listRef.current;
    if (trigger && list && menu?.id !== id) {
      const below = list.getBoundingClientRect().bottom - trigger.getBoundingClientRect().bottom;
      up = below < 260;
    }
    setReportReason("");
    setMenu({ id, kind, up });
  }

  function jumpTo(id: string, retried = false) {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-mid="${CSS.escape(id)}"]`
    );
    if (!el) {
      if (!retried && q && messages.some((m) => m.id === id)) {
        // Hidden by the search filter: clear it, then try again.
        setQuery("");
        setSearchOpen(false);
        setTimeout(() => jumpTo(id, true), 60);
        return;
      }
      onToast("That message isn't loaded anymore");
      return;
    }
    el.scrollIntoView({
      block: "center",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    setFlashId(id);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashId(null), 1600);
  }

  function send() {
    const t = text.trim();
    if (!t || !canChat) return;
    getSocket().emit("chat:message", {
      text: t.slice(0, MAX_LEN),
      ...(replyTo ? { replyTo: replyTo.id } : {}),
      ...(announce && isAdmin ? { announce: true } : {}),
    });
    setText("");
    setReplyTo(null);
    setAnnounce(false);
  }

  function insertMoment() {
    const t = getVideoTime();
    if (t === null || !Number.isFinite(t)) {
      onToast("Nothing with a timeline is playing");
      return;
    }
    const stamp = formatTime(t);
    const el = inputRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? start;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const lead = before && !/\s$/.test(before) ? " " : "";
    const trail = !after || !/^\s/.test(after) ? " " : "";
    const next = `${before}${lead}${stamp}${trail}${after}`;
    if (next.length > MAX_LEN) {
      onToast("Message is too long to add a moment");
      return;
    }
    const caret = before.length + lead.length + stamp.length + trail.length;
    setText(next);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(caret, caret);
    });
  }

  function startReply(m: ChatMessage) {
    setReplyTo(m);
    setMenu(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function react(m: ChatMessage, emoji: string) {
    getSocket().emit("chat:react", { id: m.id, emoji });
  }

  function copy(m: ChatMessage) {
    setMenu(null);
    const done = () => onToast("Copied");
    const fail = () => onToast("Couldn't copy that");
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(m.text).then(done, fail);
      } else {
        fail();
      }
    } catch {
      fail();
    }
  }

  function togglePin(m: ChatMessage) {
    setMenu(null);
    getSocket().emit("chat:pin", { id: pinned?.id === m.id ? null : m.id });
  }

  function remove(m: ChatMessage) {
    setMenu(null);
    getSocket().emit("chat:delete", { id: m.id });
  }

  function report(m: ChatMessage) {
    const reason = reportReason.trim().slice(0, 200);
    setMenu(null);
    getSocket()
      .timeout(ACK_TIMEOUT)
      .emit(
        "chat:report",
        { id: m.id, ...(reason ? { reason } : {}) },
        (err: Error | null, res?: Reply) => {
          if (err || !res) return onToast("Couldn't reach the room — try again");
          onToast(res.ok ? "Reported to the host" : res.error || "Couldn't report that");
        }
      );
  }

  function toggleBlock(m: ChatMessage) {
    setMenu(null);
    if (!m.browser) return;
    const nowBlocked = !blocked.has(m.browser);
    setBlocked(m.browser, nowBlocked);
    onToast(
      nowBlocked
        ? `Blocked ${m.name || "them"} — only you stop seeing their messages`
        : `Unblocked ${m.name || "them"}`
    );
  }

  function reveal(id: string) {
    setRevealed((s) => new Set(s).add(id));
  }

  function closeSearch() {
    setQuery("");
    setSearchOpen(false);
  }

  /* ---- what to show ---- */

  const shown = useMemo(() => {
    if (!q) return messages;
    return messages.filter((m) => {
      if (!m.system && m.browser && blocked.has(m.browser) && !revealed.has(m.id)) {
        return false;
      }
      return (
        m.text.toLowerCase().includes(q) ||
        (!!m.name && m.name.toLowerCase().includes(q))
      );
    });
  }, [messages, q, blocked, revealed]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header: label + search */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-edge px-3">
        {searchOpen ? (
          <>
            <Glyph name="search" size={15} className="shrink-0 text-dim" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  closeSearch();
                }
              }}
              aria-label="Search messages"
              placeholder="Search messages…"
              maxLength={100}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
            />
            {q && (
              <span className="tnum shrink-0 text-xs text-smoke" aria-live="polite">
                {shown.length} {shown.length === 1 ? "result" : "results"}
              </span>
            )}
            <IconButton label="Close search" onClick={closeSearch}>
              <Icon name="close" size={15} />
            </IconButton>
          </>
        ) : (
          <>
            <span className="data flex-1 text-dim">Live chat</span>
            <IconButton label="Search messages" onClick={() => setSearchOpen(true)}>
              <Glyph name="search" size={16} />
            </IconButton>
          </>
        )}
      </div>

      {header}

      {pinned && (
        <PinnedBar
          message={pinned}
          isAdmin={isAdmin}
          hidden={isHidden(pinned)}
          onOpen={() => jumpTo(pinned.id)}
          onUnpin={() => getSocket().emit("chat:pin", { id: null })}
        />
      )}

      {/* Messages */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={listRef}
          onScroll={onListScroll}
          className="h-full overflow-y-auto px-2 py-3"
          role="log"
          aria-label="Chat messages"
          aria-live={q ? "off" : "polite"}
        >
          {messages.length === 0 && (
            <p className="mt-6 px-4 text-center text-sm text-faint">
              No messages yet. Whatever you type shows up for everyone instantly.
            </p>
          )}
          {q && shown.length === 0 && messages.length > 0 && (
            <p className="mt-6 px-4 text-center text-sm text-faint">
              Nothing matches “{query.trim()}”.
            </p>
          )}

          {shown.map((m, i) => {
            const prev = i > 0 ? shown[i - 1] : null;
            const compact =
              !!prev &&
              !prev.system &&
              !prev.announce &&
              !m.system &&
              !m.announce &&
              !m.replyTo &&
              prev.browser === m.browser &&
              prev.name === m.name &&
              m.ts - prev.ts < GROUP_GAP_MS &&
              !isHidden(prev);
            const open = menu?.id === m.id ? menu : null;
            return (
              <MessageRow
                key={m.id}
                m={m}
                compact={compact}
                mine={isMine(m)}
                hidden={isHidden(m)}
                isBlocked={!!m.browser && blocked.has(m.browser)}
                isPinned={pinned?.id === m.id}
                isAdmin={isAdmin}
                canChat={canChat}
                query={q}
                flash={flashId === m.id}
                selfBrowser={selfBrowser}
                menu={open}
                menuRootRef={open ? menuRootRef : undefined}
                reportReason={reportReason}
                setReportReason={setReportReason}
                onOpenPopover={(kind, el) => openPopover(m.id, kind, el)}
                onReveal={() => reveal(m.id)}
                onReply={() => startReply(m)}
                onReact={(emoji) => {
                  react(m, emoji);
                  setMenu(null);
                }}
                onCopy={() => copy(m)}
                onTogglePin={() => togglePin(m)}
                onDelete={() => remove(m)}
                onReport={() => report(m)}
                onToggleBlock={() => toggleBlock(m)}
                onJump={(id) => jumpTo(id)}
                onSeek={onSeek}
              />
            );
          })}
        </div>

        {unseen && !atBottom && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-edge-strong bg-film-3 px-3.5 py-1.5 text-xs font-semibold text-bone shadow-xl transition hover:bg-film-2"
          >
            New messages
            <Icon name="chevronDown" size={14} />
          </button>
        )}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-edge p-3">
        {replyTo && canChat && (
          <div className="mb-2 flex items-center gap-2 rounded-card border border-edge bg-film-2 py-1.5 pl-3 pr-1.5 text-xs">
            <Glyph name="reply" size={14} className="shrink-0 text-dim" />
            <p className="min-w-0 flex-1 truncate text-smoke">
              Replying to{" "}
              <span className="font-semibold" style={{ color: replyTo.color }}>
                {replyTo.name || "someone"}
              </span>
              : {snippet(replyTo.text, 60)}
            </p>
            <IconButton label="Cancel reply" small onClick={() => setReplyTo(null)}>
              <Icon name="close" size={13} />
            </IconButton>
          </div>
        )}

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && replyTo) {
                e.preventDefault();
                setReplyTo(null);
              }
            }}
            disabled={!canChat}
            aria-label={announce ? "Announcement to the room" : "Message the room"}
            placeholder={
              !canChat
                ? "The host turned off your chat"
                : announce
                  ? "Announce to everyone…"
                  : replyTo
                    ? "Write a reply…"
                    : "Message the room…"
            }
            maxLength={MAX_LEN}
            className={`w-full min-w-0 rounded-card border bg-ink px-4 py-2.5 text-sm outline-none transition focus:border-signal/60 disabled:cursor-not-allowed disabled:opacity-60 ${
              announce ? "border-tungsten/50" : "border-edge"
            }`}
          />
          <button
            type="submit"
            disabled={!canChat || !text.trim()}
            className="rounded-card bg-signal px-4 py-2.5 text-sm font-semibold transition hover:bg-signal-hot active:scale-95 disabled:pointer-events-none disabled:opacity-40"
          >
            Send
          </button>
        </form>

        {canChat && (
          <div className="mt-2 flex items-center gap-1.5">
            <ToolChip
              onClick={insertMoment}
              disabled={videoTime === null}
              label={
                videoTime === null
                  ? "Insert a moment — nothing with a timeline is playing"
                  : `Insert the current moment (${formatTime(videoTime)})`
              }
            >
              <span aria-hidden>📍</span>
              Moment
              {videoTime !== null && (
                <span className="tnum text-faint">{formatTime(videoTime)}</span>
              )}
            </ToolChip>
            {isAdmin && (
              <ToolChip
                onClick={() => setAnnounce((a) => !a)}
                pressed={announce}
                label={
                  announce
                    ? "Announce is on — your next message goes to everyone as an announcement"
                    : "Send the next message as an announcement"
                }
              >
                <Glyph name="megaphone" size={13} />
                Announce
              </ToolChip>
            )}
            {text.length > MAX_LEN - 80 && (
              <span className="tnum ml-auto text-[11px] text-faint">
                {MAX_LEN - text.length}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Message row                                                       */
/* ---------------------------------------------------------------- */

function MessageRow({
  m,
  compact,
  mine,
  hidden,
  isBlocked,
  isPinned,
  isAdmin,
  canChat,
  query,
  flash,
  selfBrowser,
  menu,
  menuRootRef,
  reportReason,
  setReportReason,
  onOpenPopover,
  onReveal,
  onReply,
  onReact,
  onCopy,
  onTogglePin,
  onDelete,
  onReport,
  onToggleBlock,
  onJump,
  onSeek,
}: {
  m: ChatMessage;
  compact: boolean;
  mine: boolean;
  hidden: boolean;
  isBlocked: boolean;
  isPinned: boolean;
  isAdmin: boolean;
  canChat: boolean;
  query: string;
  flash: boolean;
  selfBrowser: string | null;
  menu: MenuState | null;
  menuRootRef: RefObject<HTMLDivElement | null> | undefined;
  reportReason: string;
  setReportReason: (v: string) => void;
  onOpenPopover: (kind: MenuState["kind"], trigger: HTMLElement | null) => void;
  onReveal: () => void;
  onReply: () => void;
  onReact: (emoji: string) => void;
  onCopy: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
  onReport: () => void;
  onToggleBlock: () => void;
  onJump: (id: string) => void;
  onSeek: (t: number) => void;
}) {
  const flashCls = flash ? "bg-tungsten/10 ring-1 ring-tungsten/40" : "";

  if (m.system) {
    return (
      <p
        data-mid={m.id}
        className={`my-2 rounded-card px-4 py-0.5 text-center text-xs italic text-faint transition ${flashCls}`}
      >
        <RichText text={m.text} query={query} onSeek={onSeek} />
      </p>
    );
  }

  const name = m.name || "Someone";

  if (hidden) {
    return (
      <p
        data-mid={m.id}
        className={`my-1 rounded-card px-3 py-1 text-xs italic text-faint transition ${flashCls}`}
      >
        Message from a blocked person ·{" "}
        <button
          type="button"
          onClick={onReveal}
          className="font-semibold not-italic text-smoke underline-offset-2 hover:text-bone hover:underline"
        >
          Show
        </button>
      </p>
    );
  }

  const reactions = Object.entries(m.reactions ?? {}).filter(([, who]) => who.length > 0);
  // Known reactions in their canonical order, anything else after.
  reactions.sort((a, b) => {
    const ia = (CHAT_REACTIONS as readonly string[]).indexOf(a[0]);
    const ib = (CHAT_REACTIONS as readonly string[]).indexOf(b[0]);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  const canDelete = isAdmin || mine;
  const isOther = !mine && !!m.browser;
  const open = !!menu;

  const body = (
    <>
      {m.replyTo && (
        <button
          type="button"
          onClick={() => onJump(m.replyTo!.id)}
          aria-label={`Replying to ${m.replyTo.name || "a message"}: ${snippet(
            m.replyTo.text,
            60
          )}. Show original`}
          className="mb-1 flex max-w-full items-center gap-1.5 rounded-lg border-l-2 border-edge-strong bg-bone/4 py-0.5 pl-2 pr-2.5 text-left text-xs text-smoke transition hover:bg-bone/8"
        >
          <Glyph name="reply" size={12} className="shrink-0 text-dim" />
          <span className="shrink-0 font-semibold text-bone/80">
            {m.replyTo.name || "Someone"}
          </span>
          <span className="truncate">{snippet(m.replyTo.text, 70)}</span>
        </button>
      )}
      <p
        className={`whitespace-pre-wrap break-words ${
          m.announce ? "text-[0.9375rem] leading-relaxed text-bone" : "text-sm text-bone/90"
        }`}
      >
        <RichText text={m.text} query={query} onSeek={onSeek} />
      </p>
      {reactions.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {reactions.map(([emoji, who]) => {
            const minePressed = !!selfBrowser && who.includes(selfBrowser);
            return (
              <button
                key={emoji}
                type="button"
                onClick={() => onReact(emoji)}
                disabled={!canChat}
                aria-pressed={minePressed}
                aria-label={`${emoji} ${who.length} — ${
                  minePressed ? "remove your reaction" : "react"
                }`}
                className={`tnum flex h-6 items-center gap-1 rounded-full border px-2 text-xs font-semibold transition active:scale-95 disabled:cursor-default ${
                  minePressed
                    ? "border-signal/50 bg-signal/12 text-signal-hot"
                    : "border-edge bg-bone/4 text-smoke hover:bg-bone/8 hover:text-bone"
                }`}
              >
                <span aria-hidden>{emoji}</span>
                {who.length}
              </button>
            );
          })}
        </div>
      )}
    </>
  );

  const toolbar = (
    <div
      ref={menuRootRef}
      className={`absolute right-1 top-0 z-20 ${
        open ? "" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"
      } transition-opacity`}
    >
      <div className="flex items-center rounded-full border border-edge bg-film-2 shadow-lg pointer-coarse:border-transparent pointer-coarse:bg-transparent pointer-coarse:shadow-none">
        {canChat && (
          <>
            <ToolbarButton
              label="Add a reaction"
              className="pointer-coarse:hidden"
              pressed={menu?.kind === "react"}
              onClick={(e) => onOpenPopover("react", e.currentTarget)}
            >
              <Glyph name="smile" size={15} />
            </ToolbarButton>
            <ToolbarButton
              label={`Reply to ${name}`}
              className="pointer-coarse:hidden"
              onClick={onReply}
            >
              <Glyph name="reply" size={15} />
            </ToolbarButton>
          </>
        )}
        <ToolbarButton
          label={`More for ${name}'s message`}
          menuTrigger
          pressed={menu?.kind === "menu" || menu?.kind === "report"}
          onClick={(e) => onOpenPopover("menu", e.currentTarget)}
        >
          <Icon name="more" size={16} />
        </ToolbarButton>
      </div>

      {menu && (
        <div
          className={`absolute right-0 w-56 overflow-hidden rounded-card border border-edge-strong bg-film-2 shadow-2xl ${
            menu.up ? "bottom-9" : "top-9"
          }`}
        >
          {menu.kind === "react" && (
            <div role="menu" aria-label="React" className="grid grid-cols-6 gap-0.5 p-1.5">
              {CHAT_REACTIONS.map((emoji) => {
                const on = !!selfBrowser && !!m.reactions?.[emoji]?.includes(selfBrowser);
                return (
                  <button
                    key={emoji}
                    role="menuitem"
                    type="button"
                    onClick={() => onReact(emoji)}
                    aria-label={`${on ? "Remove" : "React"} ${emoji}`}
                    className={`grid h-8 place-items-center rounded-lg text-lg leading-none transition hover:bg-bone/8 focus-visible:bg-bone/8 active:scale-90 ${
                      on ? "bg-signal/15" : ""
                    }`}
                  >
                    {emoji}
                  </button>
                );
              })}
            </div>
          )}

          {menu.kind === "menu" && (
            <div role="menu" aria-label={`Actions for ${name}'s message`} className="py-1">
              {canChat && (
                <>
                  <MenuItem icon={<Glyph name="reply" size={15} />} onClick={onReply}>
                    Reply
                  </MenuItem>
                  <MenuItem
                    icon={<Glyph name="smile" size={15} />}
                    onClick={() => onOpenPopover("react", null)}
                  >
                    React…
                  </MenuItem>
                </>
              )}
              <MenuItem icon={<Icon name="copy" size={14} />} onClick={onCopy}>
                Copy text
              </MenuItem>
              {isAdmin && (
                <MenuItem icon={<Glyph name="pin" size={15} />} onClick={onTogglePin}>
                  {isPinned ? "Unpin" : "Pin to top"}
                </MenuItem>
              )}
              {(canDelete || isOther) && <div className="my-1 h-px bg-edge" />}
              {isOther && (
                <MenuItem
                  icon={<Glyph name="flag" size={15} />}
                  onClick={() => onOpenPopover("report", null)}
                >
                  Report…
                </MenuItem>
              )}
              {isOther && (
                <MenuItem
                  icon={<Glyph name="block" size={15} />}
                  onClick={onToggleBlock}
                  hint={isBlocked ? undefined : "Only hides them for you"}
                >
                  {isBlocked ? `Unblock ${name}` : `Block ${name}`}
                </MenuItem>
              )}
              {canDelete && (
                <MenuItem icon={<Glyph name="trash" size={15} />} danger onClick={onDelete}>
                  Delete
                </MenuItem>
              )}
            </div>
          )}

          {menu.kind === "report" && (
            <form
              className="p-3"
              onSubmit={(e) => {
                e.preventDefault();
                onReport();
              }}
            >
              <p className="text-sm font-semibold">Report this message?</p>
              <p className="mt-0.5 text-xs leading-relaxed text-smoke">
                The hosts get a private note. {name} won&rsquo;t know it was you.
              </p>
              <input
                data-autofocus
                value={reportReason}
                onChange={(e) => setReportReason(e.target.value)}
                maxLength={200}
                aria-label="Reason (optional)"
                placeholder="Reason (optional)"
                className="mt-2.5 w-full rounded-lg border border-edge bg-ink px-3 py-2 text-sm outline-none transition focus:border-signal/60"
              />
              <div className="mt-2.5 flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => onOpenPopover("menu", null)}
                  className="rounded-full border border-edge bg-bone/5 px-3 py-1.5 text-xs font-semibold transition hover:bg-bone/10"
                >
                  Back
                </button>
                <button
                  type="submit"
                  className="rounded-full bg-signal px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-signal-hot active:scale-95"
                >
                  Report
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );

  if (m.announce) {
    return (
      <div
        data-mid={m.id}
        className={`group relative my-2 rounded-card border border-tungsten/35 bg-tungsten/[0.07] px-3 py-2.5 transition ${flashCls}`}
      >
        <div className="mb-1 flex items-center gap-1.5 pr-24 pointer-coarse:pr-9">
          <Glyph name="megaphone" size={15} className="shrink-0 text-tungsten" />
          <span className="data text-tungsten" style={{ fontSize: "0.625rem" }}>
            Announcement
          </span>
          <span className="truncate text-xs font-semibold" style={{ color: m.color }}>
            · {name}
            {mine && <span className="ml-1 font-normal text-faint">(you)</span>}
          </span>
        </div>
        {body}
        {toolbar}
      </div>
    );
  }

  return (
    <div
      data-mid={m.id}
      className={`group relative flex items-start gap-2.5 rounded-card px-2 transition hover:bg-bone/[0.03] ${
        compact ? "py-0.5" : "mt-2 py-1"
      } ${open ? "bg-bone/[0.03]" : ""} ${flashCls}`}
    >
      {compact ? (
        <span aria-hidden className="w-7 shrink-0" />
      ) : (
        <span
          aria-hidden
          className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold text-black"
          style={{ background: m.color }}
        >
          {name[0]?.toUpperCase()}
        </span>
      )}
      <div className="min-w-0 flex-1 pointer-coarse:pr-8">
        {compact ? (
          <span className="sr-only">{name}: </span>
        ) : (
          <div className="flex items-baseline gap-1.5 pr-20 pointer-coarse:pr-0">
            <span className="truncate text-xs font-semibold" style={{ color: m.color }}>
              {name}
            </span>
            {mine && (
              <span className="shrink-0 rounded-full bg-bone/8 px-1.5 text-[10px] font-semibold text-smoke">
                you
              </span>
            )}
            <time
              dateTime={new Date(m.ts).toISOString()}
              className="tnum shrink-0 text-[10px] text-faint"
            >
              {clockTime(m.ts)}
            </time>
          </div>
        )}
        {body}
      </div>
      {toolbar}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Pinned bar                                                        */
/* ---------------------------------------------------------------- */

function PinnedBar({
  message,
  isAdmin,
  hidden,
  onOpen,
  onUnpin,
}: {
  message: ChatMessage;
  isAdmin: boolean;
  hidden: boolean;
  onOpen: () => void;
  onUnpin: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-edge bg-film-2/70 py-1.5 pl-3 pr-1.5">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Pinned message from ${message.name || "the host"}. Show in chat`}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1 text-left"
      >
        <Glyph name="pin" size={15} className="shrink-0 text-tungsten" />
        <span className="min-w-0 flex-1">
          <span className="data block text-tungsten" style={{ fontSize: "0.5625rem" }}>
            Pinned
          </span>
          <span className="block truncate text-xs text-bone/90">
            {message.name && (
              <span className="font-semibold" style={{ color: message.color }}>
                {message.name}:{" "}
              </span>
            )}
            {hidden ? "Message from a blocked person" : snippet(message.text, 120)}
          </span>
        </span>
      </button>
      {isAdmin && (
        <IconButton label="Unpin message" small onClick={onUnpin}>
          <Icon name="close" size={13} />
        </IconButton>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Rich text: links, timestamps, search highlight — no innerHTML      */
/* ---------------------------------------------------------------- */

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

/** Trailing punctuation usually belongs to the sentence, not the link. */
function trimUrl(raw: string): string {
  let url = raw.replace(/[.,!?;:'"]+$/, "");
  while (url.endsWith(")") || url.endsWith("]") || url.endsWith("}")) {
    const close = url[url.length - 1];
    const openCh = close === ")" ? "(" : close === "]" ? "[" : "{";
    const opens = url.split(openCh).length - 1;
    const closes = url.split(close).length - 1;
    if (closes > opens) url = url.slice(0, -1).replace(/[.,!?;:'"]+$/, "");
    else break;
  }
  return url;
}

function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

type Segment =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; href: string }
  | { kind: "time"; text: string; seconds: number };

function segment(text: string): Segment[] {
  const out: Segment[] = [];
  const pushText = (s: string) => {
    if (!s) return;
    let cursor = 0;
    for (const t of findTimestamps(s)) {
      if (t.start > cursor) out.push({ kind: "text", text: s.slice(cursor, t.start) });
      out.push({ kind: "time", text: t.label, seconds: t.seconds });
      cursor = t.end;
    }
    if (cursor < s.length) out.push({ kind: "text", text: s.slice(cursor) });
  };

  let cursor = 0;
  URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_RE.exec(text))) {
    const url = trimUrl(match[0]);
    const href = url ? safeHref(url) : null;
    if (!href) continue;
    pushText(text.slice(cursor, match.index));
    out.push({ kind: "link", text: url, href });
    cursor = match.index + url.length;
    URL_RE.lastIndex = cursor;
  }
  pushText(text.slice(cursor));
  return out;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRe(query)})`, "gi"));
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-[3px] bg-tungsten/30 px-px text-bone">
            {p}
          </mark>
        ) : (
          p
        )
      )}
    </>
  );
}

function RichText({
  text,
  query,
  onSeek,
}: {
  text: string;
  query: string;
  onSeek: (t: number) => void;
}) {
  const segs = useMemo(() => segment(text), [text]);
  return (
    <>
      {segs.map((s, i) => {
        if (s.kind === "link") {
          return (
            <a
              key={i}
              href={s.href}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-signal-hot underline decoration-signal-hot/40 underline-offset-2 not-italic hover:decoration-signal-hot"
            >
              <Highlight text={s.text} query={query} />
            </a>
          );
        }
        if (s.kind === "time") {
          return (
            <button
              key={i}
              type="button"
              onClick={() => onSeek(s.seconds)}
              aria-label={`Jump the video to ${formatTime(s.seconds)}`}
              title={`Jump to ${formatTime(s.seconds)}`}
              className="tnum rounded px-0.5 font-semibold text-tungsten underline decoration-tungsten/40 underline-offset-2 not-italic transition hover:bg-tungsten/10 hover:decoration-tungsten"
            >
              <Highlight text={s.text} query={query} />
            </button>
          );
        }
        return <Highlight key={i} text={s.text} query={query} />;
      })}
    </>
  );
}

/* ---------------------------------------------------------------- */
/* Small parts                                                       */
/* ---------------------------------------------------------------- */

function IconButton({
  label,
  onClick,
  small = false,
  children,
}: {
  label: string;
  onClick: () => void;
  small?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`grid shrink-0 place-items-center rounded-full text-smoke transition hover:bg-bone/8 hover:text-bone ${
        small ? "h-7 w-7" : "h-8 w-8"
      }`}
    >
      {children}
    </button>
  );
}

function ToolbarButton({
  label,
  onClick,
  pressed,
  menuTrigger = false,
  className = "",
  children,
}: {
  label: string;
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  pressed?: boolean;
  menuTrigger?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      {...(menuTrigger
        ? { "data-menu-trigger": "", "aria-haspopup": "menu" as const, "aria-expanded": !!pressed }
        : { "aria-pressed": pressed })}
      className={`grid h-7 w-7 place-items-center rounded-full text-smoke transition hover:bg-bone/8 hover:text-bone ${
        pressed ? "bg-bone/10 text-bone" : ""
      } ${className}`}
    >
      {children}
    </button>
  );
}

function MenuItem({
  icon,
  danger = false,
  hint,
  onClick,
  children,
}: {
  icon: ReactNode;
  danger?: boolean;
  hint?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-start gap-2.5 px-3 py-2 text-left text-sm transition hover:bg-bone/6 focus-visible:bg-bone/6 focus-visible:outline-none ${
        danger ? "text-signal-hot" : ""
      }`}
    >
      <span className="mt-0.5 grid w-4 shrink-0 place-items-center">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate">{children}</span>
        {hint && <span className="block text-xs text-dim">{hint}</span>}
      </span>
    </button>
  );
}

function ToolChip({
  label,
  onClick,
  disabled = false,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={`flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold transition active:scale-95 disabled:pointer-events-none disabled:opacity-40 ${
        pressed
          ? "border-tungsten/50 bg-tungsten/12 text-tungsten"
          : "border-edge bg-bone/4 text-smoke hover:bg-bone/8 hover:text-bone"
      }`}
    >
      {children}
    </button>
  );
}

/* Glyphs Icon.tsx doesn't have, drawn in the same voice: 24px grid,
   1.6 stroke, round caps and joins. */
const GLYPHS = {
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.6" />
      <path d="m15.6 15.6 4.8 4.8" />
    </>
  ),
  megaphone: (
    <>
      <path d="M3.6 10v4a1.4 1.4 0 0 0 1.4 1.4h2.2L15 19.6V4.4L7.2 8.6H5A1.4 1.4 0 0 0 3.6 10Z" />
      <path d="M7.4 15.4 8.6 20h2.6l-1-4.2M18.4 9.2a4 4 0 0 1 0 5.6" />
    </>
  ),
  pin: (
    <>
      <path d="M9.2 3.6h5.6l-.9 5.2 3.5 3.4v1.6H6.6v-1.6l3.5-3.4-.9-5.2Z" />
      <path d="M12 13.8v6.6" />
    </>
  ),
  reply: (
    <>
      <path d="M9.6 6.4 4.4 11.6l5.2 5.2" />
      <path d="M4.4 11.6h9.4a5.8 5.8 0 0 1 5.8 5.8v1" />
    </>
  ),
  smile: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M8.4 14.2a4.4 4.4 0 0 0 7.2 0" />
      <path d="M9.2 9.6h.01M14.8 9.6h.01" strokeWidth={2.4} />
    </>
  ),
  flag: (
    <>
      <path d="M5.2 21V4.2" />
      <path d="M5.2 4.6c4.6-2.4 8.2 2.2 13.6 0v8.6c-5.4 2.2-9-2.4-13.6 0" />
    </>
  ),
  block: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="m5.9 5.9 12.2 12.2" />
    </>
  ),
  trash: (
    <>
      <path d="M4 6.6h16M9.4 6.6V4.8a1.2 1.2 0 0 1 1.2-1.2h2.8a1.2 1.2 0 0 1 1.2 1.2v1.8" />
      <path d="M6 6.6 7 19a1.6 1.6 0 0 0 1.6 1.4h6.8A1.6 1.6 0 0 0 17 19l1-12.4M10.2 10.6v6M13.8 10.6v6" />
    </>
  ),
} as const;

function Glyph({
  name,
  size = 16,
  ...rest
}: { name: keyof typeof GLYPHS; size?: number } & Omit<
  SVGProps<SVGSVGElement>,
  "name" | "children"
>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {GLYPHS[name]}
    </svg>
  );
}
