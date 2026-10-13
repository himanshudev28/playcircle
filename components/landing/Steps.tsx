import { SectionHeading } from "./SectionHeading";
import { Reveal } from "@/components/Reveal";
import { Icon, type IconName } from "@/components/Icon";

/* This one genuinely is a sequence, so it gets numbers and a connecting rule —
   a filmstrip you read left to right. */
const STEPS: { title: string; body: string; icon: IconName }[] = [
  {
    icon: "userPlus",
    title: "Create your account",
    body: "Continue with Google and land inside the product in a few seconds.",
  },
  {
    icon: "link",
    title: "Paste any YouTube link",
    body: "Drop a video into a room and let sync do the heavy lifting automatically.",
  },
  {
    icon: "send",
    title: "Invite people instantly",
    body: "Send the room code, start the video, and enjoy the moment together.",
  },
];

export function Steps() {
  return (
    <section id="how" className="mx-auto max-w-7xl px-5 py-24 sm:px-8">
      <SectionHeading
        time="01:30"
        kicker="How it works"
        title="From curiosity to first shared room in three steps."
        subtitle="No installs and no configuration. It is about a minute from here to watching something together."
        align="center"
      />

      <div className="relative mt-16">
        {/* The rule that ties the strip together */}
        <div
          className="absolute left-0 right-0 top-6 hidden h-px bg-linear-to-r from-transparent via-edge-strong to-transparent md:block"
          aria-hidden
        />
        <ol className="grid gap-10 md:grid-cols-3 md:gap-8">
          {STEPS.map((s, i) => (
            <Reveal key={s.title} delay={i * 0.1}>
              <li className="relative">
                <div className="flex items-center gap-4">
                  <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full border border-edge bg-ink text-signal">
                    <Icon name={s.icon} size={20} />
                  </span>
                  <span className="data text-dim tnum">
                    Step {String(i + 1).padStart(2, "0")}
                  </span>
                </div>
                <h3 className="mt-6 font-display text-xl font-bold text-bone">
                  {s.title}
                </h3>
                <p className="mt-3 leading-8 text-smoke">{s.body}</p>
              </li>
            </Reveal>
          ))}
        </ol>
      </div>
    </section>
  );
}
