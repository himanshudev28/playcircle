import Link from "next/link";

export function Logo({
  size = "md",
  href = "/",
}: {
  size?: "sm" | "md" | "lg";
  href?: string | null;
}) {
  const dim = size === "lg" ? 44 : size === "sm" ? 30 : 38;
  const text =
    size === "lg" ? "text-2xl" : size === "sm" ? "text-lg" : "text-xl";

  const inner = (
    <span className="flex items-center gap-3">
      <span
        className="relative grid place-items-center rounded-full bg-white text-black shadow-[0_0_30px_-6px_rgba(240,69,75,0.6)]"
        style={{ width: dim, height: dim }}
      >
        <svg
          width={dim * 0.42}
          height={dim * 0.42}
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden
        >
          <path d="M8 5v14l11-7z" />
        </svg>
      </span>
      <span className={`font-extrabold tracking-tight ${text}`}>
        watch<span className="text-brand">n</span>party
      </span>
    </span>
  );

  if (href === null) return inner;
  return (
    <Link href={href} className="inline-flex items-center">
      {inner}
    </Link>
  );
}
