/* ICE servers for WebRTC (calls, live sharing, the Android app's screen
   share). STUN finds a direct path; when two devices can't reach each other
   (mobile data, strict routers) a TURN relay carries the media instead.

   All optional, all server-side env so secrets stay out of the JS bundle:
   - TURN_URLS +        A relay with a fixed login (e.g. ExpressTURN's free
     TURN_USERNAME +    tier): comma-separated turn: URLs plus the username
     TURN_CREDENTIAL    and password from its dashboard.
   - ICE_SERVERS        JSON array of RTCIceServer, for anything else.
   - METERED_APP +      Metered (paid tiers): short-lived credentials fetched
     METERED_API_KEY    from https://<app>.metered.live, cached for a while.
   Leftover NEXT_PUBLIC_ICE_SERVERS still works. */

export const dynamic = "force-dynamic";

type IceServer = { urls: string | string[]; username?: string; credential?: string };

const STUN: IceServer = {
  urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"],
};
const METERED_TTL = 10 * 60_000;

let metered: { servers: IceServer[]; at: number } | null = null;

function parseList(raw: string | undefined): IceServer[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((s) => s && s.urls) : [];
  } catch {
    return [];
  }
}

async function meteredServers(): Promise<IceServer[]> {
  const app = process.env.METERED_APP;
  const key = process.env.METERED_API_KEY;
  if (!app || !key) return [];
  if (metered && Date.now() - metered.at < METERED_TTL) return metered.servers;
  try {
    const res = await fetch(
      `https://${encodeURIComponent(app)}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(key)}`,
      { signal: AbortSignal.timeout(4000), cache: "no-store" }
    );
    if (!res.ok) throw new Error(`metered ${res.status}`);
    const list = await res.json();
    const servers: IceServer[] = Array.isArray(list) ? list.filter((s) => s && s.urls) : [];
    metered = { servers, at: Date.now() };
    return servers;
  } catch {
    // A stale list beats none: its credentials usually outlive the cache.
    return metered?.servers ?? [];
  }
}

function fixedTurn(): IceServer[] {
  const urls = (process.env.TURN_URLS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter((u) => /^turns?:/.test(u));
  const username = process.env.TURN_USERNAME?.trim();
  const credential = process.env.TURN_CREDENTIAL?.trim();
  if (!urls.length || !username || !credential) return [];
  return [{ urls, username, credential }];
}

export async function GET() {
  const relays = [
    ...fixedTurn(),
    ...parseList(process.env.ICE_SERVERS),
    ...parseList(process.env.NEXT_PUBLIC_ICE_SERVERS),
    ...(await meteredServers()),
  ];
  return Response.json(
    { iceServers: [STUN, ...relays] },
    { headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } }
  );
}
