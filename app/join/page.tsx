"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { Logo } from "@/components/Logo";
import { Icon } from "@/components/Icon";
import { makeRoomCode } from "@/lib/youtube";

// Reading the URL (`?next=` from an invite link) makes this part client-only,
// so it sits in a Suspense boundary and the rest of the route can prerender.
export default function JoinPage() {
  return (
    <Suspense fallback={<main className="min-h-dvh" />}>
      <JoinForm />
    </Suspense>
  );
}

// `?next=PC-XXXX` arrives when someone opens a room link without a name yet.
function inviteCode(raw: string | null): string | null {
  const c = (raw || "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 16);
  return c || null;
}

function JoinForm() {
  const router = useRouter();
  const invite = inviteCode(useSearchParams().get("next"));
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
      setError("Enter a display name so people know who joined.");
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
    router.push(`/room/${c.startsWith("PC-") ? c : `PC-${c}`}`);
  }

  function joinInvite() {
    if (!invite || !persistName()) return;
    router.push(`/room/${invite}`);
  }

  const field =
    "mt-2 w-full rounded-card border border-edge bg-ink px-4 py-3 text-bone placeholder:text-faint outline-none transition-colors focus:border-signal/60";

  if (invite) {
    return (
      <main className="relative grid min-h-dvh place-items-center overflow-hidden px-5 py-16">
        <div
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            background:
              "radial-gradient(90% 60% at 50% -10%, rgba(244,67,60,0.16), transparent 60%)",
          }}
        />
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="w-full max-w-md"
        >
          <div className="mb-8 flex justify-center">
            <Logo size="lg" />
          </div>

          <div className="rounded-hero border border-edge bg-film/85 p-7 backdrop-blur-xl">
            <p className="data text-signal">You&apos;re invited</p>
            <h1 className="mt-2 font-display text-2xl font-extrabold text-bone">
              Join the watch party
            </h1>
            <p className="mt-2 text-smoke">
              Pick a name so people know who joined.
            </p>

            <div className="mt-6 flex items-center justify-between rounded-card border border-edge bg-ink px-4 py-3">
              <span className="text-sm text-dim">Room</span>
              <span className="font-mono tracking-widest text-bone">{invite}</span>
            </div>

            <label htmlFor="name" className="mt-5 block text-sm font-medium text-bone">
              Display name
            </label>
            <input
              id="name"
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError("");
              }}
              onKeyDown={(e) => e.key === "Enter" && joinInvite()}
              placeholder="e.g. Maya"
              maxLength={24}
              className={field}
            />

            <button
              onClick={joinInvite}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-card bg-signal px-5 py-3.5 font-semibold text-white shadow-[0_10px_40px_-12px_rgba(244,67,60,0.75)] transition-colors hover:bg-signal-hot active:scale-[0.98]"
            >
              Join room
              <Icon name="arrowRight" size={18} />
            </button>

            {error && (
              <p role="alert" className="mt-4 text-sm text-signal">
                {error}
              </p>
            )}
          </div>

          <p className="mt-7 text-center text-sm">
            <Link
              href="/join"
              className="text-smoke transition-colors hover:text-bone"
            >
              Start your own room instead
            </Link>
          </p>
        </motion.div>
      </main>
    );
  }

  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden px-5 py-16">
      <div
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(90% 60% at 50% -10%, rgba(244,67,60,0.16), transparent 60%)",
        }}
      />

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-md"
      >
        <div className="mb-8 flex justify-center">
          <Logo size="lg" />
        </div>

        <div className="rounded-hero border border-edge bg-film/85 p-7 backdrop-blur-xl">
          <h1 className="font-display text-2xl font-extrabold text-bone">
            Start watching together
          </h1>
          <p className="mt-2 text-smoke">
            No account needed — pick a name and open a room.
          </p>

          <label htmlFor="name" className="mt-7 block text-sm font-medium text-bone">
            Display name
          </label>
          <input
            id="name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError("");
            }}
            placeholder="e.g. Maya"
            maxLength={24}
            className={field}
          />

          <label htmlFor="title" className="mt-5 block text-sm font-medium text-bone">
            Room name <span className="font-normal text-dim">(optional)</span>
          </label>
          <input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Friday Night Room"
            maxLength={60}
            className={field}
          />

          <button
            type="button"
            onClick={() => setIsPublic((v) => !v)}
            role="switch"
            aria-checked={isPublic}
            className="mt-5 flex w-full items-center gap-3.5 rounded-card border border-edge bg-ink px-4 py-3.5 text-left transition-colors hover:border-edge-strong"
          >
            <span
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                isPublic ? "bg-signal" : "bg-bone/15"
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-bone transition-all ${
                  isPublic ? "left-[22px]" : "left-0.5"
                }`}
              />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-bone">
                List in the public lobby
              </span>
              <span className="block text-[0.8rem] text-dim">
                {isPublic
                  ? "Anyone can find and join this room."
                  : "Private — only people with the code can join."}
              </span>
            </span>
          </button>

          <button
            onClick={createRoom}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-card bg-signal px-5 py-3.5 font-semibold text-white shadow-[0_10px_40px_-12px_rgba(244,67,60,0.75)] transition-colors hover:bg-signal-hot active:scale-[0.98]"
          >
            Create a new room
            <Icon name="arrowRight" size={18} />
          </button>

          <div className="my-6 flex items-center gap-3">
            <span className="h-px flex-1 bg-edge" />
            <span className="data text-faint">or join existing</span>
            <span className="h-px flex-1 bg-edge" />
          </div>

          <div className="flex gap-2">
            <label htmlFor="code" className="sr-only">
              Room code
            </label>
            <input
              id="code"
              value={code}
              onChange={(e) => {
                setCode(e.target.value.toUpperCase());
                setError("");
              }}
              onKeyDown={(e) => e.key === "Enter" && joinRoom()}
              placeholder="PC-XXXX"
              className="w-full rounded-card border border-edge bg-ink px-4 py-3 font-mono uppercase tracking-widest text-bone placeholder:text-faint outline-none transition-colors focus:border-signal/60"
            />
            <button
              onClick={joinRoom}
              className="shrink-0 rounded-card border border-edge-strong bg-bone/5 px-5 py-3 font-semibold text-bone transition-colors hover:bg-bone/10"
            >
              Join
            </button>
          </div>

          {error && (
            <p role="alert" className="mt-4 text-sm text-signal">
              {error}
            </p>
          )}
        </div>

        <div className="mt-7 flex items-center justify-center gap-5 text-sm">
          <Link
            href="/lobby"
            className="inline-flex items-center gap-2 text-smoke transition-colors hover:text-bone"
          >
            <Icon name="door" size={16} />
            Browse public rooms
          </Link>
          <Link
            href="/vent"
            className="inline-flex items-center gap-2 text-smoke transition-colors hover:text-bone"
          >
            <Icon name="mask" size={16} />
            Anonymous board
          </Link>
        </div>
      </motion.div>
    </main>
  );
}
