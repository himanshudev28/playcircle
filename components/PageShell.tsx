import type { ReactNode } from "react";
import { Nav } from "@/components/landing/Nav";
import { Footer } from "@/components/landing/Footer";
import { SectionMarker } from "@/components/ui";

/* Shared frame for the short, mostly-prose pages so About and Terms don't
   quietly drift into two different typographic systems. */
export function PageShell({
  marker,
  title,
  lede,
  children,
}: {
  marker: string;
  title: string;
  lede?: string;
  children: ReactNode;
}) {
  return (
    <>
      <Nav />
      <main className="mx-auto max-w-3xl px-5 pb-24 pt-36 sm:px-8 sm:pt-40">
        <SectionMarker time="PAGE" label={marker} />
        <h1 className="mt-5 font-display text-4xl font-extrabold leading-[1.02] text-bone sm:text-5xl">
          {title}
        </h1>
        {lede && <p className="mt-5 text-lg leading-8 text-smoke">{lede}</p>}
        <div className="mt-12 space-y-10">{children}</div>
      </main>
      <Footer />
    </>
  );
}

export function Prose({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h2 className="font-display text-xl font-bold text-bone">{heading}</h2>
      <div className="mt-3 space-y-3.5 leading-8 text-smoke [&_a]:text-signal [&_a:hover]:underline [&_strong]:font-semibold [&_strong]:text-bone">
        {children}
      </div>
    </section>
  );
}
