"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Reveal } from "@/components/Reveal";

const BULLETS = [
  "Private room links that are easy to share",
  "Sync playback that keeps everyone together",
  "Live chat for reactions as they happen",
  "Simple on mobile and desktop browsers",
];

export function RoomPreview() {
  return (
    <section className="relative mx-auto max-w-7xl px-5 py-24 sm:px-8">
      <div className="grid items-center gap-12 lg:grid-cols-2">
        <div>
          <Reveal>
            <div className="kicker text-brand">Ready when you are</div>
          </Reveal>
          <Reveal delay={0.05}>
            <h2 className="mt-4 text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl">
              Open a room.
              <br />
              Bring everyone in.
            </h2>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="mt-5 max-w-md text-base leading-relaxed text-white/55">
              No big setup and no pressure. Just a simple way to share the same
              screen, the same jokes, and the same moment with people who matter
              to you.
            </p>
          </Reveal>
          <Reveal delay={0.15}>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/join"
                className="inline-flex items-center justify-center gap-2 rounded-2xl bg-brand px-7 py-4 font-semibold shadow-[0_16px_50px_-16px_rgba(240,69,75,0.9)] transition hover:bg-brand-bright active:scale-[0.98]"
              >
                Create Free Account →
              </Link>
              <Link
                href="/join"
                className="inline-flex items-center justify-center gap-2 rounded-2xl border border-hairline bg-white/[0.03] px-7 py-4 font-semibold text-white/90 transition hover:bg-white/[0.06]"
              >
                Continue with Google
              </Link>
            </div>
          </Reveal>
          <Reveal delay={0.2}>
            <ul className="mt-8 space-y-3">
              {BULLETS.map((b) => (
                <li
                  key={b}
                  className="flex items-center gap-3 text-sm text-white/65"
                >
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand/15 text-[0.7rem] text-brand">
                    ✓
                  </span>
                  {b}
                </li>
              ))}
            </ul>
          </Reveal>
        </div>

        {/* Room mockup */}
        <Reveal delay={0.1}>
          <motion.div
            initial={{ rotate: -1 }}
            whileHover={{ rotate: 0, scale: 1.01 }}
            transition={{ type: "spring", stiffness: 200, damping: 20 }}
            className="overflow-hidden rounded-3xl border border-hairline bg-panel shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-hairline px-5 py-4">
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-full bg-brand/70" />
                <span className="h-3 w-3 rounded-full bg-white/20" />
                <span className="h-3 w-3 rounded-full bg-white/20" />
              </div>
              <span className="kicker text-white/40">Room Preview</span>
            </div>
            <div className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-lg font-bold">Friday Night Room</div>
                  <div className="font-mono text-xs text-white/40">WNP-204</div>
                </div>
                <span className="flex items-center gap-1.5 rounded-full bg-brand/15 px-3 py-1 text-xs font-semibold text-brand">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
                  LIVE
                </span>
              </div>

              <div className="relative mt-4 aspect-video overflow-hidden rounded-2xl bg-gradient-to-br from-brand/25 via-black to-black">
                <div className="absolute inset-0 grid place-items-center">
                  <span className="grid h-16 w-16 place-items-center rounded-full bg-white/90 text-black shadow-2xl">
                    <svg width={22} height={22} viewBox="0 0 24 24" fill="currentColor">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </span>
                </div>
                <div className="absolute bottom-3 left-4 right-4">
                  <div className="kicker text-white/60">Now Playing</div>
                  <div className="mt-1 truncate text-sm font-medium">
                    Feel-good movie soundtrack session
                  </div>
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/15">
                    <div className="h-full w-1/3 rounded-full bg-brand" />
                  </div>
                </div>
              </div>

              <div className="mt-4 space-y-2">
                {[
                  { u: "Maya", m: "this part gets me every time 😭", c: "bg-brand/20" },
                  { u: "Leo", m: "wait rewind rewind", c: "bg-white/10" },
                ].map((row) => (
                  <div key={row.u} className="flex items-start gap-2 text-sm">
                    <span
                      className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold ${row.c}`}
                    >
                      {row.u[0]}
                    </span>
                    <div>
                      <span className="text-white/50">{row.u} </span>
                      <span className="text-white/85">{row.m}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        </Reveal>
      </div>
    </section>
  );
}
