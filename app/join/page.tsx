"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Logo } from "@/components/Logo";
import { makeRoomCode } from "@/lib/youtube";

export default function JoinPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [title, setTitle] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const saved = localStorage.getItem("wnp-name");
    if (saved) setName(saved);
  }, []);

  function persistName(): string | null {
    const n = name.trim();
    if (!n) {
      setError("Pick a display name first.");
      return null;
    }
    localStorage.setItem("wnp-name", n);
    return n;
  }

  function createRoom() {
    if (!persistName()) return;
    const params = new URLSearchParams();
    if (title.trim()) params.set("title", title.trim());
    if (isPublic) params.set("public", "1");
    const qs = params.toString();
    router.push(`/room/${makeRoomCode()}${qs ? `?${qs}` : ""}`);
  }

  function joinRoom() {
    if (!persistName()) return;
    const c = code.trim().toUpperCase();
    if (!c) {
      setError("Enter a room code to join.");
      return;
    }
    const normalized = c.startsWith("WNP-") ? c : `WNP-${c}`;
    router.push(`/room/${normalized}`);
  }

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden px-5">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(90%_60%_at_50%_-10%,rgba(240,69,75,0.18),transparent_60%)]" />
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-md"
      >
        <div className="mb-8 flex justify-center">
          <Logo size="lg" />
        </div>

        <div className="rounded-3xl border border-hairline bg-panel/80 p-7 backdrop-blur">
          <h1 className="text-2xl font-bold">Start watching together</h1>
          <p className="mt-2 text-sm text-white/55">
            No account needed — pick a name and open a room.
          </p>

          <label className="mt-6 block text-sm font-medium text-white/70">
            Display name
          </label>
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError("");
            }}
            placeholder="e.g. Maya"
            maxLength={24}
            className="mt-2 w-full rounded-xl border border-hairline bg-black/40 px-4 py-3 outline-none transition focus:border-brand"
          />

          <label className="mt-5 block text-sm font-medium text-white/70">
            Room name{" "}
            <span className="font-normal text-white/35">(optional)</span>
          </label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Friday Night Room"
            maxLength={60}
            className="mt-2 w-full rounded-xl border border-hairline bg-black/40 px-4 py-3 outline-none transition focus:border-brand"
          />

          <button
            type="button"
            onClick={() => setIsPublic((v) => !v)}
            className="mt-4 flex w-full items-center gap-3 rounded-xl border border-hairline bg-black/30 px-4 py-3 text-left transition hover:bg-white/[0.03]"
          >
            <span
              className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                isPublic ? "bg-brand" : "bg-white/15"
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                  isPublic ? "left-[22px]" : "left-0.5"
                }`}
              />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                List in public lobby
              </span>
              <span className="block text-xs text-white/45">
                {isPublic
                  ? "Anyone can discover and join this room."
                  : "Private — only people with the code can join."}
              </span>
            </span>
          </button>

          <button
            onClick={createRoom}
            className="mt-5 w-full rounded-xl bg-brand px-5 py-3.5 font-semibold shadow-[0_16px_50px_-16px_rgba(240,69,75,0.9)] transition hover:bg-brand-bright active:scale-[0.98]"
          >
            Create a new room →
          </button>

          <div className="my-5 flex items-center gap-3 text-xs text-white/30">
            <span className="h-px flex-1 bg-hairline" />
            OR JOIN EXISTING
            <span className="h-px flex-1 bg-hairline" />
          </div>

          <div className="flex gap-2">
            <input
              value={code}
              onChange={(e) => {
                setCode(e.target.value.toUpperCase());
                setError("");
              }}
              placeholder="WNP-XXXX"
              className="w-full rounded-xl border border-hairline bg-black/40 px-4 py-3 font-mono uppercase tracking-wider outline-none transition focus:border-brand"
              onKeyDown={(e) => e.key === "Enter" && joinRoom()}
            />
            <button
              onClick={joinRoom}
              className="shrink-0 rounded-xl border border-hairline bg-white/[0.04] px-5 py-3 font-semibold transition hover:bg-white/[0.08]"
            >
              Join
            </button>
          </div>

          {error && <p className="mt-4 text-sm text-brand">{error}</p>}
        </div>

        <div className="mt-6 flex items-center justify-center gap-4 text-sm">
          <Link href="/lobby" className="text-white/60 transition hover:text-white">
            🎉 Browse public lobbies
          </Link>
          <span className="text-white/20">•</span>
          <Link href="/vent" className="text-white/60 transition hover:text-white">
            🕶️ Anonymous board
          </Link>
        </div>
        <p className="mt-4 text-center text-xs text-white/35">
          No account needed — this demo uses a guest display name.
        </p>
      </motion.div>
    </main>
  );
}
