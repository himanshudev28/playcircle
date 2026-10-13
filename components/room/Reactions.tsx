"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  getSocket,
  LIVE_REACTIONS,
  type LiveReaction,
  type Moment,
} from "@/lib/socket";
import { formatTime } from "@/lib/timestamps";

/* Live reactions:
   - ReactionBar: the emoji row people tap.
   - ReactionOverlay: emojis floating up over the player as they arrive.
   - MomentsTimeline: where on the video the room reacted most. */

/* ---------------------------------------------------------------- */
/* ReactionBar                                                       */
/* ---------------------------------------------------------------- */

const SEND_GAP_MS = 250;

/** Row of LIVE_REACTIONS buttons; emits reaction:send. */
export function ReactionBar({ disabled = false }: { disabled?: boolean }) {
  const lastSent = useRef(-Infinity);

  // `at` is the click's event timestamp (ms since page load).
  function send(emoji: string, at: number) {
    if (disabled) return;
    // A local brake on button mashing; the server rate-limits for real.
    const now = at;
    if (now - lastSent.current < SEND_GAP_MS) return;
    lastSent.current = now;
    getSocket().emit("reaction:send", { emoji });
  }

  return (
    <div
      role="group"
      aria-label="Send a reaction"
      className="flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full border border-edge bg-film-2 p-1"
    >
      {LIVE_REACTIONS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          onClick={(e) => send(emoji, e.timeStamp)}
          disabled={disabled}
          aria-label={`React ${emoji}`}
          title={disabled ? "Reactions are off for you" : `React ${emoji}`}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-lg leading-none transition hover:-translate-y-0.5 hover:bg-bone/8 active:scale-90 disabled:pointer-events-none disabled:opacity-35"
        >
          <span aria-hidden>{emoji}</span>
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* ReactionOverlay                                                   */
/* ---------------------------------------------------------------- */

const MAX_FLOATERS = 40;

type Floater = {
  key: number;
  emoji: string;
  name: string;
  color: string;
  /** Horizontal start, % of the overlay width. */
  x: number;
  /** Sideways wander while rising, px. */
  drift: number;
  duration: number;
};

/** Absolutely-positioned layer over the player (the parent is `relative`):
    each incoming `reaction` floats up from the bottom with a name tag. */
export function ReactionOverlay() {
  const [floaters, setFloaters] = useState<Floater[]>([]);
  const nextKey = useRef(0);

  useEffect(() => {
    const socket = getSocket();
    const onReaction = (r: LiveReaction) => {
      // Don't pile up a backlog of animations in a background tab.
      if (typeof document !== "undefined" && document.hidden) return;
      const f: Floater = {
        key: nextKey.current++,
        emoji: r.emoji,
        name: r.name,
        color: r.color,
        x: 8 + Math.random() * 30 + (Math.random() < 0.5 ? 0 : 46),
        drift: (Math.random() - 0.5) * 70,
        duration: 2600 + Math.random() * 1200,
      };
      setFloaters((list) => {
        const next = [...list, f];
        return next.length > MAX_FLOATERS ? next.slice(-MAX_FLOATERS) : next;
      });
    };
    socket.on("reaction", onReaction);
    return () => {
      socket.off("reaction", onReaction);
    };
  }, []);

  function remove(key: number) {
    setFloaters((list) => list.filter((f) => f.key !== key));
  }

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
    >
      {floaters.map((f) => (
        <FloatingReaction key={f.key} f={f} onDone={() => remove(f.key)} />
      ))}
    </div>
  );
}

function FloatingReaction({ f, onDone }: { f: Floater; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const doneRef = useRef(onDone);

  useEffect(() => {
    doneRef.current = onDone;
  });

  useEffect(() => {
    const el = ref.current;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      doneRef.current();
    };
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    let anim: Animation | null = null;
    if (el && typeof el.animate === "function") {
      anim = reduced
        ? el.animate(
            [
              { opacity: 0 },
              { opacity: 1, offset: 0.15 },
              { opacity: 1, offset: 0.75 },
              { opacity: 0 },
            ],
            { duration: 1800, easing: "linear", fill: "forwards" }
          )
        : el.animate(
            [
              { transform: "translate(0, 0) scale(0.6)", opacity: 0 },
              {
                transform: `translate(${f.drift * 0.3}px, -12%) scale(1.1)`,
                opacity: 1,
                offset: 0.12,
              },
              {
                transform: `translate(${f.drift}px, -55%) scale(1)`,
                opacity: 1,
                offset: 0.7,
              },
              { transform: `translate(${f.drift * 0.6}px, -78%) scale(0.95)`, opacity: 0 },
            ],
            {
              duration: f.duration,
              easing: "cubic-bezier(0.22, 1, 0.36, 1)",
              fill: "forwards",
            }
          );
      anim.onfinish = finish;
    }
    // Belt and braces: remove even if the animation never reports back.
    const timer = setTimeout(finish, (reduced ? 1800 : f.duration) + 400);
    return () => {
      clearTimeout(timer);
      anim?.cancel();
    };
  }, [f.drift, f.duration]);

  return (
    <div
      ref={ref}
      className="absolute bottom-3 flex h-full flex-col items-center justify-end opacity-0"
      style={{ left: `${f.x}%` }}
    >
      <span className="text-3xl leading-none drop-shadow-[0_2px_6px_rgba(0,0,0,0.55)]">
        {f.emoji}
      </span>
      <span
        className="mt-1 max-w-[7rem] truncate rounded-full bg-ink/75 px-1.5 py-px text-[10px] font-semibold"
        style={{ color: f.color }}
      >
        {f.name}
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* MomentsTimeline                                                   */
/* ---------------------------------------------------------------- */

type Bin = {
  start: number;
  count: number;
  /** Most common emoji in this bin. */
  top: string | null;
  topCount: number;
};

function binCountFor(duration: number) {
  if (duration < 600) return 60;
  if (duration < 3600) return 80;
  return 100;
}

function buildBins(moments: Moment[], duration: number): Bin[] {
  const n = binCountFor(duration);
  const size = duration / n;
  const tallies: Map<string, number>[] = Array.from({ length: n }, () => new Map());
  const counts = new Array<number>(n).fill(0);
  for (const m of moments) {
    if (!Number.isFinite(m.t)) continue;
    const i = Math.min(n - 1, Math.max(0, Math.floor(m.t / size)));
    counts[i]++;
    tallies[i].set(m.e, (tallies[i].get(m.e) ?? 0) + 1);
  }
  return counts.map((count, i) => {
    let top: string | null = null;
    let topCount = 0;
    for (const [e, c] of tallies[i]) {
      if (c > topCount) {
        top = e;
        topCount = c;
      }
    }
    return { start: i * size, count, top, topCount };
  });
}

/** Up to three peaks, kept apart so one burst isn't marked three times. */
function pickPeaks(bins: Bin[]): Set<number> {
  const order = bins
    .map((b, i) => i)
    .filter((i) => bins[i].count > 0)
    .sort((a, b) => bins[b].count - bins[a].count);
  const gap = Math.max(2, Math.round(bins.length / 25));
  const chosen: number[] = [];
  for (const i of order) {
    if (chosen.length === 3) break;
    if (chosen.every((c) => Math.abs(c - i) > gap)) chosen.push(i);
  }
  return new Set(chosen);
}

/** Heat strip of the room's reactions across the current video. */
export function MomentsTimeline({
  moments,
  duration,
  currentTime,
  onSeek,
}: {
  moments: Moment[];
  duration: number | null;
  currentTime: () => number | null;
  onSeek: (t: number) => void;
}) {
  const visible = !!duration && duration > 0 && moments.length > 0;
  const [now, setNow] = useState<number | null>(null);
  const [active, setActive] = useState<number | null>(null);

  const currentTimeRef = useRef(currentTime);
  useEffect(() => {
    currentTimeRef.current = currentTime;
  });

  useEffect(() => {
    if (!visible) return;
    const read = () => setNow(currentTimeRef.current());
    const id = setInterval(read, 500);
    const first = setTimeout(read, 0);
    return () => {
      clearInterval(id);
      clearTimeout(first);
    };
  }, [visible]);

  const bins = useMemo(
    () => (visible ? buildBins(moments, duration!) : []),
    [visible, moments, duration]
  );
  const peaks = useMemo(() => pickPeaks(bins), [bins]);
  const max = useMemo(() => bins.reduce((m, b) => Math.max(m, b.count), 0), [bins]);

  if (!visible || !duration) return null;

  const pct = (t: number) => `${Math.min(100, Math.max(0, (t / duration) * 100))}%`;
  const binWidth = 100 / bins.length;
  const activeBin = active !== null ? bins[active] : null;

  return (
    <div className="select-none">
      <div className="mb-1 flex items-center justify-between px-0.5">
        <span className="data text-dim">Room reactions</span>
        <span className="tnum text-[11px] text-faint">{moments.length}</span>
      </div>

      <div
        className="relative h-12 pt-4"
        onPointerLeave={() => setActive(null)}
      >
        {/* Peak markers */}
        {[...peaks].map((i) => (
          <span
            key={i}
            aria-hidden
            className="absolute top-0 -translate-x-1/2 text-xs leading-none"
            style={{ left: `${(i + 0.5) * binWidth}%` }}
          >
            {bins[i].top}
          </span>
        ))}

        <div
          role="group"
          aria-label="Reactions across the video — pick a moment to jump there"
          className="flex h-full items-end gap-px border-b border-edge"
        >
          {bins.map((b, i) => {
            const h = b.count === 0 ? 0 : 12 + (b.count / max) * 88;
            const isPeak = peaks.has(i);
            const isActive = active === i;
            return (
              <button
                key={i}
                type="button"
                tabIndex={b.count > 0 ? 0 : -1}
                onPointerEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive((a) => (a === i ? null : a))}
                onClick={() => onSeek(b.start)}
                aria-label={`Jump to ${formatTime(b.start)}, ${
                  b.count === 0
                    ? "no reactions"
                    : `${b.count} ${b.count === 1 ? "reaction" : "reactions"}, mostly ${b.top}`
                }`}
                className="flex h-full min-w-0 flex-1 cursor-pointer items-end rounded-none focus-visible:outline-1"
              >
                <span
                  className={`block w-full rounded-t-[2px] transition-colors ${
                    isActive
                      ? "bg-tungsten"
                      : isPeak
                        ? "bg-signal"
                        : "bg-signal/45"
                  }`}
                  style={{ height: `${h}%` }}
                />
              </button>
            );
          })}
        </div>

        {/* Playhead */}
        {now !== null && (
          <span
            aria-hidden
            className="pointer-events-none absolute bottom-0 top-3 w-px bg-bone/80"
            style={{ left: pct(now) }}
          />
        )}

        {/* Tooltip */}
        {activeBin && active !== null && (
          <span
            aria-hidden
            className="tnum pointer-events-none absolute -top-6 z-10 -translate-x-1/2 whitespace-nowrap rounded-full border border-edge-strong bg-film-3 px-2 py-0.5 text-[11px] font-semibold text-bone shadow-lg"
            style={{
              left: `clamp(2.5rem, ${(active + 0.5) * binWidth}%, calc(100% - 2.5rem))`,
            }}
          >
            {formatTime(activeBin.start)}
            {activeBin.count > 0 ? ` · ${activeBin.top} ${activeBin.count}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}
