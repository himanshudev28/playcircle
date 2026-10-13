"use client";

import { motion, useScroll, useSpring, useTransform } from "framer-motion";

/* The product's whole idea is a shared playhead. So the page is a timeline:
   this is the scrub bar, and you are the playhead. It doubles as an honest
   reading-progress indicator, which is why it earns its fixed position. */
export function ScrubRibbon() {
  const { scrollYProgress } = useScroll();
  const progress = useSpring(scrollYProgress, {
    stiffness: 260,
    damping: 40,
    restDelta: 0.001,
  });
  const left = useTransform(progress, (v) => `${v * 100}%`);

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-70 h-0.75 bg-bone/6"
      aria-hidden
    >
      <motion.div
        style={{ scaleX: progress }}
        className="h-full origin-left bg-linear-to-r from-signal-deep via-signal to-tungsten"
      />
      <motion.span
        style={{ left }}
        className="absolute top-1/2 -ml-0.75 h-1.75 w-1.75 -translate-y-1/2 rounded-full bg-tungsten shadow-[0_0_10px_2px_rgba(240,168,60,0.55)]"
      />
    </div>
  );
}
