import Link from "next/link";
import { Logo } from "@/components/Logo";

export function AppHeader({ active }: { active?: "lobby" | "vent" }) {
  return (
    <header className="sticky top-0 z-40 border-b border-hairline bg-black/70 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3 sm:px-8">
        <div className="flex items-center gap-6">
          <Logo size="sm" />
          <nav className="hidden items-center gap-5 text-sm sm:flex">
            <Link
              href="/lobby"
              className={
                active === "lobby"
                  ? "font-semibold text-white"
                  : "text-white/55 transition hover:text-white"
              }
            >
              Lobby
            </Link>
            <Link
              href="/vent"
              className={
                active === "vent"
                  ? "font-semibold text-white"
                  : "text-white/55 transition hover:text-white"
              }
            >
              Anonymous board
            </Link>
          </nav>
        </div>
        <Link
          href="/join"
          className="rounded-full bg-brand px-5 py-2 text-sm font-semibold transition hover:bg-brand-bright active:scale-95"
        >
          Create room
        </Link>
      </div>
    </header>
  );
}
