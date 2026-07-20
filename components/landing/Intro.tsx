"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

export function Intro() {
  const [show, setShow] = useState(true);
  const [phase, setPhase] = useState<0 | 1>(0);

  useEffect(() => {
    if (typeof window !== "undefined" && sessionStorage.getItem("wnp-intro")) {
      setShow(false);
      return;
    }
    const t1 = setTimeout(() => setPhase(1), 1400);
    const t2 = setTimeout(() => {
      setShow(false);
      sessionStorage.setItem("wnp-intro", "1");
    }, 2600);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          exit={{ opacity: 0 }}
          transition={{ duration: 0.6 }}
          className="fixed inset-0 z-[100] grid place-items-center bg-black"
        >
          <AnimatePresence mode="wait">
            {phase === 0 ? (
              <motion.div
                key="loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex flex-col items-center gap-8"
              >
                <p className="text-xl text-white/85">
                  Getting things ready for you…
                </p>
                <div className="flex flex-col items-center gap-3">
                  <span className="h-8 w-8 animate-spin rounded-full border-2 border-white/15 border-t-brand" />
                  <span className="kicker text-white/40">Loading</span>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="logo"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex items-center gap-3"
              >
                <span className="grid h-12 w-12 place-items-center rounded-full bg-white text-black">
                  <svg width={20} height={20} viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </span>
                <span className="text-3xl font-extrabold tracking-tight">
                  watch<span className="text-brand">n</span>party
                </span>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
