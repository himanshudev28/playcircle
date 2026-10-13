import type { MetadataRoute } from "next";
import { SITE_DESCRIPTION_SHORT, SITE_NAME } from "@/lib/site";

/* Makes PlayCircle installable (home-screen icon, full-screen launch).
   Installing doesn't unlock anything the browser can't already do — phones
   still can't capture their screen from a web page. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: SITE_NAME,
    short_name: SITE_NAME,
    description: SITE_DESCRIPTION_SHORT,
    start_url: "/lobby",
    scope: "/",
    display: "standalone",
    background_color: "#060505", // --color-ink
    theme_color: "#060505",
    categories: ["entertainment", "social"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icons/maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      { name: "Create a room", url: "/join", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Public lobbies", url: "/lobby", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
