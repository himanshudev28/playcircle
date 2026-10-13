"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { AnimatePresence, motion } from "framer-motion";
import { useStillness } from "@/components/useStillness";
import { Button, LiveDot } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { GoogleMark } from "@/components/Icon";

const SLIDE_MS = 7000;

const SLIDES = [
  {
    kicker: "Movie nights",
    title: "Watch together, no matter where you are.",
    description:
      "Create a room, drop in a YouTube link, and everyone sees the same frame at the same time. Movie night, sorted.",
    image:
      "https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=1800&q=80",
    accent: "Tonight's pick",
    meta: ["4 friends joined", "Chat live", "Zero setup"],
  },
  {
    kicker: "Social & community",
    title: "Vent your thoughts. Send DMs. Chat with strangers.",
    description:
      "More than just watching together. Share what's on your mind on the public feed, send private messages, and meet people in the active lobby.",
    image:
      "https://images.unsplash.com/photo-1522071820081-009f0129c71c?auto=format&fit=crop&w=1800&q=80",
    accent: "Social space",
    meta: ["Vent thoughts", "Private DMs", "Talk to strangers"],
  },
  {
    kicker: "Long-distance",
    title: "One link. One room. Everyone in sync.",
    description:
      "Perfect for date nights, comfort rewatches, and staying close to the people who matter most.",
    image:
      "https://images.unsplash.com/photo-1517604931442-7e0c8ed2963c?auto=format&fit=crop&w=1800&q=80",
    accent: "Connected viewing",
    meta: ["Private room", "Invite in seconds", "Works on mobile"],
  },
  {
    kicker: "Communities",
    title: "Host watch parties your audience will love.",
    description:
      "Queue videos, react live, and give your community a shared viewing experience that feels effortless.",
    image:
      "https://images.unsplash.com/photo-1758599669742-e90b390b50bc?q=80&w=1800&auto=format&fit=crop",
    accent: "Room spotlight",
    meta: ["Queue ready", "Synced controls", "Shared reactions"],
  },
];

