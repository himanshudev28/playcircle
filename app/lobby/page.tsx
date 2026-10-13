"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { AppHeader } from "@/components/AppHeader";
import { Button, LiveDot, SectionMarker } from "@/components/ui";
import { Icon } from "@/components/Icon";
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
    router.push(hasName ? `/room/${code}` : `/join?next=${encodeURIComponent(code)}`);
  }

  return (
    <div className="min-h-dvh">
      <AppHeader active="lobby" />

      <main className="mx-auto max-w-6xl px-5 py-14 sm:px-8">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <SectionMarker time="LIVE" label="Public lobby" />
            <h1 className="mt-5 font-display text-4xl font-extrabold text-bone sm:text-5xl">
              Jump into a live room.
            </h1>
            <p className="mt-4 max-w-lg leading-8 text-smoke">
              Open watch parties happening right now. Drop into any room and
              start watching with people who are already there.
            </p>
          </div>

          <span className="flex items-center gap-2 rounded-full border border-edge bg-film px-4 py-2">
            <LiveDot />
            <span className="data text-smoke tnum">
              {rooms.length} {rooms.length === 1 ? "room" : "rooms"}
            </span>
          </span>
        </div>

        <div className="mt-12">
          {!loaded ? (
            <p className="data text-dim">Loading live rooms…</p>
          ) : rooms.length === 0 ? (
            <EmptyLobby />
          ) : (
            <motion.div layout className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <AnimatePresence>
                {rooms.map((r) => (
                  <motion.button
                    layout
                    key={r.code}
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.96 }}
                    onClick={() => joinRoom(r.code)}
                    className="group overflow-hidden rounded-panel border border-edge bg-film text-left transition-colors hover:border-edge-strong"
                  >
                    <div className="relative aspect-video overflow-hidden bg-ink">
                      {r.videoId ? (
                        <Image
                          src={`https://i.ytimg.com/vi/${r.videoId}/mqdefault.jpg`}
                          alt=""
                          fill
                          sizes="(max-width: 640px) 100vw, 360px"
                          className="object-cover opacity-85 transition-opacity group-hover:opacity-100"
                        />
                      ) : (
                        <div className="grid h-full place-items-center text-dim">
                          <Icon name="film" size={26} />
                        </div>
                      )}

                      <span className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-ink/80 px-2.5 py-1 backdrop-blur">
                        {r.isPlaying && <LiveDot />}
                        <span className="data text-bone">
                          {r.isPlaying ? "Playing" : "Paused"}
                        </span>
                      </span>
                      <span className="absolute right-3 top-3 rounded-full bg-ink/80 px-2.5 py-1 backdrop-blur">
                        <span className="data text-bone tnum">
                          {r.count} watching
                        </span>
                      </span>
                    </div>

                    <div className="p-4">
                      <p className="truncate font-display font-bold text-bone">
                        {r.title}
                      </p>
                      <p className="mt-1 font-mono text-[0.7rem] tracking-widest text-dim">
                        {r.code}
                      </p>

                      <div className="mt-4 flex items-center justify-between">
                        <div className="flex -space-x-2">
                          {r.hosts.map((h, i) => (
                            <span
                              key={i}
                              className="grid h-7 w-7 place-items-center rounded-full border-2 border-film text-xs font-bold text-ink"
                              style={{ background: h.color }}
                            >
                              {h.name[0]?.toUpperCase()}
                            </span>
                          ))}
                        </div>
                        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-signal opacity-0 transition-opacity group-hover:opacity-100">
                          Join
                          <Icon name="arrowRight" size={15} />
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
    <div className="rounded-hero border border-dashed border-edge-strong py-16 text-center">
      <span className="mx-auto grid h-12 w-12 place-items-center rounded-full border border-edge bg-film text-dim">
        <Icon name="door" size={22} />
      </span>
      <h2 className="mt-5 font-display text-xl font-bold text-bone">
        No public rooms right now
      </h2>
      <p className="mx-auto mt-2.5 max-w-sm leading-7 text-smoke">
        Create a room and turn on{" "}
        <span className="text-bone">List in the public lobby</span> so other
        people can find it.
      </p>
      <div className="mt-7 flex justify-center">
        <Button href="/join" size="md">
          Create a public room
        </Button>
      </div>
    </div>
  );
}
