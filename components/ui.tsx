import Link from "next/link";
import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/Icon";

/* ---------------------------------------------------------------- Button */

type Variant = "primary" | "ghost" | "quiet";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-signal text-white hover:bg-signal-hot shadow-[0_10px_40px_-12px_rgba(244,67,60,0.75)]",
  ghost:
    "border border-edge-strong bg-bone/4 text-bone backdrop-blur-sm hover:bg-bone/8 hover:border-edge-strong",
  quiet: "text-smoke hover:text-bone",
};

const SIZES = {
  md: "h-11 px-5 text-sm",
  lg: "h-14 px-7 text-base",
} as const;

export function Button({
  href,
  variant = "primary",
  size = "lg",
  icon,
  iconAfter,
  className = "",
  children,
  ...rest
}: {
  href?: string;
  variant?: Variant;
  size?: keyof typeof SIZES;
  icon?: IconName;
  iconAfter?: IconName;
  className?: string;
  children: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = [
    "group inline-flex shrink-0 items-center justify-center gap-2.5 rounded-card font-semibold",
    "transition-[background-color,border-color,transform,box-shadow] duration-200 active:scale-[0.98]",
    SIZES[size],
    VARIANTS[variant],
    className,
  ].join(" ");

  const inner = (
    <>
      {icon && <Icon name={icon} size={18} />}
      {children}
      {iconAfter && (
        <Icon
          name={iconAfter}
          size={18}
          className="transition-transform duration-200 group-hover:translate-x-0.5"
        />
      )}
    </>
  );

  if (href) {
    return (
      <Link href={href} className={cls}>
        {inner}
      </Link>
    );
  }
  return (
    <button className={cls} {...rest}>
      {inner}
    </button>
  );
}

/* ------------------------------------------------------- Section marker

   Eyebrows are timecodes rather than "SECTION 01". The number encodes real
   position through the page, in the vocabulary the product already speaks.  */

export function SectionMarker({
  time,
  label,
  className = "",
}: {
  time: string;
  label: string;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <span className="data text-signal tnum">{time}</span>
      <span className="h-px w-8 bg-edge-strong" />
      <span className="data text-dim">{label}</span>
    </div>
  );
}

/* ------------------------------------------------------------- Live dot */

export function LiveDot({ className = "" }: { className?: string }) {
  return (
    <span
      className={`rec-dot inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-signal ${className}`}
      aria-hidden
    />
  );
}
