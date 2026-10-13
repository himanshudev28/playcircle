import { SectionHeading } from "./SectionHeading";
import { Reveal } from "@/components/Reveal";

/* Deliberately not an accordion — the long-form accordion lives further down
   the page. These are the six objections that come up before signing up, so
   they're answered in the open, in one glance. */
/* Exported so page.tsx can fold these into the page's single FAQPage graph —
   two FAQPage blocks on one URL and Google picks one arbitrarily. */
export const PRE_FAQ_ITEMS = [
  {
    q: "Is PlayCircle free to start?",
    a: "Yes. Create an account, spin up a room, and start watching together in seconds. No credit card, no download.",
  },
  {
    q: "Does it do venting and messaging?",
    a: "It does. Alongside synced video there's live room chat, private direct messages, and an anonymous community board.",
  },
  {
    q: "What video sources work right now?",
    a: "YouTube works today — paste any link and everyone stays on the same frame. Twitch and Vimeo are next.",
  },
  {
    q: "Will it work on my phone?",
    a: "Yes. Everything runs in the browser and is built to feel simple on both mobile and desktop.",
  },
  {
    q: "How do invites work?",
    a: "Every room has a short code and a shareable link. Send either one and people drop straight into the session.",
  },
  {
    q: "Are rooms private?",
    a: "Private by default — only people with the code or link can join. Open a public lobby when you want to be found.",
  },
];

export function PreFaq() {
  return (
    <section className="mx-auto max-w-7xl px-5 py-24 sm:px-8">
      <SectionHeading
        time="02:15"
        kicker="Before you sign up"
        title="The short answers."
        align="center"
      />

      <dl className="mx-auto mt-14 grid max-w-5xl gap-x-14 gap-y-9 sm:grid-cols-2">
        {PRE_FAQ_ITEMS.map((item, i) => (
          <Reveal key={item.q} delay={(i % 2) * 0.08}>
            <div>
              <dt className="font-display text-base font-bold text-bone">
                {item.q}
              </dt>
              <dd className="mt-2.5 leading-8 text-smoke">{item.a}</dd>
            </div>
          </Reveal>
        ))}
      </dl>
    </section>
  );
}
