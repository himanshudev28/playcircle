"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { AppHeader } from "@/components/AppHeader";
import { getSocket, type LobbyRoom } from "@/lib/socket";

export default function LobbyPage() {
  const router = useRouter();
  const [rooms, setRooms] = useState<LobbyRoom[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const socket = getSocket();
    const onList = (list: LobbyRoom[]) => {
      setRooms(list);
      setLoaded(true);
    };
    socket.on("lobby:list", onList);

    const subscribe = () => socket.emit("lobby:subscribe");
    socket.on("connect", subscribe);
    if (socket.connected) subscribe();

    return () => {
      socket.emit("lobby:unsubscribe");
      socket.off("lobby:list", onList);
      socket.off("connect", subscribe);
    };
  }, []);

  function joinRoom(code: string) {
    const hasName =
      typeof window !== "undefined" && localStorage.getItem("wnp-name");
    if (!hasName) {
      router.push(`/join?next=${encodeURIComponent(code)}`);
      return;
    }
    router.push(`/room/${code}`);
  }

  return (
    <div className="min-h-screen">
      <AppHeader active="lobby" />
      <main className="mx-auto max-w-6xl px-5 py-12 sm:px-8">
        <div className="flex items-end justify-between gap-4">
          <div>
            <div className="kicker text-brand">Public lobbies</div>
            <h1 className="mt-3 text-4xl font-extrabold tracking-tight sm:text-5xl">
              Jump into a live room.
            </h1>
            <p className="mt-3 max-w-lg text-white/55">
              Open watch parties happening right now. Drop into any room and
              start watching with strangers.
            </p>
          </div>
          <span className="hidden items-center gap-2 rounded-full border border-hairline bg-white/[0.03] px-4 py-2 text-sm text-white/60 sm:flex">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
            {rooms.length} live
          </span>
        </div>

        <div className="mt-10">
          {!loaded ? (
            <p className="text-white/40">Loading live rooms…</p>
          ) : rooms.length === 0 ? (
            <EmptyLobby />
          ) : (
            <motion.div
              layout
              className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
            >
              <AnimatePresence>
                {rooms.map((r) => (
                  <motion.button
                    layout
                    key={r.code}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    onClick={() => joinRoom(r.code)}
                    className="group overflow-hidden rounded-2xl border border-hairline bg-panel text-left transition hover:-translate-y-1 hover:border-brand/40"
                  >
                    <div className="relative aspect-video overflow-hidden bg-black">
                      {r.videoId ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={`https://img.youtube.com/vi/${r.videoId}/mqdefault.jpg`}
                          alt=""
                          className="h-full w-full object-cover opacity-90 transition group-hover:opacity-100"
                        />
                      ) : (
                        <div className="grid h-full place-items-center text-3xl">
                          🎬
                        </div>
                      )}
                      <span className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-xs font-semibold backdrop-blur">
                        <span className="h-1.5 w-1.5 rounded-full bg-brand" />
                        {r.isPlaying ? "Playing" : "Paused"}
                      </span>
                      <span className="absolute right-3 top-3 rounded-full bg-black/70 px-2.5 py-1 text-xs font-semibold backdrop-blur">
                        {r.count} watching
                      </span>
                    </div>
                    <div className="p-4">
                      <div className="truncate font-semibold">{r.title}</div>
                      <div className="mt-1 font-mono text-xs text-white/40">
                        {r.code}
                      </div>
                      <div className="mt-3 flex items-center justify-between">
                        <div className="flex -space-x-2">
                          {r.hosts.map((h, i) => (
                            <span
                              key={i}
                              className="grid h-7 w-7 place-items-center rounded-full border-2 border-panel text-xs font-bold text-black"
                              style={{ background: h.color }}
                            >
                              {h.name[0]?.toUpperCase()}
                            </span>
                          ))}
                        </div>
                        <span className="text-sm font-semibold text-brand opacity-0 transition group-hover:opacity-100">
                          Join →
                        </span>
                      </div>
                    </div>
                  </motion.button>
                ))}
              </AnimatePresence>
            </motion.div>
          )}
        </div>
      </main>
    </div>
  );
}

function EmptyLobby() {
  return (
    <div className="rounded-3xl border border-dashed border-hairline bg-white/[0.02] py-16 text-center">
      <div className="text-4xl">🍿</div>
      <h2 className="mt-4 text-xl font-bold">No public rooms right now</h2>
      <p className="mx-auto mt-2 max-w-sm text-sm text-white/50">
        Be the first — create a room and toggle{" "}
        <span className="text-white/70">“List in public lobby”</span> so others
        can find it.
      </p>
      <Link
        href="/join"
        className="mt-6 inline-block rounded-xl bg-brand px-6 py-3 font-semibold transition hover:bg-brand-bright"
      >
        Create a public room
      </Link>
    </div>
  );
}
