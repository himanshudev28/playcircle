import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
