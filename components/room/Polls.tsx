"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/Icon";
import {
  getSocket,
  type Poll,
  type PollClosed,
  type PollKind,
  type QueueItem,
  type QueueState,
  type Reply,
} from "@/lib/socket";
import { MediaThumb, SourceBadge, mediaTitle } from "./mediaInfo";

/* Room polls.
   - PollCard: the running poll (or the last result for a few seconds) at the
     top of the chat tab. The server only says WHO voted, never what they
     picked, so this tab remembers its own pick (state + sessionStorage).
   - PollComposer: admin dialog to start a quick poll or a "what's next?".
   - VoteButtons: "Vote skip" / "Vote replay" for the player toolbar.
   RoomClient owns `poll` / `lastClosed` (from poll:update / poll:closed).
   Everything here only emits; the server enforces who may do what. */

const ACK_TIMEOUT = 8000;
/** A vote button stays armed ("Start vote?") this long before reverting. */
const CONFIRM_MS = 4000;
const UNREACHABLE = "Couldn't reach the room — try again";

const KIND_LABEL: Record<PollKind, string> = {
  custom: "Poll",
  next: "What's next?",
  skip: "Vote to skip",
  replay: "Vote to replay",
};

const DURATIONS = [
  { s: 15, label: "15 seconds" },
  { s: 30, label: "30 seconds" },
  { s: 60, label: "1 minute" },
  { s: 120, label: "2 minutes" },
  { s: 300, label: "5 minutes" },
  { s: 600, label: "10 minutes" },
] as const;

/* ---- Own pick, remembered per poll -------------------------------- */

const pickKey = (id: string) => `pc-poll-pick:${id}`;

