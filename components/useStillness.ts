"use client";

import { useEffect, useState } from "react";
import { useReducedMotion } from "framer-motion";

/**
 * True when the reader has asked for reduced motion — but only after mount.
 *
 * The media query is unavailable during SSR, so reading it during the first
 * client render would make the markup disagree with the server and trip a
 * hydration mismatch. Gating on mount keeps that first render identical and
 * settles into stillness a tick later.
 */
export function useStillness() {
  const reduce = useReducedMotion();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  return mounted && Boolean(reduce);
}
