"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/Icon";
import {
  getSocket,
  mediaKey,
  type Media,
  type QueueItem,
  type QueueReply,
  type QueueState,
  type RoomSettings,
  type VideoMedia,
} from "@/lib/socket";
import { MediaThumb, SourceBadge, mediaTitle } from "./mediaInfo";

/* "Up next": the room's shared watch queue.
   - Anyone allowed to chat can suggest. With approval on, suggestions from
     people without video control wait for the host.
   - Everyone votes on ready items; with order "votes" the server sorts by
     them, with "manual" the hosts arrange the list by hand.
   - RoomClient owns the queue state (from queue:update). This panel only
     emits; the server enforces every permission and decides what to show. */

const ACK_TIMEOUT = 8000;
/** A pasted link is resolved on the server (it may fetch the page, up to
    ~12 s), so `{ input }` adds wait longer before calling it unreachable. */
const RESOLVE_TIMEOUT = 20000;

export function QueuePanel({
  queue,
  media,
  settings,
  selfBrowser,
  canControl,
  canSuggest,
  isAdmin,
  canRunRoom,
  onToast,
  onStartPoll,
}: {
  queue: QueueState;
  media: Media | null;
  settings: RoomSettings;
  selfBrowser: string | null;
  canControl: boolean;
  canSuggest: boolean;
  isAdmin: boolean;
  canRunRoom: boolean;
  onToast: (msg: string) => void;
  /** Opens the poll composer (admins, with 2+ ready items). */
  onStartPoll?: () => void;
}) {
  const ready = queue.items.filter((q) => q.status === "ready");
  const pending = queue.items.filter(
    (q) => q.status === "pending" && (isAdmin || q.browser === selfBrowser)
  );
  const manual = settings.order === "manual";

  // queue:move swaps neighbours in the full list, pending items included.
  // To pass the adjacent *ready* item, step over any pending ones between.
  function move(item: QueueItem, dir: -1 | 1) {
    const all = queue.items;
    const i = all.findIndex((q) => q.id === item.id);
    if (i < 0) return;
    let j = i + dir;
    while (j >= 0 && j < all.length && all[j].status !== "ready") j += dir;
    if (j < 0 || j >= all.length) return;
    const socket = getSocket();
    for (let n = 0; n < Math.abs(j - i); n++) {
      socket.emit("queue:move", { id: item.id, dir });
    }
  }

  // `done(ok)` lets the add box keep the link when the add didn't land.
  function add(
    payload: { input: string } | { media: VideoMedia },
    done?: (ok: boolean) => void
  ) {
    getSocket()
      .timeout("input" in payload ? RESOLVE_TIMEOUT : ACK_TIMEOUT)
      .emit("queue:add", payload, (err: Error | null, res?: QueueReply) => {
        done?.(!err && !!res?.ok);
        if (err || !res) return onToast("Couldn't reach the room — try again");
        if (!res.ok) return onToast(res.error || "Couldn't add that video");
        if (res.duplicate) {
          onToast(
            res.status === "pending"
              ? "Already suggested — waiting for the host"
              : "Already queued — counted your vote"
          );
        } else if (res.status === "pending") {
          onToast("Sent to the host for approval");
        } else {
          onToast("Added to Up next");
        }
      });
  }

  function skip() {
    getSocket()
      .timeout(ACK_TIMEOUT)
      .emit("queue:skip", {}, (err: Error | null, res?: QueueReply) => {
        if (err || !res) return onToast("Couldn't reach the room — try again");
        if (!res.ok) onToast(res.error || "Couldn't skip right now");
      });
  }

  const queuedKeys = new Set(queue.items.map((q) => mediaKey(q.media)));
  const playingKey = mediaKey(media);
  const empty = ready.length === 0 && pending.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AddBox
        canSuggest={canSuggest}
        hint={
          settings.approval && !canControl
            ? "The host reviews suggestions before they play."
            : null
        }
        onAdd={(input, done) => add({ input }, done)}
      />

      <div className="flex-1 space-y-4 overflow-y-auto px-2 py-3">
        <NowPlaying
          media={media}
          canControl={canControl}
          canSkip={ready.length > 0}
          onSkip={skip}
        />

        {pending.length > 0 && (
          <section aria-labelledby="queue-pending">
            <SectionLabel id="queue-pending" count={pending.length}>
              {isAdmin ? "Waiting for review" : "Your suggestions"}
            </SectionLabel>
            <ul className="space-y-1">
              {pending.map((item) => (
                <PendingRow
                  key={item.id}
                  item={item}
                  isAdmin={isAdmin}
                  canPlay={canControl && isAdmin}
                />
              ))}
            </ul>
          </section>
        )}

        {ready.length > 0 && (
          <section aria-labelledby="queue-next">
            <SectionLabel id="queue-next" count={ready.length}>
              Up next
            </SectionLabel>
            {isAdmin && onStartPoll && ready.length >= 2 && (
              <button
                onClick={onStartPoll}
                className="mb-1.5 ml-2 flex items-center gap-1.5 rounded-full border border-edge bg-bone/5 px-3 py-1.5 text-xs font-semibold transition hover:bg-bone/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal active:scale-95"
              >
                <Glyph name="poll" size={13} />
                Start a what&apos;s-next poll
              </button>
            )}
            <ol className="space-y-1">
              {ready.map((item, i) => (
                <ReadyRow
                  key={item.id}
                  item={item}
                  position={i + 1}
                  voted={!!selfBrowser && item.voters.includes(selfBrowser)}
                  canPlay={canControl}
                  canMove={isAdmin && manual}
                  isFirst={i === 0}
                  isLast={i === ready.length - 1}
                  canRemove={isAdmin || item.browser === selfBrowser}
                  isOwn={item.browser === selfBrowser}
                  onMove={(dir) => move(item, dir)}
                />
              ))}
            </ol>
          </section>
        )}

        {empty && <EmptyState settings={settings} canSuggest={canSuggest} />}

        {queue.history.length > 0 && (
          <History
            history={queue.history.slice(0, 12)}
            canSuggest={canSuggest}
            isBlocked={(m: VideoMedia) => {
              const k = mediaKey(m);
              return k === playingKey || queuedKeys.has(k);
            }}
            isPlaying={(m) => mediaKey(m) === playingKey}
            onRequeue={(m) => add({ media: m })}
          />
        )}
      </div>

      {canRunRoom ? (
        <QueueSettings
          settings={settings}
          canClear={isAdmin && queue.items.length > 0}
        />
      ) : (
        isAdmin &&
        queue.items.length > 0 && (
          <div className="border-t border-edge p-3">
            <ClearButton />
          </div>
        )
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- */

function AddBox({
  canSuggest,
  hint,
  onAdd,
}: {
  canSuggest: boolean;
  hint: string | null;
  onAdd: (input: string, done: (ok: boolean) => void) => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  function submit() {
    const input = value.trim();
    if (!input || busy || !canSuggest) return;
    setBusy(true);
    onAdd(input, (ok) => {
      setBusy(false);
      // Keep the link on an error or timeout so it can be retried.
      if (ok) setValue("");
    });
  }

  return (
    <div className="border-b border-edge p-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={!canSuggest}
          aria-label="Video link to suggest"
          placeholder={
            canSuggest
              ? "Paste a video link to suggest…"
              : "The host turned off your suggestions"
          }
          maxLength={2000}
          className="w-full min-w-0 rounded-card border border-edge bg-ink px-4 py-2.5 text-sm outline-none transition focus:border-signal/60 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={!canSuggest || busy || !value.trim()}
          className="rounded-card bg-signal px-4 py-2.5 text-sm font-semibold transition hover:bg-signal-hot focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal active:scale-95 disabled:pointer-events-none disabled:opacity-40"
        >
          {busy ? "Finding…" : "Add"}
        </button>
      </form>
      {hint && canSuggest && (
        <p className="mt-2 px-1 text-xs text-smoke">{hint}</p>
      )}
    </div>
  );
}

function NowPlaying({
  media,
  canControl,
  canSkip,
  onSkip,
}: {
  media: Media | null;
  canControl: boolean;
  canSkip: boolean;
  onSkip: () => void;
}) {
  return (
    <section
      aria-label="Now playing"
      className="rounded-card border border-edge bg-film-2 p-2.5"
    >
      <p className="data mb-2 px-0.5 text-dim">Now playing</p>
      {media?.kind === "live" ? (
        <div className="flex items-center gap-3">
          <span className="grid aspect-video w-[72px] shrink-0 place-items-center rounded-lg bg-ink text-signal">
            <Icon name="broadcast" size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-sm font-medium leading-snug">
              {media.title || "Live share"}
            </p>
            <p className="mt-0.5 truncate text-xs text-smoke">
              Live share by {media.by}
            </p>
          </div>
          {canControl && (
            <button
              onClick={onSkip}
              disabled={!canSkip}
              title={canSkip ? "Play the next video now" : "Nothing queued"}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-edge bg-bone/5 px-3 py-1.5 text-xs font-semibold transition hover:bg-bone/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Glyph name="skip" size={13} />
              Skip
            </button>
          )}
        </div>
      ) : media ? (
        <div className="flex items-center gap-3">
          <MediaThumb media={media} width={72} />
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-sm font-medium leading-snug">
              {mediaTitle(media)}
            </p>
            {(media.author || media.kind !== "youtube") && (
              <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-smoke">
                <SourceBadge media={media} />
                {media.author && <span className="truncate">{media.author}</span>}
              </p>
            )}
          </div>
          {canControl && (
            <button
              onClick={onSkip}
              disabled={!canSkip}
              title={canSkip ? "Play the next video now" : "Nothing queued"}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-edge bg-bone/5 px-3 py-1.5 text-xs font-semibold transition hover:bg-bone/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Glyph name="skip" size={13} />
              Skip
            </button>
          )}
        </div>
      ) : (
        <p className="px-0.5 text-sm text-smoke">Nothing on screen yet.</p>
      )}
    </section>
  );
}

function SectionLabel({
  id,
  count,
  children,
}: {
  id: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <h3 id={id} className="data mb-1.5 flex items-center gap-2 px-2 text-dim">
      {children}
      <span className="rounded-full bg-bone/8 px-1.5 py-px text-smoke tracking-normal">
        {count}
      </span>
    </h3>
  );
}

function ReadyRow({
  item,
  position,
  voted,
  canPlay,
  canMove,
  isFirst,
  isLast,
  canRemove,
  isOwn,
  onMove,
}: {
  item: QueueItem;
  position: number;
  voted: boolean;
  canPlay: boolean;
  canMove: boolean;
  isFirst: boolean;
  isLast: boolean;
  canRemove: boolean;
  isOwn: boolean;
  onMove: (dir: -1 | 1) => void;
}) {
  const title = rowTitle(item.media);
  const name = title || "this video";
  const hasMenu = canPlay || canMove || canRemove;

  return (
    <li className="relative flex items-center gap-2.5 rounded-card px-2 py-2 transition hover:bg-bone/4">
      <span className="tnum w-4 shrink-0 text-center text-xs text-dim">
        {position}
      </span>
      <MediaThumb media={item.media} width={96} />
      <div className="min-w-0 flex-1">
        {item.next ? (
          <p
            className="data mb-0.5 flex items-center gap-1 text-signal-hot"
            style={{ fontSize: "0.625rem" }}
            title="Won a what's-next poll"
          >
            <Glyph name="poll" size={10} />
            Plays next
          </p>
        ) : (
          isFirst && (
            <p className="data mb-0.5 text-tungsten" style={{ fontSize: "0.625rem" }}>
              Next
            </p>
          )
        )}
        <p
          className={`line-clamp-2 text-sm leading-snug ${
            title ? "font-medium" : "text-smoke"
          }`}
        >
          {title || "Loading title…"}
        </p>
        <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-smoke">
          <SourceBadge media={item.media} />
          <span
            aria-hidden
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: item.by.color }}
          />
          <span className="truncate">
            added by {isOwn ? "you" : item.by.name}
          </span>
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <button
          onClick={() => getSocket().emit("queue:vote", { id: item.id })}
          aria-pressed={voted}
          aria-label={`${voted ? "Remove your vote for" : "Vote for"} ${name} (${
            item.votes
          } ${item.votes === 1 ? "vote" : "votes"})`}
          title={voted ? "You voted for this" : "Vote to play this sooner"}
          className={`flex h-8 min-w-11 items-center justify-center gap-1 rounded-full border px-2 text-xs font-semibold tnum transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal active:scale-95 ${
            voted
              ? "border-signal/50 bg-signal/12 text-signal-hot"
              : "border-edge text-smoke hover:bg-bone/8 hover:text-bone"
          }`}
        >
          <Glyph name="chevronUp" size={14} />
          {item.votes}
        </button>

        {hasMenu && (
          <RowMenu label={`More for ${name}`}>
            {(close) => (
              <>
                {canPlay && (
                  <MenuItem
                    icon={<Icon name="play" size={14} />}
                    onClick={() => {
                      getSocket().emit("queue:play", { id: item.id });
                      close();
                    }}
                  >
                    Play now
                  </MenuItem>
                )}
                {canMove && (
                  <>
                    {/* The menu stays open so a row can be nudged repeatedly. */}
                    <MenuItem
                      icon={<Glyph name="arrowUp" size={15} />}
                      disabled={isFirst}
                      onClick={() => onMove(-1)}
                    >
                      Move up
                    </MenuItem>
                    <MenuItem
                      icon={<Glyph name="arrowDown" size={15} />}
                      disabled={isLast}
                      onClick={() => onMove(1)}
                    >
                      Move down
                    </MenuItem>
                  </>
                )}
                {canRemove && (
                  <>
                    {(canPlay || canMove) && <div className="my-1 h-px bg-edge" />}
                    <MenuItem
                      icon={<Icon name="close" size={15} />}
                      danger
                      onClick={() => {
                        getSocket().emit("queue:remove", { id: item.id });
                        close();
                      }}
                    >
                      {isOwn ? "Withdraw" : "Remove"}
                    </MenuItem>
                  </>
                )}
              </>
            )}
          </RowMenu>
        )}
      </div>
    </li>
  );
}

function PendingRow({
  item,
  isAdmin,
  canPlay,
}: {
  item: QueueItem;
  isAdmin: boolean;
  canPlay: boolean;
}) {
  const title = rowTitle(item.media);
  const name = title || "this video";
  const emit = (event: string) => getSocket().emit(event, { id: item.id });

  return (
    <li className="rounded-card border border-edge bg-film-2 px-2 py-2">
      <div className="flex items-center gap-2.5">
        <MediaThumb media={item.media} width={80} />
        <div className="min-w-0 flex-1">
          <p
            className={`line-clamp-2 text-sm leading-snug ${
              title ? "font-medium" : "text-smoke"
            }`}
          >
            {title || "Loading title…"}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-smoke">
            <SourceBadge media={item.media} />
            <span
              aria-hidden
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: item.by.color }}
            />
            <span className="truncate">
              {isAdmin ? `suggested by ${item.by.name}` : "Waiting for the host"}
            </span>
          </p>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
        {isAdmin ? (
          <>
            {canPlay && (
              <SmallButton
                onClick={() => emit("queue:play")}
                aria-label={`Play ${name} now`}
              >
                <Icon name="play" size={11} />
                Play now
              </SmallButton>
            )}
            <SmallButton
              onClick={() => emit("queue:remove")}
              aria-label={`Reject ${name}`}
            >
              <Icon name="close" size={12} />
              Reject
            </SmallButton>
            <SmallButton
              primary
              onClick={() => emit("queue:approve")}
              aria-label={`Approve ${name}`}
            >
              <Icon name="check" size={12} />
              Approve
            </SmallButton>
          </>
        ) : (
          <SmallButton
            onClick={() => emit("queue:remove")}
            aria-label={`Withdraw ${name}`}
          >
            <Icon name="close" size={12} />
            Withdraw
          </SmallButton>
        )}
      </div>
    </li>
  );
}