function readPick(id: string): number | null {
  try {
    const raw = sessionStorage.getItem(pickKey(id));
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function savePick(id: string, option: number) {
  try {
    sessionStorage.setItem(pickKey(id), String(option));
  } catch {
    /* storage blocked — the in-memory pick still works for this page */
  }
}

/** Index of the "Yes" option on a skip / replay poll. */
function yesIndex(poll: Poll): number {
  const i = poll.options.findIndex((o) => o.label.trim().toLowerCase() === "yes");
  return i >= 0 ? i : 0;
}

function formatLeft(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const pct = (count: number, total: number) =>
  total > 0 ? Math.round((count / total) * 100) : 0;

/* ================================================================== */
/* PollCard                                                           */
/* ================================================================== */

/** The active poll (or the last result for ~8s after it closes). Renders
    null when neither. Compact card for the top of the chat tab. */
export function PollCard({
  poll,
  lastClosed,
  selfBrowser,
  isAdmin,
  serverNow,
  onToast,
}: {
  poll: Poll | null;
  lastClosed: PollClosed | null;
  selfBrowser: string | null;
  isAdmin: boolean;
  serverNow: () => number;
  onToast: (msg: string) => void;
}): React.ReactElement | null {
  const [picks, setPicks] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => serverNow());

  // A running poll wins, unless it's the very poll that just closed (the
  // poll:update → null may land a beat after poll:closed).
  const active = poll && poll.id !== lastClosed?.poll.id ? poll : null;
  const closed = active ? null : lastClosed;
  const activeId = active?.id ?? null;

  useEffect(() => {
    if (!activeId) return;
    const t = setInterval(() => setNow(serverNow()), 500);
    return () => clearInterval(t);
  }, [activeId, serverNow]);

  const shown = active ?? closed?.poll ?? null;
  if (!shown) return null;

  const voted = !!selfBrowser && shown.voters.includes(selfBrowser);
  const storedPick = picks[shown.id] ?? readPick(shown.id);
  // Only trust the remembered pick while the server still counts our vote.
  const myPick = voted ? storedPick : null;

  function vote(option: number) {
    if (!active) return;
    if (voted && myPick === option) return;
    // poll:vote has no ack — at least say so when it can't be sent.
    if (!getSocket().connected) return onToast(UNREACHABLE);
    setPicks((p) => ({ ...p, [active.id]: option }));
    savePick(active.id, option);
    getSocket().emit("poll:vote", { id: active.id, option });
  }

  function endPoll() {
    if (!active) return;
    if (!getSocket().connected) return onToast(UNREACHABLE);
    // No ack in the contract: the card flips to the result on poll:closed.
    getSocket().emit("poll:close", { id: active.id });
  }

  const isYesNo = shown.kind === "skip" || shown.kind === "replay";
  const yes = isYesNo ? yesIndex(shown) : -1;
  const left = active ? active.endsAt - now : 0;

  // Which option to outline as the result once closed.
  const winner = closed
    ? closed.cancelled
      ? null
      : isYesNo
        ? closed.passed
          ? yes
          : null
        : closed.winner
    : null;

  return (
    <section
      aria-label={KIND_LABEL[shown.kind]}
      className={`rounded-card border bg-film-2 p-3 ${
        active ? "border-edge-strong" : "border-edge"
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        <PollGlyph kind={shown.kind} />
        <span className="data text-tungsten">{KIND_LABEL[shown.kind]}</span>
        {shown.binding && (
          <span
            className="data rounded-full border border-tungsten/40 px-1.5 py-px text-tungsten"
            style={{ fontSize: "0.5625rem", letterSpacing: "0.16em" }}
            title="The result is acted on automatically"
          >
            Binding
          </span>
        )}
        <span className="ml-auto shrink-0">
          {active ? (
            <span
              className={`data tnum tracking-normal ${
                left <= 5000 ? "text-signal-hot" : "text-smoke"
              }`}
              aria-label={`Time left ${formatLeft(left)}`}
            >
              {left > 0 ? formatLeft(left) : "Closing…"}
            </span>
          ) : (
            <span className="data text-dim">Closed</span>
          )}
        </span>
      </div>

      {shown.question && (
        <p className="mt-2 text-sm font-medium leading-snug">{shown.question}</p>
      )}
      <p className="mt-1 flex items-center gap-1.5 truncate text-xs text-smoke">
        <span
          aria-hidden
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: shown.by.color }}
        />
        <span className="truncate">started by {shown.by.name}</span>
      </p>

      {/* Options */}
      <ul className="mt-2.5 space-y-1.5">
        {shown.options.map((o, i) => (
          <li key={i}>
            <OptionBar
              label={o.label}
              count={o.count}
              total={shown.total}
              mine={myPick === i}
              winner={winner === i}
              interactive={!!active}
              onVote={() => vote(i)}
            />
          </li>
        ))}
      </ul>

      {/* Footer */}
      {active ? (
        <div className="mt-2.5 flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-xs text-smoke">
            {isYesNo && active.needed != null ? (
              <>
                <span className="tnum font-semibold text-bone">
                  {active.options[yes]?.count ?? 0}
                </span>{" "}
                of <span className="tnum">{active.needed}</span> needed
              </>
            ) : (
              <>
                <span className="tnum">{active.total}</span>{" "}
                {active.total === 1 ? "vote" : "votes"}
              </>
            )}
            {voted && (
              <span className="text-dim">
                {" · "}
                {myPick == null ? "You voted" : "Tap another to change"}
              </span>
            )}
          </p>
          {isAdmin && (
            <button
              onClick={endPoll}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-edge bg-bone/5 px-3 py-1.5 text-xs font-semibold transition hover:bg-bone/10 active:scale-95"
            >
              <Icon name="close" size={12} />
              End poll
            </button>
          )}
        </div>
      ) : null}

      {/* Result — announced politely. */}
      <div aria-live="polite" role="status">
        {closed && (
          <p className="mt-2.5 flex items-center gap-1.5 text-sm font-semibold">
            {resultText(closed, isYesNo)}
          </p>
        )}
      </div>
    </section>
  );
}

function resultText(c: PollClosed, isYesNo: boolean): ReactNode {
  if (c.cancelled) return <span className="text-smoke">Cancelled</span>;
  if (isYesNo) {
    return c.passed ? (
      <>
        <Icon name="check" size={15} className="text-tungsten" />
        {c.poll.kind === "skip" ? "Passed — skipping" : "Passed — replaying"}
      </>
    ) : (
      <span className="text-smoke">Didn&apos;t pass</span>
    );
  }
  if (c.poll.total === 0) return <span className="text-smoke">No votes</span>;
  if (c.winner == null) return <span className="text-smoke">Tie</span>;
  const label = c.poll.options[c.winner]?.label ?? "—";
  return (
    <>
      <Icon name="check" size={15} className="shrink-0 text-tungsten" />
      <span className="min-w-0 truncate">
        {label}
        <span className="font-normal text-smoke"> wins</span>
        {c.poll.kind === "next" && c.poll.binding && (
          <span className="font-normal text-smoke"> — plays next</span>
        )}
      </span>
    </>
  );
}

function OptionBar({
  label,
  count,
  total,
  mine,
  winner,
  interactive,
  onVote,
}: {
  label: string;
  count: number;
  total: number;
  mine: boolean;
  winner: boolean;
  interactive: boolean;
  onVote: () => void;
}) {
  const p = pct(count, total);
  const tone = winner
    ? "border-tungsten/60"
    : mine
      ? "border-signal/50"
      : "border-edge";
  const body = (
    <>
      <span
        aria-hidden
        className={`absolute inset-y-0 left-0 transition-[width] duration-500 ease-out ${
          winner ? "bg-tungsten/15" : mine ? "bg-signal/15" : "bg-bone/6"
        }`}
        style={{ width: `${p}%` }}
      />
      <span className="relative flex items-center gap-2">
        {mine && (
          <Icon name="check" size={13} className="shrink-0 text-signal-hot" />
        )}
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <span className="tnum shrink-0 text-xs text-smoke">
          {count} · {p}%
        </span>
      </span>
    </>
  );
  const cls = `relative block w-full overflow-hidden rounded-xl border px-3 py-2 text-sm ${tone}`;

  if (!interactive) {
    return (
      <div className={`${cls} ${winner ? "font-semibold" : ""}`}>
        {body}
        <span className="sr-only">
          {winner ? " (winner)" : ""}
          {mine ? " (your vote)" : ""}
        </span>
      </div>
    );
  }
  return (
    <button
      onClick={onVote}
      aria-pressed={mine}
      aria-label={`${label}: ${count} ${count === 1 ? "vote" : "votes"}, ${p}%${
        mine ? " — your vote" : ""
      }`}
      className={`${cls} transition hover:bg-bone/4 active:scale-[0.99] ${
        mine ? "font-semibold" : ""
      }`}
    >
      {body}
    </button>
  );
}

/* ================================================================== */
/* PollComposer                                                       */
/* ================================================================== */

/** Admin dialog to start a poll: "Quick poll" or "What's next?". Emits
    poll:create with ack; shows the server's error inline; closes on
    success. Esc / backdrop close; focus is trapped and returned. */
export function PollComposer({
  open,
  onClose,
  queue,
  onToast,
}: {
  open: boolean;
  onClose: () => void;
  queue: QueueState;
  onToast: (msg: string) => void;
}): React.ReactElement | null {
  if (!open || typeof document === "undefined") return null;
  // Mounted fresh on every open, so the form always starts clean.
  return createPortal(
    <ComposerDialog onClose={onClose} queue={queue} onToast={onToast} />,
    document.body
  );
}

type Tab = "custom" | "next";

function ComposerDialog({
  onClose,
  queue,
  onToast,
}: {
  onClose: () => void;
  queue: QueueState;
  onToast: (msg: string) => void;
}) {
  const uid = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>("custom");
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [selected, setSelected] = useState<string[]>([]);
  const [binding, setBinding] = useState(true);
  const [seconds, setSeconds] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Focus the first field on open; hand focus back to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const first = dialogRef.current?.querySelector<HTMLElement>(
      "input, select, textarea"
    );
    first?.focus();
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  const ready = queue.items.filter((q) => q.status === "ready");
  const readyIds = new Set(ready.map((q) => q.id));
  const picked = selected.filter((id) => readyIds.has(id));

  const cleanOptions = options.map((o) => o.trim()).filter(Boolean);
  const dupes =
    new Set(cleanOptions.map((o) => o.toLowerCase())).size !== cleanOptions.length;

  const customProblem = !question.trim()
    ? "Ask a question"
    : cleanOptions.length < 2
      ? "Add at least two options"
      : dupes
        ? "Options must be different"
        : null;
  const nextProblem =
    ready.length < 2
      ? "Needs at least two ready videos in Up next"
      : picked.length < 2
        ? "Pick 2–5 videos"
        : null;
  const problem = tab === "custom" ? customProblem : nextProblem;

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const nodes = Array.from(
      root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function submit() {
    if (busy || problem) return;
    const payload =
      tab === "custom"
        ? {
            kind: "custom" as const,
            question: question.trim(),
            options: cleanOptions,
            seconds,
          }
        : { kind: "next" as const, itemIds: picked, binding, seconds };
    setBusy(true);
    setError(null);
    getSocket()
      .timeout(ACK_TIMEOUT)
      .emit("poll:create", payload, (err: Error | null, res?: Reply) => {
        setBusy(false);
        if (err || !res) return setError(UNREACHABLE);
        if (!res.ok) return setError(res.error || "Couldn't start the poll");
        onToast("Poll started");
        onClose();
      });
  }

  function toggleItem(id: string) {
    setError(null);
    setSelected((s) => {
      const live = s.filter((x) => readyIds.has(x));
      if (live.includes(id)) return live.filter((x) => x !== id);
      if (live.length >= 5) return live;
      return [...live, id];
    });
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "custom", label: "Quick poll" },
    { id: "next", label: "What's next?" },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
      onKeyDown={onKeyDown}
    >
      <div
        aria-hidden
        className="absolute inset-0 bg-ink/75 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        className="relative flex max-h-[min(42rem,calc(100dvh-2rem))] w-full max-w-md flex-col overflow-hidden rounded-panel border border-edge-strong bg-film shadow-2xl"
      >
        {/* Title */}
        <div className="flex items-center gap-3 border-b border-edge px-5 py-4">
          <h2 id={`${uid}-title`} className="flex-1 text-base font-semibold">
            Start a poll
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-full text-smoke transition hover:bg-bone/8 hover:text-bone"
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div
          role="tablist"
          aria-label="Poll type"
          className="mx-5 mt-4 flex gap-1 rounded-full border border-edge bg-ink p-1"
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              id={`${uid}-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`${uid}-panel`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => {
                setTab(t.id);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                e.preventDefault();
                const other = t.id === "custom" ? "next" : "custom";
                setTab(other);
                setError(null);
                document.getElementById(`${uid}-tab-${other}`)?.focus();
              }}
              className={`flex-1 rounded-full px-3 py-1.5 text-sm font-semibold transition ${
                tab === t.id
                  ? "bg-film-3 text-bone"
                  : "text-smoke hover:text-bone"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <form
          id={`${uid}-panel`}
          role="tabpanel"
          aria-labelledby={`${uid}-tab-${tab}`}
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
            {tab === "custom" ? (
              <>
                <Field label="Question" htmlFor={`${uid}-q`}>
                  <input
                    id={`${uid}-q`}
                    value={question}
                    onChange={(e) => {
                      setQuestion(e.target.value);
                      setError(null);
                    }}
                    maxLength={120}
                    placeholder="What should we watch tonight?"
                    className={INPUT}
                  />
                </Field>

                <fieldset>
                  <legend className="data mb-1.5 text-dim">Options</legend>
                  <ul className="space-y-1.5">
                    {options.map((o, i) => (
                      <li key={i} className="flex items-center gap-1.5">
                        <input
                          value={o}
                          onChange={(e) => {
                            const v = e.target.value;
                            setOptions((list) => list.map((x, j) => (j === i ? v : x)));
                            setError(null);
                          }}
                          maxLength={60}
                          aria-label={`Option ${i + 1}`}
                          placeholder={`Option ${i + 1}`}
                          className={INPUT}
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setOptions((list) => list.filter((_, j) => j !== i))
                          }
                          disabled={options.length <= 2}
                          aria-label={`Remove option ${i + 1}`}
                          className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-smoke transition hover:bg-bone/8 hover:text-bone disabled:pointer-events-none disabled:opacity-30"
                        >
                          <Icon name="close" size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                  {options.length < 6 && (
                    <button
                      type="button"
                      onClick={() => setOptions((list) => [...list, ""])}
                      className="mt-2 flex items-center gap-1.5 rounded-full border border-dashed border-edge-strong px-3 py-1.5 text-xs font-semibold text-smoke transition hover:bg-bone/5 hover:text-bone"
                    >
                      <PlusGlyph />
                      Add option
                    </button>
                  )}
                </fieldset>
              </>
            ) : (
              <>
                <fieldset>
                  <legend className="data mb-1.5 flex w-full items-center text-dim">
                    <span className="flex-1">Pick 2–5 from Up next</span>
                    <span className="tnum tracking-normal text-smoke">
                      {picked.length}/5
                    </span>
                  </legend>
                  {ready.length < 2 ? (
                    <p className="rounded-card border border-edge bg-film-2 px-4 py-5 text-center text-xs leading-relaxed text-smoke">
                      Queue at least two videos in Up next to let the room choose
                      between them.
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {ready.map((item) => (
                        <ItemChoice
                          key={item.id}
                          item={item}
                          checked={picked.includes(item.id)}
                          disabled={!picked.includes(item.id) && picked.length >= 5}
                          onToggle={() => toggleItem(item.id)}
                        />
                      ))}
                    </ul>
                  )}
                </fieldset>

                <button
                  type="button"
                  role="switch"
                  aria-checked={binding}
                  onClick={() => setBinding((b) => !b)}
                  className="flex w-full items-center gap-3 rounded-card px-1 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">Binding</span>
                    <span className="block text-xs text-smoke">
                      {binding
                        ? "The winner plays next."
                        : "Just a straw poll — the queue doesn't change."}
                    </span>
                  </span>
                  <Switch on={binding} />
                </button>
              </>
            )}

            <Field label="Duration" htmlFor={`${uid}-dur`}>
              <select
                id={`${uid}-dur`}
                value={seconds}
                onChange={(e) => setSeconds(Number(e.target.value))}
                className={`${INPUT} appearance-none`}
              >
                {DURATIONS.map((d) => (
                  <option key={d.s} value={d.s}>
                    {d.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {/* Footer */}
          <div className="border-t border-edge px-5 py-4">
            {error && (
              <p role="alert" className="mb-3 text-sm text-signal-hot">
                {error}
              </p>
            )}
            <div className="flex items-center gap-3">
              <p className="min-w-0 flex-1 truncate text-xs text-dim">
                {problem ?? "Everyone in the room can vote."}
              </p>
              <button
                type="button"
                onClick={onClose}
                className="rounded-full px-4 py-2 text-sm font-semibold text-smoke transition hover:bg-bone/6 hover:text-bone"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || !!problem}
                className="rounded-full bg-signal px-4 py-2 text-sm font-semibold text-white transition hover:bg-signal-hot active:scale-95 disabled:pointer-events-none disabled:opacity-40"
              >
                {busy ? "Starting…" : "Start poll"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

const INPUT =
  "w-full min-w-0 rounded-card border border-edge bg-ink px-4 py-2.5 text-sm outline-none transition focus:border-signal/60";

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="data mb-1.5 block text-dim">
        {label}
      </label>
      {children}
    </div>
  );
}

function ItemChoice({
  item,
  checked,
  disabled,
  onToggle,
}: {
  item: QueueItem;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <label
        className={`flex cursor-pointer items-center gap-2.5 rounded-card border px-2 py-2 transition ${
          checked
            ? "border-signal/50 bg-signal/8"
            : "border-transparent hover:bg-bone/4"
        } ${disabled ? "cursor-not-allowed opacity-45" : ""}`}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={onToggle}
          className="h-4 w-4 shrink-0 accent-signal"
        />
        <MediaThumb media={item.media} width={72} />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-sm leading-snug">
            {mediaTitle(item.media)}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-smoke">
            <SourceBadge media={item.media} />
            <span className="truncate">added by {item.by.name}</span>
          </span>
        </span>
      </label>
    </li>
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

/* ================================================================== */
/* VoteButtons                                                        */
/* ================================================================== */

/** "Vote skip" / "Vote replay" for the player toolbar. Starting a binding
    vote takes two clicks: the first arms the button ("Start vote?"), the
    second sends it. A timeout, Escape, or a click anywhere else disarms. */
export function VoteButtons({
  canCall,
  hasNext,
  pollRunning,
  onToast,
}: {
  canCall: boolean;
  hasNext: boolean;
  pollRunning: boolean;
  onToast: (msg: string) => void;
}): React.ReactElement | null {
  const [busy, setBusy] = useState<"skip" | "replay" | null>(null);
  const [arming, setArming] = useState<"skip" | "replay" | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!arming) return;
    const timer = setTimeout(() => setArming(null), CONFIRM_MS);
    const onPointer = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setArming(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setArming(null);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [arming]);

  if (!canCall) return null;

  const skipDisabled = pollRunning || !hasNext || busy !== null;
  const replayDisabled = pollRunning || busy !== null;
  // A button that became unusable while armed shows as disarmed.
  const armed =
    arming === "skip" && !skipDisabled
      ? "skip"
      : arming === "replay" && !replayDisabled
        ? "replay"
        : null;

  function press(kind: "skip" | "replay") {
    if (armed === kind) {
      setArming(null);
      call(kind);
    } else {
      setArming(kind);
    }
  }

  function call(kind: "skip" | "replay") {
    if (busy) return;
    setBusy(kind);
    getSocket()
      .timeout(ACK_TIMEOUT)
      .emit("poll:create", { kind }, (err: Error | null, res?: Reply) => {
        setBusy(null);
        if (err || !res) return onToast(UNREACHABLE);
        if (!res.ok)
          onToast(
            res.error ||
              (kind === "skip" ? "Couldn't start a skip vote" : "Couldn't start a replay vote")
          );
      });
  }

  const running = pollRunning ? "A poll is already running" : null;
  const confirmTitle = "Click again to start the vote";
  const skipTitle =
    armed === "skip"
      ? confirmTitle
      : running ?? (hasNext ? "Ask the room to skip to the next video" : "Nothing queued to skip to");
  const replayTitle =
    armed === "replay" ? confirmTitle : running ?? "Ask the room to start this video over";

  return (
    <div
      ref={wrapRef}
      className="flex items-center gap-1.5"
      onBlur={(e) => {
        // Keyboard users tabbing away disarm too.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setArming(null);
      }}
    >
      <ToolbarButton
        onClick={() => press("skip")}
        disabled={skipDisabled}
        title={skipTitle}
        armed={armed === "skip"}
        label={armed === "skip" ? "Start a vote to skip? Press again to confirm" : "Vote skip"}
      >
        <PollGlyph kind="skip" bare />
        {armed === "skip" ? "Start vote?" : "Vote skip"}
      </ToolbarButton>
      <ToolbarButton
        onClick={() => press("replay")}
        disabled={replayDisabled}
        title={replayTitle}
        armed={armed === "replay"}
        label={
          armed === "replay" ? "Start a vote to replay? Press again to confirm" : "Vote replay"
        }
      >
        <PollGlyph kind="replay" bare />
        {armed === "replay" ? "Start vote?" : "Vote replay"}
      </ToolbarButton>
      <span className="sr-only" aria-live="polite">
        {armed
          ? `Press again to start a ${armed === "skip" ? "skip" : "replay"} vote`
          : ""}
      </span>
    </div>
  );
}

function ToolbarButton({
  onClick,
  disabled,
  title,
  armed = false,
  label,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  title: string;
  /** Waiting for the confirming second click. */
  armed?: boolean;
  label?: string;
  children: ReactNode;
}) {
  return (
    // A wrapper keeps the tooltip visible while the button is disabled.
    <span title={title} className="inline-flex">
      <button
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 ${
          armed
            ? "border-signal/60 bg-signal/15 text-signal-hot hover:bg-signal/25"
            : "border-edge bg-bone/5 hover:bg-bone/10"
        }`}
      >
        {children}
      </button>
    </span>
  );
}

/* ---- Glyphs (same voice as Icon.tsx: 24px grid, 1.6 stroke) ------- */

function PollGlyph({ kind, bare = false }: { kind: PollKind; bare?: boolean }) {
  const paths: Record<PollKind, ReactNode> = {
    custom: <path d="M5 20V11M12 20V4M19 20v-6" />,
    next: (
      <>
        <path d="M4 6.5h11M4 12h11M4 17.5h7" />
        <path d="m16.5 15 3 2.5-3 2.5" />
      </>
    ),
    skip: (
      <>
        <path d="M5.5 5.6v12.8a.7.7 0 0 0 1.08.59l9.6-6.4a.7.7 0 0 0 0-1.18l-9.6-6.4a.7.7 0 0 0-1.08.59Z" />
        <path d="M19 5v14" />
      </>
    ),
    replay: (
      <>
        <path d="M3.8 12a8.2 8.2 0 1 0 2.4-5.8" />
        <path d="M3.8 3.8v4.6h4.6" />
      </>
    ),
  };
  return (
    <svg
      width={bare ? 13 : 14}
      height={bare ? 13 : 14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={bare ? "shrink-0" : "shrink-0 text-tungsten"}
    >
      {paths[kind]}
    </svg>
  );
}

function PlusGlyph() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
