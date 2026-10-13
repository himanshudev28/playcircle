"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { useStillness } from "@/components/useStillness";

export function Reveal({
  children,
  delay = 0,
  y = 24,
  className,
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
}) {
  const still = useStillness();

  /* With reduced motion the content is simply present — no entrance, and no
     dependency on the viewport observer firing for it to become readable. */
  if (still) {
    return (
      <motion.div
        className={className}
        initial={false}
        animate={{ opacity: 1, y: 0 }}
      >
        {children}
      </motion.div>
    );
  }

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.7, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}