function EmptyState({
  settings,
  canSuggest,
}: {
  settings: RoomSettings;
  canSuggest: boolean;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-8 text-center">
      <span className="grid h-11 w-11 place-items-center rounded-full bg-bone/5 text-smoke">
        <Icon name="film" size={20} />
      </span>
      <p className="mt-3 text-sm font-medium">Nothing up next</p>
      <p className="mt-1 max-w-[17rem] text-xs leading-relaxed text-smoke">
        {canSuggest
          ? "Paste a video link above — anyone here can suggest, and everyone votes on what plays first."
          : "Anyone allowed to suggest can add a video link, and everyone votes on what plays first."}{" "}
        {settings.autoplay
          ? "The top pick starts on its own when this video ends."
          : "The host starts the next one when it's time."}
      </p>
    </div>
  );
}

function History({
  history,
  canSuggest,
  isBlocked,
  isPlaying,
  onRequeue,
}: {
  history: QueueState["history"];
  canSuggest: boolean;
  isBlocked: (m: VideoMedia) => boolean;
  isPlaying: (m: VideoMedia) => boolean;
  onRequeue: (m: VideoMedia) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <section>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="queue-history"
        className="data flex w-full items-center gap-2 rounded-card px-2 py-1.5 text-left text-dim transition hover:text-smoke focus-visible:outline-2 focus-visible:outline-signal"
      >
        <span className="flex-1">Recently played</span>
        <span className="text-smoke tracking-normal">{history.length}</span>
        <Icon
          name="chevronDown"
          size={14}
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <ul id="queue-history" className="mt-1 space-y-1">
          {history.map((h) => {
            const playing = isPlaying(h.media);
            const blocked = isBlocked(h.media);
            const name = mediaTitle(h.media);
            return (
              <li
                key={`${mediaKey(h.media)}-${h.playedAt}`}
                className="flex items-center gap-2.5 rounded-card px-2 py-1.5"
              >
                <MediaThumb media={h.media} width={64} dim />
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-xs leading-snug text-smoke">
                    {name}
                  </p>
                  <SourceBadge media={h.media} className="mt-0.5" />
                </div>
                {canSuggest &&
                  (blocked ? (
                    <span className="shrink-0 px-2 text-xs text-faint">
                      {playing ? "Playing" : "Queued"}
                    </span>
                  ) : (
                    <SmallButton
                      onClick={() => onRequeue(h.media)}
                      aria-label={`Queue ${name} again`}
                    >
                      <Glyph name="requeue" size={12} />
                      Queue again
                    </SmallButton>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function QueueSettings({
  settings,
  canClear,
}: {
  settings: RoomSettings;
  canClear: boolean;
}) {
  const [open, setOpen] = useState(false);
  const byVotes = settings.order === "votes";
  const emit = (
    patch: Partial<
      Pick<RoomSettings, "approval" | "order" | "autoplay" | "voteSkip">
    >
  ) => getSocket().emit("host:settings", patch);

  const summary = [
    byVotes ? "By votes" : "By hand",
    settings.approval ? "Review on" : null,
    settings.autoplay ? "Autoplay" : null,
    settings.voteSkip ? "Vote skip" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="border-t border-edge p-3">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="queue-settings"
        className="flex w-full items-center gap-2 rounded-card px-1 text-left focus-visible:outline-2 focus-visible:outline-signal"
      >
        <span className="data text-dim">Queue settings</span>
        <span className="min-w-0 flex-1 truncate text-right text-xs text-faint">
          {open ? "" : summary}
        </span>
        <Icon
          name="chevronDown"
          size={14}
          className={`shrink-0 text-dim transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div id="queue-settings" className="mt-3 space-y-3">
          <SettingRow
            icon={<Icon name="check" size={17} />}
            title="Approve suggestions"
            body={
              settings.approval
                ? "Hosts review what others suggest first."
                : "Suggestions go straight into Up next."
            }
            on={settings.approval}
            onToggle={() => emit({ approval: !settings.approval })}
          />
          <SettingRow
            icon={<Glyph name="chevronUp" size={17} />}
            title="Order by votes"
            body={
              byVotes
                ? "The most-voted video plays first."
                : "Hosts arrange the list by hand."
            }
            on={byVotes}
            onToggle={() => emit({ order: byVotes ? "manual" : "votes" })}
          />
          <SettingRow
            icon={<Icon name="play" size={15} />}
            title="Autoplay next"
            body={
              settings.autoplay
                ? "The next video starts when one ends."
                : "Hosts start the next video themselves."
            }
            on={settings.autoplay}
            onToggle={() => emit({ autoplay: !settings.autoplay })}
          />
          <SettingRow
            icon={<Glyph name="skip" size={15} />}
            title="Vote to skip"
            body={
              settings.voteSkip
                ? "Anyone who can chat may call a skip or replay vote."
                : "Only hosts can call skip or replay votes."
            }
            on={settings.voteSkip}
            onToggle={() => emit({ voteSkip: !settings.voteSkip })}
          />
          {canClear && <ClearButton />}
        </div>
      )}
    </div>
  );
}

function ClearButton() {
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 4000);
    return () => clearTimeout(t);
  }, [confirm]);

  return (
    <button
      onClick={() => {
        if (confirm) {
          getSocket().emit("queue:clear");
          setConfirm(false);
        } else {
          setConfirm(true);
        }
      }}
      className={`flex w-full items-center justify-center gap-2 rounded-card border px-4 py-2 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal active:scale-[0.98] ${
        confirm
          ? "border-signal bg-signal text-white hover:bg-signal-hot"
          : "border-signal/40 text-signal-hot hover:bg-signal/10"
      }`}
    >
      <Icon name="close" size={15} />
      {confirm ? "Tap again to clear the queue" : "Clear queue"}
    </button>
  );
}

/* ---- Small pieces ------------------------------------------------ */

// A queue row's title. YouTube titles arrive a moment after the add (null
// meanwhile: "Loading title…"); other sources name themselves from the link.
function rowTitle(m: VideoMedia): string | null {
  if (m.title) return m.title;
  return m.kind === "youtube" ? null : mediaTitle(m);
}

function RowMenu({
  label,
  children,
}: {
  label: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle() {
    if (!open) {
      // Open upward when the row sits near the bottom of the scrolling list,
      // so the menu isn't clipped by the panel.
      const btn = triggerRef.current;
      let scroller = btn?.parentElement ?? null;
      while (scroller && getComputedStyle(scroller).overflowY !== "auto") {
        scroller = scroller.parentElement;
      }
      if (btn && scroller) {
        const below =
          scroller.getBoundingClientRect().bottom - btn.getBoundingClientRect().bottom;
        setUp(below < 170);
      }
    }
    setOpen((o) => !o);
  }

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        onClick={toggle}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className="grid h-8 w-8 place-items-center rounded-full text-smoke transition hover:bg-bone/8 hover:text-bone focus-visible:outline-2 focus-visible:outline-signal"
      >
        <Icon name="more" size={18} />
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute right-0 z-20 w-44 overflow-hidden rounded-card border border-edge-strong bg-film-2 py-1 shadow-2xl ${
            up ? "bottom-9" : "top-9"
          }`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  danger = false,
  disabled = false,
  onClick,
  children,
}: {
  icon: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition hover:bg-bone/6 focus-visible:bg-bone/6 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-35 ${
        danger ? "text-signal-hot" : ""
      }`}
    >
      <span className="grid w-4 shrink-0 place-items-center">{icon}</span>
      <span className="truncate">{children}</span>
    </button>
  );
}

function SmallButton({
  primary = false,
  onClick,
  children,
  ...rest
}: {
  primary?: boolean;
  onClick: () => void;
  children: ReactNode;
  "aria-label"?: string;
}) {
  return (
    <button
      onClick={onClick}
      {...rest}
      className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal active:scale-95 ${
        primary
          ? "bg-signal text-white hover:bg-signal-hot"
          : "border border-edge bg-bone/5 hover:bg-bone/10"
      }`}
    >
      {children}
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

function SettingRow({
  icon,
  title,
  body,
  on,
  onToggle,
}: {
  icon: ReactNode;
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
      className="flex w-full items-center gap-3 rounded-card px-1 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
    >
      <span className="grid w-[17px] shrink-0 place-items-center text-smoke">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-smoke">{body}</span>
      </span>
      <Switch on={on} />
    </button>
  );
}

/* Glyphs Icon.tsx doesn't have, drawn in the same voice: 24px grid,
   1.6 stroke, round caps and joins. Kept local to this panel. */
const GLYPHS = {
  chevronUp: <path d="m6 14.5 6-6 6 6" />,
  arrowUp: <path d="M12 19V5M5.8 11.2 12 5l6.2 6.2" />,
  arrowDown: <path d="M12 5v14M5.8 12.8 12 19l6.2-6.2" />,
  skip: (
    <>
      <path d="M5.5 5.6v12.8a.7.7 0 0 0 1.08.59l9.6-6.4a.7.7 0 0 0 0-1.18l-9.6-6.4a.7.7 0 0 0-1.08.59Z" />
      <path d="M19 5v14" />
    </>
  ),
  requeue: (
    <>
      <path d="M3.8 12a8.2 8.2 0 1 0 2.4-5.8" />
      <path d="M3.8 3.8v4.6h4.6" />
    </>
  ),
  poll: <path d="M5 20V12M12 20V5M19 20v-5" />,
} satisfies Record<string, ReactNode>;

function Glyph({
  name,
  size = 16,
  className,
}: {
  name: keyof typeof GLYPHS;
  size?: number;
  className?: string;
}) {
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
      className={className}
    >
      {GLYPHS[name]}
    </svg>
  );
}

