import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev only: lets a second browser identity on 127.0.0.1 (separate
  // localStorage from localhost) load the dev assets when testing rooms.
  allowedDevOrigins: ["127.0.0.1"],
  images: {
    // Object form rather than `new URL(...)`: the custom server in server.js
    // loads this config programmatically, and URL instances don't survive
    // that path — plain data does.
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "plus.unsplash.com" },
      { protocol: "https", hostname: "i.ytimg.com" },
    ],
  },
};

export default nextConfig;
