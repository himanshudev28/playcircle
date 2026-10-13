"use client";

import { useEffect, useRef, useState } from "react";
import { animate, useInView, useReducedMotion } from "framer-motion";
import { LiveDot } from "@/components/ui";

/* One rail, not four cards. These are instrument readings taken off the same
   machine, so they share a housing and are separated by hairlines. */
const STATS = [
  { to: 50, suffix: "K+", label: "Shared sessions" },
  { to: 4.9, suffix: "/5", label: "Average rating", decimals: 1 },
  { to: 120, suffix: "+", label: "Countries" },
  { text: "<50ms", label: "Typical sync delay", live: true },
];

function Counter({
  to,
  suffix,
  decimals = 0,
}: {
  to: number;
  suffix: string;
  decimals?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });
  const reduce = useReducedMotion();
  const [val, setVal] = useState(0);

  useEffect(() => {
    if (!inView) return;
    if (reduce) {
      setVal(to);
      return;
    }
    const controls = animate(0, to, {
      duration: 1.4,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: setVal,
    });
    return () => controls.stop();
  }, [inView, to, reduce]);

  return (
    <span ref={ref}>
      {val.toFixed(decimals)}
      {suffix}
    </span>
  );
}

export function Stats() {
  return (
    <section className="mx-auto max-w-5xl px-5 pb-24 sm:px-8">
      <div className="grid grid-cols-2 divide-edge overflow-hidden rounded-hero border border-edge bg-film/60 backdrop-blur-sm sm:grid-cols-4 sm:divide-x">
        {STATS.map((s) => (
          <div key={s.label} className="px-6 py-7 text-center">
            <div className="font-mono text-2xl font-semibold tracking-tight text-bone tnum sm:text-3xl">
              {"text" in s ? (
                s.text
              ) : (
                <Counter to={s.to} suffix={s.suffix} decimals={s.decimals} />
              )}
            </div>
            <div className="mt-2.5 flex items-center justify-center gap-1.5">
              {s.live && <LiveDot />}
              <span className="data text-dim">{s.label}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
