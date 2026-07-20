import Link from "next/link";
import { Logo } from "@/components/Logo";

const COLS = [
  {
    title: "Product",
    links: ["Features", "How it works", "FAQ", "Sign in"],
  },
  {
    title: "Company",
    links: ["About", "Contact", "Privacy", "Terms"],
  },
  {
    title: "Resources",
    links: ["Start free", "Room experience", "Use cases", "Security"],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-hairline">
      <div className="mx-auto max-w-7xl px-5 py-16 sm:px-8">
        <div className="grid gap-12 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <Logo />
            <p className="mt-5 max-w-xs text-sm leading-relaxed text-white/50">
              Private, polished watch rooms for friends, couples, communities,
              and teams who want shared moments without setup friction.
            </p>
          </div>
          {COLS.map((col) => (
            <div key={col.title}>
              <div className="kicker text-white/40">{col.title}</div>
              <ul className="mt-5 space-y-3">
                {col.links.map((l) => (
                  <li key={l}>
                    <Link
                      href="/join"
                      className="text-sm text-white/60 transition hover:text-white"
                    >
                      {l}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <p className="mt-14 border-t border-hairline pt-8 text-xs leading-relaxed text-white/35">
          watchnparty is a browser-based watch party app designed to help you
          watch YouTube together no matter where you are. Whether you want to
          host a YouTube watch party with your best friends or sync YouTube with
          friends for a virtual movie night, our platform provides real-time
          synchronized video playback with integrated live chat and reactions —
          the best alternative for remote viewing. Start your free watch party
          today.
        </p>

        <div className="mt-8 flex items-center justify-between text-xs text-white/35">
          <span>© 2026 watchnparty. All rights reserved.</span>
          <div className="flex items-center gap-4">
            <span aria-hidden>🌐</span>
            <span aria-hidden>♥</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
