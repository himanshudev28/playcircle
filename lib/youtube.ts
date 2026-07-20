// Extract a YouTube video id from a URL or bare id.
export function parseYouTubeId(input: string): string | null {
  if (!input) return null;
  const s = input.trim();
  // Bare 11-char id
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  try {
    const url = new URL(s.includes("://") ? s : `https://${s}`);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = url.pathname.slice(1);
      return id.length === 11 ? id : null;
    }
    if (host.endsWith("youtube.com")) {
      if (url.pathname === "/watch") {
        const v = url.searchParams.get("v");
        return v && v.length === 11 ? v : null;
      }
      const m = url.pathname.match(/\/(embed|shorts|v)\/([a-zA-Z0-9_-]{11})/);
      if (m) return m[2];
    }
  } catch {
    return null;
  }
  return null;
}

// A short, human-friendly room code like WNP-4F2K.
export function makeRoomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++)
    code += chars[Math.floor(Math.random() * chars.length)];
  return `WNP-${code}`;
}
