"use client";

/* The ICE server list for every RTCPeerConnection, from /api/ice (which can
   add a TURN relay without putting its secret in the bundle). Fetched once
   when a room opens — well before anyone calls or shares — and refreshed now
   and then, since relay credentials can be short-lived. Until it arrives,
   plain STUN. */

import { REALTIME_URL } from "./socket";

const STUN: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];
const REFRESH = 5 * 60_000;

let servers: RTCIceServer[] = STUN;
let fetchedAt = 0;
let pending: Promise<RTCIceServer[]> | null = null;

export function prefetchIce(): Promise<RTCIceServer[]> {
  if (Date.now() - fetchedAt < REFRESH) return Promise.resolve(servers);
  if (pending) return pending;
  pending = fetch(`${REALTIME_URL}/api/ice`, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((body) => {
      if (Array.isArray(body?.iceServers) && body.iceServers.length) {
        servers = body.iceServers;
        fetchedAt = Date.now();
      }
      return servers;
    })
    .catch(() => servers)
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** The current list; also kicks off a refresh when it's getting old. */
export function iceServers(): RTCIceServer[] {
  void prefetchIce();
  return servers;
}
