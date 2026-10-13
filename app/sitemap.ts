import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/* Only the two pages that are stable, public, and worth ranking. Room URLs
   are per-session and the lobby/vent feeds change by the minute. */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  return [
    {
      url: `${SITE_URL}/`,
      lastModified,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/join`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.8,
    },
  ];
}
