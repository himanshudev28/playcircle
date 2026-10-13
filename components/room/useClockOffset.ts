"use client";

import { useCallback, useEffect, useRef } from "react";
import { getSocket } from "@/lib/socket";

/* The server stamps every playhead with its own clock (`at`). To know where
   the room is *now* we need that clock here: server time ≈ Date.now() +
   offset. NTP-style — a few round-trips, trust the fastest one, since the
   shortest trip has the least room for asymmetric delay. Re-measured on
   every (re)connect and every 30s so a sleeping laptop can't drift off. */

const ROUNDS = 3;
const EVERY_MS = 30_000;
const PING_TIMEOUT_MS = 4_000;

type Sample = { rtt: number; offset: number };

function pingOnce(): Promise<Sample | null> {
  const socket = getSocket();
  return new Promise((resolve) => {
    const sent = Date.now();
    // A payload is required: the server treats a bare function as the
    // payload, not the ack.
    socket
      .timeout(PING_TIMEOUT_MS)
      .emit("time:ping", {}, (err: Error | null, res?: { now?: number }) => {
        const got = Date.now();
        if (err || typeof res?.now !== "number") return resolve(null);
        const rtt = got - sent;
        resolve({ rtt, offset: res.now + rtt / 2 - got });
      });
  });
}

/** Returns a stable `serverNow()` — the server's clock, in ms. */
export function useClockOffset(): () => number {
  const offsetRef = useRef(0);

  useEffect(() => {
    const socket = getSocket();
    let running = false;
    let disposed = false;

    const measure = async () => {
      if (running || !socket.connected) return;
      running = true;
      let best: Sample | null = null;
      for (let i = 0; i < ROUNDS; i++) {
        const s = await pingOnce();
        if (disposed) return;
        if (s && (!best || s.rtt < best.rtt)) best = s;
      }
      running = false;
      if (best) offsetRef.current = best.offset;
    };

    socket.on("connect", measure);
    if (socket.connected) measure();
    const id = setInterval(measure, EVERY_MS);
    return () => {
      disposed = true;
      socket.off("connect", measure);
      clearInterval(id);
    };
  }, []);

  return useCallback(() => Date.now() + offsetRef.current, []);
}
