import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      /* Rooms are private and ephemeral, and the lobby/vent boards are live
         feeds — indexing them buries the pages that should actually rank. */
      disallow: ["/room/", "/lobby", "/vent"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
