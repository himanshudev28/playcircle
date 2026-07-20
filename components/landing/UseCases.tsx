"use client";

import { motion } from "framer-motion";
import { SectionHeading } from "./SectionHeading";

const CASES = [
  {
    icon: "♥",
    kicker: "LONG·DISTANCE",
    title: "For nights that feel better when you are watching side by side.",
    body: "Pick something you both love, talk through the quiet parts, and keep your usual rhythm even when you are apart.",
    footer: "A simple room can still feel like a habit you kept together.",
  },
  {
    icon: "👥",
    kicker: "FRIENDS",
    title: "For group chats that deserve more than a link drop.",
    body: "Start a room for movie nights, comedy clips, playlists, or comfort rewatches and keep everyone on the same moment.",
    footer: "Less counting down in the chat. More actually reacting together.",
  },
  {
    icon: "🌍",
    kicker: "COMMUNITIES",
    title: "For clubs, communities, and remote teams that gather online.",
    body: "Host shared demos, premieres, or casual sessions in one room that feels organized without feeling stiff.",
    footer: "Structured enough to host people, relaxed enough to feel natural.",
  },
  {
    icon: "💬",
    kicker: "SOCIAL HUB",
    title: "For sharing thoughts, sending DMs, and talking to strangers.",
    body: "Post and vent on the community board, send private direct messages to friends, and connect with people directly from the active lobby.",
    footer: "A safe and welcoming space to express yourself freely.",
  },
];

export function UseCases() {
  return (
    <section className="mx-auto max-w-7xl px-5 py-24 sm:px-8">
      <SectionHeading
        kicker="Built for real moments"
        title={
          <>
            However you watch,
            <br /> it just works.
          </>
        }
      />
      <div className="mt-16 grid gap-4 sm:grid-cols-2">
        {CASES.map((c, i) => (
          <motion.article
            key={c.kicker}
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.7, delay: (i % 2) * 0.1 }}
            className="group relative overflow-hidden rounded-3xl border border-hairline bg-gradient-to-b from-white/[0.03] to-transparent p-8 transition hover:border-brand/30"
          >
            <div className="absolute -right-16 -top-16 h-40 w-40 rounded-full bg-brand/10 opacity-0 blur-2xl transition group-hover:opacity-100" />
            <div className="grid h-11 w-11 place-items-center rounded-xl border border-brand/30 bg-brand/10 text-brand">
              {c.icon}
            </div>
            <div className="kicker mt-6 text-white/40">{c.kicker}</div>
            <h3 className="mt-3 text-2xl font-bold leading-snug">{c.title}</h3>
            <p className="mt-4 text-sm leading-relaxed text-white/55">
              {c.body}
            </p>
            <p className="mt-4 border-t border-hairline pt-4 text-sm text-white/45">
              {c.footer}
            </p>
          </motion.article>
        ))}
      </div>
    </section>
  );
}
