import { Reveal } from "@/components/Reveal";
import { SectionMarker } from "@/components/ui";

export function SectionHeading({
  time,
  kicker,
  title,
  subtitle,
  align = "left",
  className = "",
}: {
  time: string;
  kicker: string;
  title: React.ReactNode;
  subtitle?: string;
  align?: "left" | "center";
  className?: string;
}) {
  const centered = align === "center";
  return (
    <div className={`${centered ? "mx-auto max-w-2xl text-center" : "max-w-xl"} ${className}`}>
      <Reveal>
        <SectionMarker
          time={time}
          label={kicker}
          className={centered ? "justify-center" : ""}
        />
      </Reveal>
      <Reveal delay={0.05}>
        <h2 className="mt-5 font-display text-4xl font-extrabold leading-[1.02] text-bone sm:text-5xl">
          {title}
        </h2>
      </Reveal>
      {subtitle && (
        <Reveal delay={0.1}>
          <p className="mt-4 text-base leading-8 text-smoke">{subtitle}</p>
        </Reveal>
      )}
    </div>
  );
}
