import Link from "next/link";
import { Logo } from "@/components/Logo";
import { Icon } from "@/components/Icon";

const COLS = [
  {
    title: "Product",
    links: [
      { label: "Features", href: "/#features" },
      { label: "How it works", href: "/#how" },
      { label: "Public lobby", href: "/lobby" },
      { label: "Anonymous board", href: "/vent" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "Contact", href: "/contact" },
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
    ],
  },
  {
    title: "Get started",
    links: [
      { label: "Create a room", href: "/join" },
      { label: "Browse rooms", href: "/lobby" },
      { label: "FAQ", href: "/faq" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-edge bg-film/40">
      <div className="mx-auto max-w-7xl px-5 py-16 sm:px-8">
        <div className="grid gap-12 lg:grid-cols-[1.5fr_1fr_1fr_1fr]">
          <div>
            <Logo />
            <p className="mt-5 max-w-xs leading-7 text-smoke">
              Private, polished watch rooms for friends, couples, communities,
              and teams who want shared moments without setup friction.
            </p>
          </div>

          {COLS.map((col) => (
            <div key={col.title}>
              <p className="data text-dim">{col.title}</p>
              <ul className="mt-5 space-y-3.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <Link
                      href={l.href}
                      className="text-smoke transition-colors hover:text-bone"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <p className="mt-16 max-w-4xl border-t border-edge pt-8 text-[0.8rem] leading-7 text-faint">
          PlayCircle is a browser-based watch party app for watching YouTube
          together, wherever everyone happens to be. Host a YouTube watch party
          with friends or sync YouTube with a partner for a long-distance movie
          night: rooms give you real-time synchronized playback, live chat, and
          reactions without downloads or extensions. A free ListenFree
          alternative for online watch rooms, virtual movie nights, and
          community screenings.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t border-edge pt-8">
          <span className="text-[0.8rem] text-faint">
            © {new Date().getFullYear()} PlayCircle. All rights reserved.
          </span>
          <div className="flex items-center gap-4 text-dim">
            <Icon name="globe" size={17} />
            <Icon name="heart" size={17} />
          </div>
        </div>
      </div>
    </footer>
  );
}
