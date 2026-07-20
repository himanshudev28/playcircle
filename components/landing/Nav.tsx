"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { Logo } from "@/components/Logo";

export function Nav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <motion.header
      initial={{ y: -30, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      className={`fixed inset-x-0 top-0 z-50 transition-colors duration-300 ${
        scrolled
          ? "border-b border-hairline bg-black/70 backdrop-blur-xl"
          : "border-b border-transparent"
      }`}
    >
      <nav className="mx-auto flex h-[68px] max-w-7xl items-center justify-between px-5 sm:px-8">
        <Logo />
        <div className="flex items-center gap-2 sm:gap-4">
          <Link
            href="/lobby"
            className="hidden rounded-full px-3 py-2 text-sm text-white/70 transition hover:text-white md:block"
          >
            Lobby
          </Link>
          <Link
            href="/vent"
            className="hidden rounded-full px-3 py-2 text-sm text-white/70 transition hover:text-white md:block"
          >
            Board
          </Link>
          <Link
            href="/join"
            className="hidden rounded-full px-4 py-2 text-sm text-white/80 transition hover:text-white sm:block"
          >
            Continue with Google
          </Link>
          <Link
            href="/join"
            className="rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white shadow-[0_8px_30px_-10px_rgba(240,69,75,0.9)] transition hover:bg-brand-bright active:scale-95"
          >
            Start free
          </Link>
        </div>
      </nav>
    </motion.header>
  );
}
