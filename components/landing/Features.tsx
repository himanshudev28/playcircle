import Link from "next/link";
import { SectionHeading } from "./SectionHeading";
import { Reveal } from "@/components/Reveal";
import { Icon, type IconName } from "@/components/Icon";
import { LiveDot } from "@/components/ui";

type Status = "live" | "new" | "planned";

/* The grid is deliberately uneven: a tile's size tracks how real the feature
   is. What you can use today is the biggest thing on the screen; what's still
   on the roadmap sits quietly at the bottom. Size is the status. */
const FEATURES: {
  icon: IconName;
  title: string;
  body: string;
  status: Status;
  href?: string;
  span: string;
}[] = [
  {
    icon: "door",
    title: "Public lobbies",
    body: "Find new friends and join open watch parties directly from the lobby. Rooms appear the moment someone opens one.",
    status: "live",
    href: "/lobby",
    span: "lg:col-span-2",
  },
  {
    icon: "mask",
    title: "Anonymous venting",
    body: "Share what's on your mind on the global feed under a random alias.",
    status: "live",
    href: "/vent",
    span: "lg:col-span-1",
  },
  {
    icon: "video",
    title: "Video & audio calls",
    body: "Talk face-to-face or voice-only while you watch, without switching apps.",
    status: "new",
    span: "lg:col-span-1",
  },
  {
    icon: "mail",
    title: "Direct messages",
    body: "Message friends privately and stay connected outside of rooms.",
    status: "new",
    span: "lg:col-span-1",
  },
  {
    icon: "headphones",
    title: "Audio rooms",
    body: "Voice-only rooms for podcasts, music sessions, or just hanging out.",
    status: "planned",
    span: "lg:col-span-1",
  },
  {
    icon: "monitor",
    title: "More platforms",
    body: "Twitch, Vimeo, and Dailymotion next — so you can watch almost anything together.",
    status: "planned",
    span: "lg:col-span-3",
  },
];

const STATUS_LABEL: Record<Status, string> = {
  live: "Live now",
  new: "New",
  planned: "Planned",
};

export function Features() {
  return (
    <section id="features" className="mx-auto max-w-7xl px-5 py-24 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <SectionHeading
          time="03:04"
          kicker="Everything you need"
          title="More than just watching."
          subtitle="Connect, chat, and share moments with the social features built in around the video."
        />
        <p className="data text-faint">Live today, and what comes next</p>
      </div>

      <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f, i) => (
          <Reveal key={f.title} delay={(i % 3) * 0.08} className={f.span}>
            <FeatureTile {...f} />
          </Reveal>
        ))}
      </div>
    </section>
  );
}

function FeatureTile({
  icon,
  title,
  body,
  status,
  href,
}: {
  icon: IconName;
  title: string;
  body: string;
  status: Status;
  href?: string;
}) {
  const planned = status === "planned";

  const content = (
    <>
      <div className="flex items-start justify-between gap-4">
        <span
          className={`grid h-11 w-11 place-items-center rounded-card border ${
            planned
              ? "border-edge bg-film-2 text-dim"
              : status === "live"
                ? "border-signal/35 bg-signal/10 text-signal"
                : "border-tungsten/30 bg-tungsten/10 text-tungsten"
          }`}
        >
          <Icon name={icon} size={19} />
        </span>

        <span className="flex items-center gap-1.5">
          {status === "live" && <LiveDot />}
          <span
            className={`data ${
              status === "live"
                ? "text-signal"
                : status === "new"
                  ? "text-tungsten"
                  : "text-faint"
            }`}
          >
            {STATUS_LABEL[status]}
          </span>
        </span>
      </div>

      <h3 className="mt-7 font-display text-lg font-bold text-bone">{title}</h3>
      <p
        className={`mt-2.5 max-w-lg leading-7 ${planned ? "text-dim" : "text-smoke"}`}
      >
        {body}
      </p>

      {href && (
        <span className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-signal">
          Open it
          <Icon
            name="arrowRight"
            size={16}
            className="transition-transform duration-200 group-hover:translate-x-1"
          />
        </span>
      )}
    </>
  );

  const cls = [
    "group flex h-full flex-col rounded-panel border p-7 transition-colors duration-300",
    planned
      ? "border-edge bg-transparent"
      : "border-edge bg-film hover:border-edge-strong",
    href ? "hover:bg-film-2" : "",
  ].join(" ");

  return href ? (
    <Link href={href} className={cls}>
      {content}
    </Link>
  ) : (
    <div className={cls}>{content}</div>
  );
}
