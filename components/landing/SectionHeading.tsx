import { Reveal } from "@/components/Reveal";

export function SectionHeading({
  kicker,
  title,
  subtitle,
  center = true,
}: {
  kicker: string;
  title: React.ReactNode;
  subtitle?: string;
  center?: boolean;
}) {
  return (
    <div className={center ? "mx-auto max-w-2xl text-center" : "max-w-2xl"}>
      <Reveal>
        <div className="kicker text-brand">{kicker}</div>
      </Reveal>
      <Reveal delay={0.05}>
        <h2 className="mt-4 text-4xl font-extrabold leading-[1.02] tracking-tight sm:text-5xl">
          {title}
        </h2>
      </Reveal>
      {subtitle && (
        <Reveal delay={0.1}>
          <p className="mt-4 text-base leading-relaxed text-white/55">
            {subtitle}
          </p>
        </Reveal>
      )}
    </div>
  );
}
