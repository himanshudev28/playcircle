import Link from "next/link";

/* The mark is a record button: an aperture ring around a live dot. It rhymes
   with the playhead on the scrub ribbon, and it says "this room is running"
   in a way a generic play triangle does not. */
export function Logo({
  size = "md",
  href = "/",
}: {
  size?: "sm" | "md" | "lg";
  href?: string | null;
}) {
  const dim = size === "lg" ? 34 : size === "sm" ? 24 : 28;
  const text =
    size === "lg" ? "text-2xl" : size === "sm" ? "text-base" : "text-xl";

  const inner = (
    <span className="flex items-center gap-2.5">
      <svg
        width={dim}
        height={dim}
        viewBox="0 0 32 32"
        aria-hidden
        className="shrink-0"
      >
        <circle
          cx="16"
          cy="16"
          r="14"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.22"
          strokeWidth="1.6"
        />
        <circle cx="16" cy="16" r="7.5" fill="var(--color-signal)" />
        <circle cx="16" cy="16" r="7.5" fill="none" stroke="var(--color-signal)" strokeOpacity="0.35" strokeWidth="6" />
      </svg>
      <span className={`font-display font-extrabold text-bone ${text}`}>
        Play<span className="text-signal">Circle</span>
      </span>
    </span>
  );

  if (href === null) return inner;
  return (
    <Link
      href={href}
      className="inline-flex items-center rounded-lg text-bone transition-opacity hover:opacity-85"
      aria-label="PlayCircle home"
    >
      {inner}
    </Link>
  );
}
