import { Accordion, type QA } from "./Accordion";
import { Reveal } from "@/components/Reveal";

const ITEMS: QA[] = [
  {
    q: "How does the synchronized video playback work?",
    a: "When anyone plays, pauses, or seeks, that action is broadcast in real time to everyone else in the room over a live connection. The result is that all viewers stay on the same frame — typically within a few dozen milliseconds of each other.",
  },
  {
    q: "Is watchnparty completely free to use?",
    a: "Yes. Creating rooms, inviting friends, synced playback, and live chat are all free. There is no download and no credit card required to start.",
  },
  {
    q: "What video platforms are supported?",
    a: "YouTube is fully supported today. Support for Twitch, Vimeo, Dailymotion and more is planned so you can watch almost anything together.",
  },
  {
    q: "How do public lobbies and Direct Messages work?",
    a: "Public lobbies let you discover and join open watch parties from strangers, while Direct Messages let you privately message friends you have met — inside or outside of a room.",
  },
  {
    q: "Do I need to install a browser extension?",
    a: "No. Everything runs in your browser tab. Open a room link, and you are in — nothing to install on desktop or mobile.",
  },
];

export function BigFaq() {
  return (
    <section id="faq" className="mx-auto max-w-3xl px-5 py-24 sm:px-8">
      <Reveal>
        <h2 className="text-center text-4xl font-extrabold tracking-tight sm:text-5xl">
          Frequently Asked Questions
        </h2>
      </Reveal>
      <Reveal delay={0.05}>
        <p className="mx-auto mt-4 max-w-xl text-center text-sm leading-relaxed text-white/55">
          Everything you need to know about watchnparty. Learn how our
          synchronized playback works, how to manage your private rooms, and how
          to connect with the community.
        </p>
      </Reveal>
      <Reveal delay={0.1} className="mt-12">
        <Accordion items={ITEMS} />
      </Reveal>
    </section>
  );
}
