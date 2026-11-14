import type { NextConfig } from "next";

// cacheComponents stays off: the tickets rely on `export const dynamic` and `runtime` route config.
const nextConfig: NextConfig = {
  // 020 FR-18c: the proxy buffers request bodies (default 10 MB); paper consent scans may be 10 MB plus
  // multipart overhead.
  // 046: `authInterrupts` enables forbidden() (a real 403 for pages members may not see, e.g. /dashboard/payouts).
  experimental: { proxyClientMaxBodySize: "12mb", authInterrupts: true },
  // 029 D-3: the dev server's request log never prints a searcher's coordinates (/find, /api/public/providers).
  // 041 NFR-2: nor URLs that carry a bearer token in the path (intake, referral, invitation and claim links).
  logging: {
    incomingRequests: {
      ignore: [/[?&](lat|lng|q)=/, /\/(intake|specialist|invite|claim)\/[^/?#]{16,}/, /\/api\/(intake|claims)\/[^/?#]{16,}/],
    },
  },
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
