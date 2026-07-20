"use client";

import { motion } from "framer-motion";
import { SectionHeading } from "./SectionHeading";

const STEPS = [
  {
    step: "STEP 1",
    title: "Create your account",
    body: "Continue with Google and land inside the product in a few seconds.",
    icon: "🔑",
  },
  {
    step: "STEP 2",
    title: "Paste any YouTube link",
    body: "Drop a video into a room and let sync do the heavy lifting automatically.",
    icon: "🔗",
  },
  {
    step: "STEP 3",
    title: "Invite people instantly",
    body: "Send the room code, start the video, and enjoy the moment together.",
    icon: "🚀",
  },
];

export function Steps() {
  return (
    <section className="mx-auto max-w-7xl px-5 py-24 sm:px-8">
      <SectionHeading
        kicker="Clear path to activation"
        title="From curiosity to first shared room in three steps."
        subtitle="High-converting onboarding is about momentum. Each step below removes uncertainty and points directly to the next action."
      />
      <div className="relative mt-16 grid gap-4 md:grid-cols-3">
        {STEPS.map((s, i) => (
          <motion.div
            key={s.step}
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.7, delay: i * 0.12 }}
            className="relative rounded-3xl border border-hairline bg-white/[0.02] p-8"
          >
            <div className="flex items-center justify-between">
              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand/10 text-2xl">
                {s.icon}
              </span>
              <span className="font-mono text-5xl font-bold text-white/[0.06]">
                {String(i + 1).padStart(2, "0")}
              </span>
            </div>
            <div className="kicker mt-6 text-brand">{s.step}</div>
            <h3 className="mt-2 text-xl font-bold">{s.title}</h3>
            <p className="mt-3 text-sm leading-relaxed text-white/55">
              {s.body}
            </p>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
