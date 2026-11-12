import type { NextConfig } from "next";

// cacheComponents stays off: the tickets rely on `export const dynamic` and `runtime` route config.
const nextConfig: NextConfig = {
  // 029 D-3: the dev server's request log never prints a searcher's coordinates (/find, /api/public/providers).
  logging: { incomingRequests: { ignore: [/[?&](lat|lng|q)=/] } },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