export function Hero() {
  const [i, setI] = useState(0);
  const reduce = useStillness();
  const slide = SLIDES[i];

  const go = useCallback((n: number) => setI(((n % SLIDES.length) + SLIDES.length) % SLIDES.length), []);

  /* An auto-advancing carousel is motion the reader didn't ask for, so it
     holds still when reduced motion is set. The segment controls still work. */
  useEffect(() => {
    if (reduce) return;
    const t = setTimeout(() => go(i + 1), SLIDE_MS);
    return () => clearTimeout(t);
  }, [i, go, reduce]);

  return (
    <section className="relative isolate flex min-h-dvh flex-col justify-end overflow-hidden">
      {/* Projected frame ------------------------------------------------ */}
      <div className="absolute inset-0 -z-10">
        <AnimatePresence initial={false}>
          <motion.div
            key={slide.image}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, scale: reduce ? 1 : 1.06 }}
            exit={{ opacity: 0 }}
            transition={{
              opacity: { duration: 1.1, ease: "easeInOut" },
              scale: { duration: SLIDE_MS / 1000 + 1.2, ease: "linear" },
            }}
            className="absolute inset-0"
          >
            <Image
              src={slide.image}
              alt=""
              fill
              priority={i === 0}
              sizes="100vw"
              className="object-cover"
            />
          </motion.div>
        </AnimatePresence>

        {/* Scrims: the frame has to stay legible without becoming a flat wash */}
        <div className="absolute inset-0 bg-linear-to-t from-ink via-ink/80 to-ink/25" />
        <div className="absolute inset-0 bg-linear-to-r from-ink via-ink/55 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-32 bg-linear-to-t from-ink to-transparent" />
      </div>

      <div className="mx-auto w-full max-w-7xl px-5 pb-10 pt-32 sm:px-8 sm:pb-14">
        <div className="grid items-end gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(300px,0.62fr)] lg:gap-10">
          {/* Copy -------------------------------------------------------- */}
          <div>
            {/* Kicker, headline and description are one unit — animating them
                separately lets them fall out of step mid-transition and show
                two different slides at once. */}
            <AnimatePresence mode="wait">
              <motion.div
                key={slide.kicker}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
              >
                <span className="inline-flex items-center gap-2.5 rounded-full border border-edge-strong bg-ink/50 px-4 py-2 backdrop-blur-md">
                  <LiveDot />
                  <span className="data text-bone/85">{slide.kicker}</span>
                </span>

                <h1 className="mt-6 max-w-3xl font-display text-[2.6rem] font-extrabold leading-[0.94] text-bone sm:text-6xl lg:text-7xl">
                  {slide.title}
                </h1>

                <p className="mt-6 max-w-xl text-base leading-8 text-smoke sm:text-lg">
                  {slide.description}
                </p>
              </motion.div>
            </AnimatePresence>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button href="/join" iconAfter="arrowRight">
                Start watching free
              </Button>
              <Button href="/join" variant="ghost">
                <GoogleMark />
                Continue with Google
              </Button>
            </div>

            <p className="mt-6 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-dim">
              <span>No credit card</span>
              <span className="text-signal">/</span>
              <span>No download</span>
              <span className="text-signal">/</span>
              <span>Works in your browser</span>
            </p>
          </div>

          {/* Room card, tilted into the frame ---------------------------- */}
          <div className="hidden perspective-[1400px] lg:block">
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.9, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="relative"
            >
              <div className="absolute inset-0 translate-x-5 translate-y-5 rounded-hero border border-signal/25 bg-signal/8 blur-[2px]" />
              <RoomCard slide={slide} />
            </motion.div>
          </div>
        </div>

        {/* Slide selector, drawn as a filmstrip of scrub segments -------- */}
        <div className="mt-12 flex items-center gap-3">
          {SLIDES.map((s, n) => (
            <button
              key={s.kicker}
              onClick={() => go(n)}
              aria-label={`Show ${s.kicker}`}
              aria-current={n === i}
              className="group relative h-1 flex-1 overflow-hidden rounded-full bg-bone/12"
            >
              <span
                className={`absolute inset-y-0 left-0 rounded-full bg-signal transition-[width] ${
                  n < i ? "w-full" : "w-0"
                }`}
              />
              {n === i && (
                <motion.span
                  key={`fill-${i}`}
                  initial={{ width: reduce ? "100%" : 0 }}
                  animate={{ width: "100%" }}
                  transition={{ duration: reduce ? 0 : SLIDE_MS / 1000, ease: "linear" }}
                  className="absolute inset-y-0 left-0 rounded-full bg-linear-to-r from-signal to-tungsten"
                />
              )}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

/* A small, honest picture of the actual product: title, timecode, a scrub bar
   with a shared playhead, who's in the room, and one line of chat. */
function RoomCard({ slide }: { slide: (typeof SLIDES)[number] }) {
  return (
    <div className="relative rounded-hero border border-edge bg-film/90 p-5 shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)] backdrop-blur-xl transform-[rotateZ(-5deg)_rotateX(9deg)]">
      <div className="flex items-center justify-between">
        <div>
          <p className="data text-dim">{slide.accent}</p>
          <p className="mt-1.5 font-display text-lg font-bold text-bone">
            Friday Night Room
          </p>
        </div>
        <span className="flex items-center gap-1.5 rounded-full bg-signal/12 px-2.5 py-1">
          <LiveDot />
          <span className="data text-signal">Live</span>
        </span>
      </div>

      <div className="mt-4 overflow-hidden rounded-panel border border-edge bg-ink">
        <div className="relative aspect-video">
          <Image
            src={slide.image}
            alt=""
            fill
            sizes="360px"
            className="object-cover opacity-55"
          />
          <div className="absolute inset-0 bg-linear-to-t from-ink via-ink/30 to-transparent" />
          <span className="absolute inset-0 m-auto grid h-12 w-12 place-items-center rounded-full bg-bone text-ink">
            <Icon name="play" size={18} className="ml-0.5" />
          </span>
        </div>

        <div className="p-3.5">
          <p className="truncate text-sm font-medium text-bone">
            Feel-good movie soundtrack session
          </p>
          <div className="mt-3 flex items-center gap-2.5">
            <span className="data tnum text-dim">12:04</span>
            <span className="relative h-1 flex-1 rounded-full bg-bone/12">
              <span className="absolute inset-y-0 left-0 w-2/5 rounded-full bg-signal" />
              <span className="absolute left-2/5 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-bone shadow-[0_0_8px_rgba(244,67,60,0.9)]" />
            </span>
            <span className="data tnum text-dim">31:47</span>
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <div className="flex -space-x-2">
          {["M", "L", "A", "J"].map((n, idx) => (
            <span
              key={n}
              className="grid h-7 w-7 place-items-center rounded-full border border-film text-[0.65rem] font-bold text-bone"
              style={{
                background: ["#3a2a28", "#2b2f38", "#37302a", "#2f2a35"][idx],
              }}
            >
              {n}
            </span>
          ))}
        </div>
        <span className="data text-dim">4 watching</span>
      </div>

      <div className="mt-3.5 rounded-card border border-edge bg-ink/60 px-3.5 py-2.5">
        <p className="text-[0.8rem] leading-relaxed">
          <span className="text-dim">Maya</span>{" "}
          <span className="text-bone/90">this part gets me every time</span>
        </p>
      </div>
    </div>
  );
}
