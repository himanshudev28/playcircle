import Image from "next/image";
import { Reveal } from "@/components/Reveal";
import { Button, LiveDot, SectionMarker } from "@/components/ui";
import { Icon } from "@/components/Icon";

const BULLETS = [
  "Private room links that are easy to share",
  "Sync playback that keeps everyone together",
  "Live chat for reactions as they happen",
  "Simple on mobile and desktop browsers",
];

const CHAT = [
  { u: "Maya", m: "this part gets me every time", tint: "#3a2a28" },
  { u: "Leo", m: "wait rewind rewind", tint: "#2b2f38" },
  { u: "Ade", m: "ok pausing, getting snacks", tint: "#37302a" },
];

export function RoomPreview() {
  return (
    <section className="mx-auto max-w-7xl px-5 py-24 sm:px-8">
      <div className="grid items-center gap-14 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
        <div>
          <Reveal>
            <SectionMarker time="04:20" label="Ready when you are" />
          </Reveal>
          <Reveal delay={0.05}>
            <h2 className="mt-5 font-display text-4xl font-extrabold leading-[1.02] text-bone sm:text-5xl">
              Open a room.
              <br />
              Bring everyone in.
            </h2>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="mt-5 max-w-md leading-8 text-smoke">
              No big setup and no pressure. Just a simple way to share the same
              screen, the same jokes, and the same moment with the people who
              matter to you.
            </p>
          </Reveal>
          <Reveal delay={0.15}>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button href="/join" iconAfter="arrowRight">
                Create your room
              </Button>
              <Button href="/lobby" variant="ghost">
                Browse public rooms
              </Button>
            </div>
          </Reveal>
          <Reveal delay={0.2}>
            <ul className="mt-9 space-y-3.5">
              {BULLETS.map((b) => (
                <li key={b} className="flex items-start gap-3 text-smoke">
                  <Icon
                    name="check"
                    size={17}
                    className="mt-1 shrink-0 text-signal"
                  />
                  {b}
                </li>
              ))}
            </ul>
          </Reveal>
        </div>

        <Reveal delay={0.1}>
          <RoomMock />
        </Reveal>
      </div>
    </section>
  );
}

function RoomMock() {
  return (
    <div className="overflow-hidden rounded-hero border border-edge bg-film shadow-[0_40px_120px_-40px_rgba(0,0,0,0.9)]">
      {/* Room bar */}
      <div className="flex items-center justify-between gap-4 border-b border-edge px-5 py-3.5">
        <div className="flex items-center gap-3">
          <span className="font-display text-sm font-bold text-bone">
            Friday Night Room
          </span>
          <span className="rounded-md border border-edge bg-ink px-2 py-0.5 font-mono text-[0.65rem] tracking-widest text-dim">
            PC-204
          </span>
        </div>
        <span className="flex items-center gap-1.5">
          <LiveDot />
          <span className="data text-signal">Live</span>
        </span>
      </div>

      <div className="grid sm:grid-cols-[1.55fr_1fr]">
        {/* Stage */}
        <div className="border-b border-edge sm:border-b-0 sm:border-r">
          <div className="relative aspect-video">
            <Image
              src="https://images.unsplash.com/photo-1517604931442-7e0c8ed2963c?auto=format&fit=crop&w=1200&q=80"
              alt=""
              fill
              sizes="(max-width: 640px) 100vw, 480px"
              className="object-cover opacity-45"
            />
            <div className="absolute inset-0 bg-linear-to-t from-ink via-ink/40 to-transparent" />
            <span className="absolute inset-0 m-auto grid h-14 w-14 place-items-center rounded-full bg-bone text-ink shadow-2xl">
              <Icon name="play" size={20} className="ml-0.5" />
            </span>
          </div>

          <div className="p-4">
            <p className="data text-dim">Now playing</p>
            <p className="mt-2 truncate text-sm font-medium text-bone">
              Feel-good movie soundtrack session
            </p>
            <div className="mt-4 flex items-center gap-3">
              <Icon name="pause" size={15} className="shrink-0 text-bone" />
              <span className="data tnum text-dim">12:04</span>
              <span className="relative h-1 flex-1 rounded-full bg-bone/12">
                <span className="absolute inset-y-0 left-0 w-2/5 rounded-full bg-linear-to-r from-signal to-tungsten" />
                <span className="absolute left-2/5 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-bone shadow-[0_0_10px_rgba(244,67,60,0.9)]" />
              </span>
              <span className="data tnum text-dim">31:47</span>
            </div>
          </div>
        </div>

        {/* Chat */}
        <div className="flex flex-col p-4">
          <div className="flex items-center justify-between">
            <p className="data text-dim">Room chat</p>
            <span className="data text-faint">4 here</span>
          </div>

          <div className="mt-4 flex-1 space-y-3.5">
            {CHAT.map((c) => (
              <div key={c.u} className="flex items-start gap-2.5">
                <span
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[0.6rem] font-bold text-bone"
                  style={{ background: c.tint }}
                >
                  {c.u[0]}
                </span>
                <p className="text-[0.8rem] leading-relaxed">
                  <span className="text-dim">{c.u}</span>{" "}
                  <span className="text-bone/90">{c.m}</span>
                </p>
              </div>
            ))}
          </div>

          <div className="mt-5 flex items-center gap-2 rounded-full border border-edge bg-ink px-3.5 py-2.5">
            <span className="flex-1 text-[0.8rem] text-faint">
              Say something…
            </span>
            <Icon name="send" size={15} className="text-dim" />
          </div>
        </div>
      </div>
    </div>
  );
}
