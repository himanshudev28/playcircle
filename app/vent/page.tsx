"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AppHeader } from "@/components/AppHeader";
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
    <div className="min-h-screen">
      <AppHeader active="vent" />
      <main className="mx-auto max-w-2xl px-5 py-12 sm:px-8">
        <div className="text-center">
          <div className="kicker text-brand">Anonymous board</div>
          <h1 className="mt-3 text-4xl font-extrabold tracking-tight sm:text-5xl">
            Say it anonymously.
          </h1>
          <p className="mx-auto mt-3 max-w-md text-white/55">
            Share a thought, vent, or a late-night confession. No names, no
            profiles — everyone here is a stranger passing through.
          </p>
        </div>

        <div className="mt-10 rounded-3xl border border-hairline bg-panel p-4">
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) post();
            }}
            rows={3}
            maxLength={400}
            placeholder="What's on your mind? Nobody will know it's you…"
            className="w-full resize-none rounded-xl border border-hairline bg-black/40 px-4 py-3 outline-none transition focus:border-brand"
          />
          <div className="mt-3 flex items-center justify-between">
            <span className="text-xs text-white/35">
              {text.length}/400 · posts are public &amp; anonymous
            </span>
            <button
              onClick={post}
              disabled={!text.trim() || posting}
              className="rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold transition hover:bg-brand-bright active:scale-95 disabled:opacity-40"
            >
              {posting ? "Posting…" : "Post anonymously"}
            </button>
          </div>
        </div>

        <div className="mt-8 space-y-3">
          {vents.length === 0 && (
            <p className="py-10 text-center text-sm text-white/35">
              The board is quiet. Be the first to share something.
            </p>
          )}
          <AnimatePresence initial={false}>
            {vents.map((v) => (
              <motion.div
                key={v.id}
                layout
                initial={{ opacity: 0, y: -12 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-2xl border border-hairline bg-white/[0.02] p-4"
              >
                <div className="flex items-center gap-2.5">
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-white/[0.05] text-base">
                    {v.emoji}
                  </span>
                  <div>
                    <div className="text-sm font-semibold text-white/80">
                      {v.alias}
                    </div>
                    <div className="text-xs text-white/35">{timeAgo(v.ts)}</div>
                  </div>
                </div>
                <p className="mt-3 whitespace-pre-wrap break-words text-[0.95rem] leading-relaxed text-white/85">
                  {v.text}
                </p>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}
