import Link from "next/link";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui";

const TABS = [
  { key: "lobby", label: "Lobby", href: "/lobby" },
  { key: "vent", label: "Board", href: "/vent" },
] as const;

export function AppHeader({ active }: { active?: "lobby" | "vent" }) {
  return (
    <header className="sticky top-0 z-40 border-b border-edge bg-ink/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3 sm:px-8">
        <div className="flex items-center gap-7">
          <Logo size="sm" />
          <nav className="hidden items-center gap-6 text-sm sm:flex">
            {TABS.map((t) => (
              <Link
                key={t.key}
                href={t.href}
                aria-current={active === t.key ? "page" : undefined}
                className={
                  active === t.key
                    ? "font-semibold text-bone"
                    : "text-smoke transition-colors hover:text-bone"
                }
              >
                {t.label}
              </Link>
            ))}
          </nav>
        </div>
        <Button href="/join" size="md">
          Create room
        </Button>
      </div>
    </header>
  );
}
