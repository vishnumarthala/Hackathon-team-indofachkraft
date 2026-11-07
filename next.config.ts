import type { NextConfig } from "next";

// cacheComponents stays off: the tickets rely on `export const dynamic` and `runtime` route config.
const nextConfig: NextConfig = {
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
