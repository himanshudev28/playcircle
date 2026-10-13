import { Accordion, type QA } from "./Accordion";
import { Reveal } from "@/components/Reveal";
import { SectionMarker } from "@/components/ui";

/* Exported for the page-level FAQPage graph in app/page.tsx. */
export const BIG_FAQ_ITEMS: QA[] = [
  {
    q: "How does the synchronized playback actually work?",
    a: "Every room holds one shared clock. When anyone plays, pauses, or seeks, that action is broadcast over a live WebSocket connection to everyone else in the room, typically in well under 50 milliseconds. Buffering differences are absorbed behind the scenes, and anyone joining late is dropped in at the exact point the room has reached — so nobody has to count down to press play.",
  },
  {
    q: "Is PlayCircle completely free?",
    a: "Yes. Creating rooms, inviting friends, synced playback, and live chat are all free, with no subscription and no per-room limit. There is nothing to download and no credit card involved.",
  },
  {
    q: "What video platforms are supported?",
    a: "YouTube is fully supported today — paste any standard video link, Short, or playlist URL and it loads for everyone in the room at once. Twitch, Vimeo, and Dailymotion support is in progress.",
  },
  {
    q: "How do public lobbies and direct messages work?",
    a: "Public lobbies list rooms whose hosts chose to be discoverable, so you can join an open watch party without an invite. Direct messages let you talk privately with people you have met, inside or outside a room, and you can turn your availability off whenever you want a quiet night.",
  },
  {
    q: "Do I need a browser extension?",
    a: "No. Everything runs in an ordinary browser tab. Open a room link on a laptop, tablet, or phone and you are in — nothing to install on either end.",
  },
];

export function BigFaq() {
  return (
    <section id="faq" className="mx-auto max-w-7xl px-5 py-24 sm:px-8">
      <div className="grid gap-12 lg:grid-cols-[0.65fr_1.35fr] lg:gap-20">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <Reveal>
            <SectionMarker time="05:12" label="Questions" />
          </Reveal>
          <Reveal delay={0.05}>
            <h2 className="mt-5 font-display text-4xl font-extrabold leading-[1.02] text-bone sm:text-5xl">
              Frequently asked questions
            </h2>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="mt-4 leading-8 text-smoke">
              How the sync holds up, what a room costs, and what happens to
              your messages.
            </p>
          </Reveal>
        </div>

        <Reveal delay={0.1}>
          <Accordion items={BIG_FAQ_ITEMS} />
        </Reveal>
      </div>
    </section>
  );
}
