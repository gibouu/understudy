import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // lib/unlock/check.ts hashes the sample clips so they label live without the unlock code;
  // lib/showcase/lookup.ts reads the recordings these routes answer at once
  outputFileTracingIncludes: {
    "/api/label": ["./samples/*.mp4", "./public/showcase/*.json"],
    "/api/notes": ["./public/showcase/*.json"],
    "/api/variants": ["./public/showcase/*.json"],
    "/api/compile": ["./public/showcase/*.json"],
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
