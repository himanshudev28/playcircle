"use client";

import { io, type Socket } from "socket.io-client";

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      autoConnect: true,
      transports: ["websocket", "polling"],
    });
  }
  return socket;
}

export type CallState = { mic: boolean; cam: boolean };

export type RoomUser = {
  id: string;
  name: string;
  color: string;
  /** Opaque per-browser tag: equal for two tabs of the same browser. */
  browser: string;
  /** Present when this person is in the room's voice/video call. */
  call: CallState | null;
};

export type DeniedReason = "removed" | "locked" | "ended";

/* A random id per browser, kept in localStorage. Socket ids change on every
   reconnect; this is what lets a host refresh without losing the crown, and
   what a removal is keyed on. */
let pageClientId: string | null = null;

export function getClientId(): string {
  const KEY = "wnp-cid";
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return saved;
  } catch {
    /* storage blocked — fall through to a per-page id */
  }
  // Generated once per page load, so even without storage two browsers never
  // share an id (a shared id would mean shared host rights and shared bans).
  if (!pageClientId) {
    pageClientId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  try {
    localStorage.setItem(KEY, pageClientId);
  } catch {
    /* fine — this page keeps using pageClientId */
  }
  return pageClientId;
}

export type ChatMessage = {
  id: string;
  name?: string;
  color?: string;
  text: string;
  ts: number;
  system?: boolean;
};

export type PlayerAction = {
  type: "load" | "play" | "pause" | "seek";
  time?: number;
  videoId?: string | null;
  isPlaying?: boolean;
  by?: string;
};

export type LobbyRoom = {
  code: string;
  title: string;
  videoId: string | null;
  isPlaying: boolean;
  count: number;
  hosts: { name: string; color: string }[];
};

export type Vent = {
  id: string;
  alias: string;
  emoji: string;
  text: string;
  ts: number;
};
