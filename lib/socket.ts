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

export type RoomUser = { id: string; name: string; color: string };

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
