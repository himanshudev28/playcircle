import type { SVGProps } from "react";

/* One icon voice for the whole product: 24px grid, 1.6 stroke, round joins.
   Drawn inline rather than pulled from a library so the weight matches the
   type — library icons are usually 2px and read heavier than Manrope. */

const PATHS = {
  play: <path d="M8.5 5.2v13.6a.8.8 0 0 0 1.22.68l10.9-6.8a.8.8 0 0 0 0-1.36L9.72 4.52A.8.8 0 0 0 8.5 5.2Z" />,
  pause: (
    <>
      <rect x="7" y="5" width="3.5" height="14" rx="1.2" />
      <rect x="13.5" y="5" width="3.5" height="14" rx="1.2" />
    </>
  ),
  film: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M8 4v16M16 4v16M3 9h5M3 15h5M16 9h5M16 15h5" />
    </>
  ),
  heart: (
    <path d="M12 20.3c-4.6-3.5-8.6-6.7-8.6-10.6a4.5 4.5 0 0 1 8.6-1.9 4.5 4.5 0 0 1 8.6 1.9c0 3.9-4 7.1-8.6 10.6Z" />
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M3.4 12h17.2" />
      <path d="M12 3.4c2.2 2.4 3.4 5.4 3.4 8.6S14.2 18.2 12 20.6c-2.2-2.4-3.4-5.4-3.4-8.6S9.8 5.8 12 3.4Z" />
    </>
  ),
  message: (
    <path d="M20.5 11.8a7.7 7.7 0 0 1-7.7 7.7H8.1L3.5 22.4v-4.6a7.7 7.7 0 0 1 4.6-14h4.7a7.7 7.7 0 0 1 7.7 7.7Z" />
  ),
  video: (
    <>
      <rect x="2.8" y="5.4" width="12.6" height="13.2" rx="2.6" />
      <path d="m15.4 10.4 5.2-3.1v9.4l-5.2-3.1z" />
    </>
  ),
  mail: (
    <>
      <rect x="2.8" y="5" width="18.4" height="14" rx="2.5" />
      <path d="m3.6 7.4 7.3 5.2a2 2 0 0 0 2.2 0l7.3-5.2" />
    </>
  ),
  mask: (
    <>
      <path d="M2.6 9.6h18.8" />
      <circle cx="7.4" cy="14" r="3.3" />
      <circle cx="16.6" cy="14" r="3.3" />
      <path d="M10.6 13.4c.9-.5 1.9-.5 2.8 0" />
    </>
  ),
  door: (
    <>
      <path d="M5 21V4.8A1.8 1.8 0 0 1 6.8 3h10.4A1.8 1.8 0 0 1 19 4.8V21" />
      <path d="M2.8 21h18.4" />
      <circle cx="15.2" cy="12.4" r="1" />
    </>
  ),
  headphones: (
    <>
      <path d="M4 15.4v-3.2a8 8 0 0 1 16 0v3.2" />
      <rect x="2.6" y="14.2" width="4.6" height="6" rx="2.1" />
      <rect x="16.8" y="14.2" width="4.6" height="6" rx="2.1" />
    </>
  ),
  monitor: (
    <>
      <rect x="2.6" y="3.8" width="18.8" height="13" rx="2.4" />
      <path d="M9 20.2h6M12 16.8v3.4" />
    </>
  ),
  userPlus: (
    <>
      <circle cx="9.4" cy="8" r="3.8" />
      <path d="M2.6 20.2a6.8 6.8 0 0 1 13.6 0" />
      <path d="M19 7.6v5.2M21.6 10.2h-5.2" />
    </>
  ),
  link: (
    <>
      <path d="M10.2 13.8a3.8 3.8 0 0 0 5.7.4l2.6-2.6a3.8 3.8 0 0 0-5.4-5.4l-1.5 1.5" />
      <path d="M13.8 10.2a3.8 3.8 0 0 0-5.7-.4l-2.6 2.6a3.8 3.8 0 0 0 5.4 5.4l1.5-1.5" />
    </>
  ),
  send: (
    <>
      <path d="M21 3 10.6 13.4" />
      <path d="M21 3l-6.6 18.4-3.8-8-8-3.8L21 3Z" />
    </>
  ),
  chevronDown: <path d="m6 9.5 6 6 6-6" />,
  menu: <path d="M3.4 7h17.2M3.4 12h17.2M3.4 17h17.2" />,
  close: <path d="M6.2 6.2l11.6 11.6M17.8 6.2 6.2 17.8" />,
  arrowRight: <path d="M4.4 12h15.2M13.4 5.8 19.6 12l-6.2 6.2" />,
  arrowLeft: <path d="M19.6 12H4.4M10.6 5.8 4.4 12l6.2 6.2" />,
  check: <path d="m5 12.6 4.4 4.4L19 6.6" />,
  lock: (
    <>
      <rect x="4.2" y="10.4" width="15.6" height="10.4" rx="2.6" />
      <path d="M8 10.4V7.6a4 4 0 0 1 8 0v2.8" />
    </>
  ),
  copy: (
    <>
      <rect x="8.6" y="8.6" width="12" height="12" rx="2.4" />
      <path d="M15.4 5.4H5.8a2.4 2.4 0 0 0-2.4 2.4v9.6" />
    </>
  ),
  zap: <path d="M13.4 2.2 4.6 13.4h6.2l-1.4 8.4 8.8-11.2h-6.2l1.4-8.4Z" />,
  users: (
    <>
      <circle cx="9" cy="8" r="3.6" />
      <path d="M2.8 20.2a6.4 6.4 0 0 1 12.4 0" />
      <path d="M16.2 4.8a3.6 3.6 0 0 1 0 6.9M17.6 20.2a6.5 6.5 0 0 0-2-4.4" />
    </>
  ),
  eye: (
    <>
      <path d="M2.4 12S5.9 5.6 12 5.6 21.6 12 21.6 12 18.1 18.4 12 18.4 2.4 12 2.4 12Z" />
      <circle cx="12" cy="12" r="3.1" />
    </>
  ),
  broadcast: (
    <>
      <circle cx="12" cy="12" r="2.4" />
      <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 16.2a6 6 0 0 0 0-8.4" />
      <path d="M4.8 4.8a10.2 10.2 0 0 0 0 14.4M19.2 19.2a10.2 10.2 0 0 0 0-14.4" />
    </>
  ),
  mic: (
    <>
      <rect x="8.6" y="2.8" width="6.8" height="11.6" rx="3.4" />
      <path d="M5 11.2a7 7 0 0 0 14 0M12 18.2v3" />
    </>
  ),
  micOff: (
    <>
      <path d="M15.4 9.6V6.2a3.4 3.4 0 0 0-6.6-1.1M8.6 8.6v2.4a3.4 3.4 0 0 0 5.6 2.6" />
      <path d="M5 11.2a7 7 0 0 0 11.4 5.4M19 11.2a7 7 0 0 1-.6 2.8M12 18.2v3M3.4 3.4l17.2 17.2" />
    </>
  ),
  videoOff: (
    <>
      <path d="M15.4 13.6v2.4a2.6 2.6 0 0 1-2.6 2.6H5.4A2.6 2.6 0 0 1 2.8 16V8a2.6 2.6 0 0 1 2.6-2.6h.8M10 5.4h2.8a2.6 2.6 0 0 1 2.6 2.6v2.4l5.2-3.1v9.4" />
      <path d="M2.4 2.4l19.2 19.2" />
    </>
  ),
  phoneOff: (
    <path d="M3.2 13.2c-.6-.6-.6-1.6.1-2.2a13.4 13.4 0 0 1 17.4 0c.7.6.7 1.6.1 2.2l-1.6 1.6a1.4 1.4 0 0 1-1.8.1l-2-1.5a1.4 1.4 0 0 1-.5-1.2l.2-1.6a10.6 10.6 0 0 0-6.2 0l.2 1.6a1.4 1.4 0 0 1-.5 1.2l-2 1.5a1.4 1.4 0 0 1-1.8-.1z" />
  ),
  crown: (
    <path d="M3.6 8.2 7.8 11.6 12 5.4l4.2 6.2 4.2-3.4-1.8 10H5.4z" />
  ),
  more: (
    <>
      <circle cx="5.6" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="18.4" cy="12" r="1.2" />
    </>
  ),
  userMinus: (
    <>
      <circle cx="9.4" cy="8" r="3.8" />
      <path d="M2.6 20.2a6.8 6.8 0 0 1 13.6 0M16.4 10.2h5.2" />
    </>
  ),
  power: <path d="M12 3v8.4M7 6.2a7.8 7.8 0 1 0 10 0" />,
  flip: (
    <>
      <path d="M4.6 10.2a7.6 7.6 0 0 1 13.4-3.4l1.6 1.8M19.4 13.8A7.6 7.6 0 0 1 6 17.2l-1.6-1.8" />
      <path d="M19.8 4.4v4.4h-4.4M4.2 19.6v-4.4h4.4" />
    </>
  ),
  download: <path d="M12 3.6v11.6m-4.8-4.8L12 15.2l4.8-4.8M4.4 20.4h15.2" />,
} as const;

export type IconName = keyof typeof PATHS;

/* These read as solid shapes rather than outlines. */
const FILLED = new Set<IconName>(["play", "pause", "zap", "crown"]);

export function Icon({
  name,
  size = 20,
  ...rest
}: { name: IconName; size?: number } & Omit<
  SVGProps<SVGSVGElement>,
  "name" | "children"
>) {
  const filled = FILLED.has(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}

/* Google's mark is a brand asset — it keeps its own colours. */
export function GoogleMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.5 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.87c2.26-2.09 3.56-5.17 3.56-8.87Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.08 7.94-2.91l-3.87-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.27v3.09A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.28a7.2 7.2 0 0 1 0-4.56V6.63H1.27a12 12 0 0 0 0 10.74l4-3.09Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.43-3.43C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.27 6.63l4 3.09C6.22 6.86 8.87 4.75 12 4.75Z"
      />
    </svg>
  );
}
