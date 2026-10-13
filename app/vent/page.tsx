"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AppHeader } from "@/components/AppHeader";
import { SectionMarker } from "@/components/ui";
import { getSocket, type Vent } from "@/lib/socket";

function timeAgo(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

export default function VentPage() {
  const [vents, setVents] = useState<Vent[]>([]);
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const socket = getSocket();
    const onList = (list: Vent[]) => setVents(list.slice().reverse());
    const onNew = (v: Vent) => setVents((prev) => [v, ...prev].slice(0, 100));
    socket.on("vent:list", onList);
    socket.on("vent:new", onNew);

    const load = () => socket.emit("vent:list");
    socket.on("connect", load);
    if (socket.connected) load();

    return () => {
      socket.off("vent:list", onList);
      socket.off("vent:new", onNew);
      socket.off("connect", load);
    };
  }, []);

  function post() {
    const t = text.trim();
    if (!t) return;
    setPosting(true);
    getSocket().emit("vent:post", { text: t });
    setText("");
    setTimeout(() => setPosting(false), 400);
    taRef.current?.focus();
  }

  return (
    <div className="min-h-dvh">
      <AppHeader active="vent" />

      <main className="mx-auto max-w-2xl px-5 py-14 sm:px-8">
        <div className="text-center">
          <SectionMarker
            time="ANON"
            label="Community board"
            className="justify-center"
          />
          <h1 className="mt-5 font-display text-4xl font-extrabold text-bone sm:text-5xl">
            Say it anonymously.
          </h1>
          <p className="mx-auto mt-4 max-w-md leading-8 text-smoke">
            Share a thought, a vent, or a late-night confession. No names and no
            profiles — everyone here is a stranger passing through.
          </p>
        </div>

        <div className="mt-12 rounded-hero border border-edge bg-film p-4">
          <label htmlFor="vent" className="sr-only">
            Your message
          </label>
          <textarea
            id="vent"
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) post();
            }}
            rows={3}
            maxLength={400}
            placeholder="What's on your mind? Nobody will know it's you…"
            className="w-full resize-none rounded-card border border-edge bg-ink px-4 py-3.5 leading-7 text-bone placeholder:text-faint outline-none transition-colors focus:border-signal/60"
          />

          <div className="mt-3 flex items-center justify-between gap-4">
            <span className="data text-faint tnum">
              {text.length}/400 · public &amp; anonymous
            </span>
            <button
              onClick={post}
              disabled={!text.trim() || posting}
              className="shrink-0 rounded-card bg-signal px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-signal-hot active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {posting ? "Posting…" : "Post anonymously"}
            </button>
          </div>
        </div>

        <div className="mt-10 space-y-3">
          {vents.length === 0 && (
            <p className="py-12 text-center text-smoke">
              The board is quiet. Be the first to share something.
            </p>
          )}

          <AnimatePresence initial={false}>
            {vents.map((v) => (
              <motion.article
                key={v.id}
                layout
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-panel border border-edge bg-film/60 p-5"
              >
                <div className="flex items-center gap-3">
                  <span className="grid h-9 w-9 place-items-center rounded-full border border-edge bg-ink text-base">
                    {v.emoji}
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-bone">{v.alias}</p>
                    <p className="data text-faint">{timeAgo(v.ts)}</p>
                  </div>
                </div>
                <p className="mt-4 whitespace-pre-wrap break-words leading-8 text-bone/90">
                  {v.text}
                </p>
              </motion.article>
            ))}
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}
