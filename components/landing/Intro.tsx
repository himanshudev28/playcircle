"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

/* A projector strike, not a loading screen: the lamp warms, the mark resolves,
   it gets out of the way. ~1.2s, once per session, skippable, and skipped
   outright when reduced motion is requested — an intro should never be the
   reason someone waits to read the page. */
const KEY = "wnp-intro";

export function Intro() {
  const reduce = useReducedMotion();
  const [show, setShow] = useState(true);

  useEffect(() => {
    if (reduce || sessionStorage.getItem(KEY)) {
      setShow(false);
      return;
    }
    const dismiss = () => {
      setShow(false);
      sessionStorage.setItem(KEY, "1");
    };
    const t = setTimeout(dismiss, 1200);
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", dismiss);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", dismiss);
    };
  }, [reduce]);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          exit={{ opacity: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="fixed inset-0 z-90 grid place-items-center bg-ink"
        >
          {/* lamp bloom */}
          <motion.div
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.9, ease: "easeOut" }}
            className="absolute h-136 w-136 rounded-full blur-3xl"
            style={{
              background:
                "radial-gradient(circle, rgba(240,168,60,0.22), rgba(244,67,60,0.10) 45%, transparent 70%)",
            }}
          />

          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.15 }}
            className="relative flex items-center gap-3"
          >
            <svg width={38} height={38} viewBox="0 0 32 32" aria-hidden>
              <circle
                cx="16"
                cy="16"
                r="14"
                fill="none"
                stroke="var(--color-bone)"
                strokeOpacity="0.22"
                strokeWidth="1.6"
              />
              <motion.circle
                cx="16"
                cy="16"
                r="7.5"
                fill="var(--color-signal)"
                initial={{ scale: 0.4, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 0.55, delay: 0.25, ease: [0.22, 1, 0.36, 1] }}
                style={{ transformOrigin: "center" }}
              />
            </svg>
            <span className="font-display text-3xl font-extrabold text-bone">
              Play<span className="text-signal">Circle</span>
            </span>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
