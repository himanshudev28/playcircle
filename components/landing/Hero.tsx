"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";

const ROTATING = [
  { tag: "MOVIE NIGHTS", icon: "🎬" },
  { tag: "SOCIAL & COMMUNITY", icon: "💬" },
  { tag: "LONG·DISTANCE", icon: "❤️" },
  { tag: "COMMUNITIES", icon: "🌍" },
];

const CARDS = [
  { n: "01", label: "Movie nights" },
  { n: "02", label: "Social & Community" },
  { n: "03", label: "Long-distance" },
  { n: "04", label: "Communities" },
];

export function Hero() {
  const [i, setI] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1) % ROTATING.length), 2600);
    return () => clearInterval(t);
  }, []);

  return (
    <section className="relative overflow-hidden">
      {/* Cinematic background */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute inset-0 bg-[radial-gradient(120%_80%_at_70%_-10%,rgba(240,69,75,0.20),transparent_55%)]" />
        <div
          className="absolute inset-0 opacity-[0.25]"
          style={{
            backgroundImage:
              "repeating-linear-gradient(115deg, rgba(255,255,255,0.04) 0 2px, transparent 2px 26px), repeating-linear-gradient(65deg, rgba(255,255,255,0.03) 0 2px, transparent 2px 30px)",
            maskImage:
              "radial-gradient(90% 70% at 60% 20%, black, transparent 75%)",
          }}
        />
        <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-black" />
      </div>

      <div className="mx-auto max-w-7xl px-5 pt-40 pb-16 sm:px-8 sm:pt-44">
        <div className="max-w-2xl">
          <AnimatePresence mode="wait">
            <motion.span
              key={ROTATING[i].tag}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.4 }}
              className="inline-flex items-center gap-2 rounded-full border border-hairline bg-white/[0.03] px-3.5 py-1.5 text-[0.72rem] font-semibold tracking-[0.22em] text-white/80 backdrop-blur"
            >
              <span aria-hidden>{ROTATING[i].icon}</span>
              {ROTATING[i].tag}
            </motion.span>
          </AnimatePresence>

          <motion.h1
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.05, ease: [0.22, 1, 0.36, 1] }}
            className="mt-6 text-5xl font-extrabold leading-[0.98] tracking-tight sm:text-7xl"
          >
            Watch together, no matter where you are.
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.15 }}
            className="mt-6 max-w-xl text-lg leading-relaxed text-white/60"
          >
            Create a room, drop in a YouTube link, and everyone sees the same
            frame at the same time. Movie night, sorted.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.25 }}
            className="mt-6 flex flex-wrap gap-3"
          >
            <Chip icon="♥">Shared moments</Chip>
            <Chip icon="🌐">Anywhere in browser</Chip>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.35 }}
            className="mt-8 flex flex-col gap-3 sm:flex-row"
          >
            <Link
              href="/join"
              className="group inline-flex items-center justify-center gap-2 rounded-2xl bg-brand px-7 py-4 text-base font-semibold shadow-[0_16px_50px_-16px_rgba(240,69,75,0.9)] transition hover:bg-brand-bright active:scale-[0.98]"
            >
              Start Watching Free
              <span className="transition group-hover:translate-x-1">→</span>
            </Link>
            <Link
              href="/join"
              className="inline-flex items-center justify-center gap-2 rounded-2xl border border-hairline bg-white/[0.03] px-7 py-4 text-base font-semibold text-white/90 transition hover:bg-white/[0.06]"
            >
              Continue with Google
              <span className="text-white/40">›</span>
            </Link>
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.5 }}
            className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-white/45"
          >
            <span>No credit card</span>
            <span className="text-brand">•</span>
            <span>No download</span>
            <span className="text-brand">•</span>
            <span>Works in browser</span>
          </motion.div>
        </div>

        {/* Numbered cards */}
        <div className="mt-16 grid grid-cols-2 gap-3 sm:mt-20 sm:grid-cols-4">
          {CARDS.map((c, idx) => (
            <motion.div
              key={c.n}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.5 + idx * 0.08 }}
              className="rounded-2xl border border-hairline bg-white/[0.02] p-4 transition hover:border-brand/40 hover:bg-white/[0.04]"
            >
              <div className="font-mono text-xs text-white/40">{c.n}</div>
              <div className="mt-6 text-sm font-medium text-white/80">
                {c.label}
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Chip({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-hairline bg-white/[0.02] px-3.5 py-1.5 text-sm text-white/70">
      <span className="text-brand" aria-hidden>
        {icon}
      </span>
      {children}
    </span>
  );
}
