"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { SectionHeading } from "./SectionHeading";

type Badge = "NEW" | "LIVE" | "PLANNED";

const FEATURES: {
  icon: string;
  title: string;
  body: string;
  badge: Badge;
  href?: string;
}[] = [
  {
    icon: "📹",
    title: "Video & Audio Calls",
    body: "Talk face-to-face or voice-only while you watch. No need to switch apps.",
    badge: "NEW",
  },
  {
    icon: "✉️",
    title: "Direct Messages",
    body: "Send private messages to your friends and stay connected outside of rooms.",
    badge: "NEW",
  },
  {
    icon: "🕶️",
    title: "Anonymous Venting",
    body: "Share your thoughts anonymously on the global feed and chat with strangers.",
    badge: "NEW",
    href: "/vent",
  },
  {
    icon: "🎉",
    title: "Public Lobbies",
    body: "Find new friends and join open watch parties directly from the lobby.",
    badge: "LIVE",
    href: "/lobby",
  },
  {
    icon: "🎧",
    title: "Audio Rooms",
    body: "Drop into voice-only rooms for podcasts, music sessions, or just hanging out.",
    badge: "PLANNED",
  },
  {
    icon: "📺",
    title: "More Platforms",
    body: "Twitch, Vimeo, Dailymotion and more. Watch anything together, from anywhere.",
    badge: "PLANNED",
  },
];

const badgeStyles: Record<Badge, string> = {
  NEW: "bg-brand/15 text-brand border-brand/30",
  LIVE: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  PLANNED: "bg-white/[0.04] text-white/45 border-hairline",
};

export function Features() {
  return (
    <section className="mx-auto max-w-7xl px-5 py-24 sm:px-8">
      <SectionHeading
        kicker="Everything you need"
        title="More than just watching."
        subtitle="Connect, chat, and share moments with our built-in social features."
      />
      <div className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f, i) => (
          <motion.div
            key={f.title}
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.6, delay: (i % 3) * 0.1 }}
          >
            <FeatureCardShell href={f.href}>
              <div className="flex items-start justify-between">
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-white/[0.04] text-2xl">
                  {f.icon}
                </span>
                <span
                  className={`rounded-full border px-2.5 py-1 text-[0.65rem] font-bold tracking-widest ${
                    badgeStyles[f.badge]
                  }`}
                >
                  {f.badge}
                </span>
              </div>
              <h3 className="mt-6 flex items-center gap-2 text-lg font-bold">
                {f.title}
                {f.href && (
                  <span className="text-brand opacity-0 transition group-hover:opacity-100">
                    →
                  </span>
                )}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-white/55">
                {f.body}
              </p>
              {f.href && (
                <span className="mt-3 inline-block text-sm font-semibold text-brand">
                  Try it now
                </span>
              )}
            </FeatureCardShell>
          </motion.div>
        ))}
      </div>
    </section>
  );
}

function FeatureCardShell({
  href,
  children,
}: {
  href?: string;
  children: React.ReactNode;
}) {
  const className =
    "group relative block h-full rounded-3xl border border-hairline bg-white/[0.02] p-7 transition hover:-translate-y-1 hover:border-brand/30 hover:bg-white/[0.04]";
  if (href) {
    return (
      <Link href={href} className={className}>
        {children}
      </Link>
    );
  }
  return <div className={className}>{children}</div>;
}
