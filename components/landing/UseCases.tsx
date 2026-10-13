import { SectionHeading } from "./SectionHeading";
import { Reveal } from "@/components/Reveal";
import { Icon, type IconName } from "@/components/Icon";

/* These are audiences, not a sequence — so no 01/02/03. They're set as a
   divided index instead of a card grid: an editorial list reads as "here are
   the kinds of people who use this", which is what the section actually says. */
const CASES: {
  icon: IconName;
  kicker: string;
  title: string;
  body: string;
  detail: string;
}[] = [
  {
    icon: "heart",
    kicker: "Long-distance",
    title: "For nights that feel better when you are watching side by side.",
    body: "Pick something you both love, talk through the quiet parts, and keep your usual rhythm even when you are apart.",
    detail: "A simple room can still feel like a habit you kept together.",
  },
  {
    icon: "users",
    kicker: "Friends",
    title: "For group chats that deserve more than a link drop.",
    body: "Start a room for movie nights, comedy clips, playlists, or comfort rewatches and keep everyone on the same moment.",
    detail: "Less counting down in the chat. More actually reacting together.",
  },
  {
    icon: "globe",
    kicker: "Communities",
    title: "For clubs, communities, and remote teams that gather online.",
    body: "Host shared demos, premieres, or casual sessions in one room that feels organized without feeling stiff.",
    detail: "Structured enough to host people, relaxed enough to feel natural.",
  },
  {
    icon: "message",
    kicker: "Social hub",
    title: "For sharing thoughts, sending DMs, and talking to strangers.",
    body: "Post and vent on the community board, send private messages to friends, and connect with people from the active lobby.",
    detail: "A place to say the thing you didn't want to say out loud.",
  },
];

export function UseCases() {
  return (
    <section className="mx-auto max-w-7xl px-5 py-24 sm:px-8">
      <div className="grid gap-14 lg:grid-cols-[0.72fr_1.28fr] lg:gap-20">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <SectionHeading
            time="00:42"
            kicker="Built for real moments"
            title={
              <>
                However you watch,
                <br />
                it just works.
              </>
            }
            subtitle="One room, four very different reasons to open it."
          />
        </div>

        <div className="border-t border-edge">
          {CASES.map((c, i) => (
            <Reveal key={c.kicker} delay={i * 0.06}>
              <article className="group grid gap-5 border-b border-edge py-9 sm:grid-cols-[auto_1fr] sm:gap-7">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-card border border-edge bg-film text-signal transition-colors duration-300 group-hover:border-signal/40 group-hover:bg-signal/10">
                  <Icon name={c.icon} size={19} />
                </span>
                <div>
                  <p className="data text-dim">{c.kicker}</p>
                  <h3 className="mt-2.5 font-display text-xl font-bold leading-snug text-bone sm:text-2xl">
                    {c.title}
                  </h3>
                  <p className="mt-3.5 max-w-xl leading-8 text-smoke">{c.body}</p>
                  <p className="mt-4 border-l-2 border-tungsten/40 pl-4 text-sm leading-relaxed text-dim">
                    {c.detail}
                  </p>
                </div>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
