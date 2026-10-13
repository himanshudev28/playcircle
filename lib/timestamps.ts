/* Video timecodes in chat: "1:15", "1:02:05".
   Shared by the chat (clickable timestamps, "Moment" button) and the
   reactions timeline (hover labels). */

/** 75 → "1:15", 3725 → "1:02:05". Negative / non-finite → "0:00". */
export function formatTime(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

export type TimestampMatch = {
  /** Index of the first character of the timecode in `text`. */
  start: number;
  /** Index just past the timecode. */
  end: number;
  seconds: number;
  /** The timecode exactly as written. */
  label: string;
};

/* A timecode must stand on its own: not glued to letters, digits, dots,
   colons or slashes on either side (so "v1:30", "12:30pm", "10.1:20",
   "1:2:3:4" and "host:8080/" never match). The leading boundary is a
   captured group rather than a lookbehind, which older Safari lacks.

   Accepted shapes:
     m:ss      m = 0–599 (up to 3 digits), ss = 00–59
     h:mm:ss   h = 0–99, mm = 00–59, ss = 00–59 */
const TIMECODE =
  /(^|[^\w:./])(?:(\d{1,2}):([0-5]\d):([0-5]\d)|(\d{1,3}):([0-5]\d))(?![\w:/]|\.\d)/g;

const MAX_MINUTES_SHORT = 599;

/** Finds m:ss / h:mm:ss timecodes in free text, in order. */
export function findTimestamps(text: string): TimestampMatch[] {
  const out: TimestampMatch[] = [];
  if (!text || text.indexOf(":") < 0) return out;
  TIMECODE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TIMECODE.exec(text))) {
    const prefix = m[1];
    const start = m.index + prefix.length;
    const label = m[0].slice(prefix.length);
    let seconds: number;
    if (m[2] !== undefined) {
      seconds = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
    } else {
      const minutes = Number(m[5]);
      if (minutes > MAX_MINUTES_SHORT) continue;
      seconds = minutes * 60 + Number(m[6]);
    }
    out.push({ start, end: start + label.length, seconds, label });
    // Resume right after the timecode so a following " 2:00" can still use
    // its space as the leading boundary.
    TIMECODE.lastIndex = start + label.length;
  }
  return out;
}
