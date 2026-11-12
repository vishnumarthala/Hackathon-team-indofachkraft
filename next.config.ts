import type { NextConfig } from "next";

// cacheComponents stays off: the tickets rely on `export const dynamic` and `runtime` route config.
const nextConfig: NextConfig = {
  // 020 FR-18c: the proxy buffers request bodies (default 10 MB); paper consent scans may be 10 MB plus
  // multipart overhead.
  experimental: { proxyClientMaxBodySize: "12mb" },
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
