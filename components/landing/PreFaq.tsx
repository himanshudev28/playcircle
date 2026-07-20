import { SectionHeading } from "./SectionHeading";
import { Accordion, type QA } from "./Accordion";
import { Reveal } from "@/components/Reveal";

const ITEMS: QA[] = [
  {
    q: "Is watchnparty free to start?",
    a: "Yes. Create an account, spin up a room, and start watching together in seconds — no credit card and no download required.",
  },
  {
    q: "Does watchnparty support venting and messaging?",
    a: "It does. Alongside synced video you get live room chat, private direct messages, and an anonymous community board for sharing thoughts.",
  },
  {
    q: "What video source works right now?",
    a: "YouTube works today — paste any link and everyone in the room stays on the same frame. Twitch, Vimeo, and more are planned.",
  },
  {
    q: "Will it work on phones?",
    a: "Yes. watchnparty runs entirely in the browser and is designed to feel simple on both mobile and desktop.",
  },
  {
    q: "How do invites work?",
    a: "Every room has a short code and a shareable link. Send it to anyone and they drop straight into the same session.",
  },
  {
    q: "Is the room private?",
    a: "Rooms are private by default — only people with the code or link can join. You can also open a public lobby when you want strangers to find you.",
  },
];

export function PreFaq() {
  return (
    <section className="mx-auto max-w-3xl px-5 py-24 sm:px-8">
      <SectionHeading
        kicker="Questions people ask before signing up"
        title="Clear answers reduce hesitation."
      />
      <Reveal delay={0.1} className="mt-14">
        <Accordion items={ITEMS} />
      </Reveal>
    </section>
  );
}
