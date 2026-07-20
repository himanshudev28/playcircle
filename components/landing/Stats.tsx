"use client";

import { useEffect, useRef, useState } from "react";
import {
  animate,
  motion,
  useInView,
  useReducedMotion,
} from "framer-motion";

const STATS = [
  { to: 50, suffix: "K+", label: "Shared sessions" },
  { to: 4.9, suffix: "/5", label: "Average rating", decimals: 1 },
  { to: 120, suffix: "+", label: "Countries" },
  { text: "<50ms", label: "Typical sync delay" },
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
      onUpdate: (v) => setVal(v),
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
    <section className="mx-auto max-w-7xl px-5 pb-24 sm:px-8">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {STATS.map((s, i) => (
          <motion.div
            key={s.label}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.6, delay: i * 0.08 }}
            className="rounded-3xl border border-hairline bg-gradient-to-b from-white/[0.04] to-transparent p-6"
          >
            <div className="text-4xl font-extrabold tracking-tight sm:text-5xl">
              {"text" in s ? (
                s.text
              ) : (
                <Counter to={s.to} suffix={s.suffix} decimals={s.decimals} />
              )}
            </div>
            <div className="mt-2 text-sm text-white/50">{s.label}</div>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
