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
  // The simulator, MediaPipe and the sample clips are 2 to 7 MB each and change only with a dependency bump or a
  // new recording; a day in the browser's cache spares a phone the round trip of revalidating each one on every visit.
  async headers() {
    const day = [{ key: "Cache-Control", value: "public, max-age=86400, must-revalidate" }];
    return ["/mujoco/:path*", "/so101/:path*", "/mediapipe/:path*", "/samples/:name"].map((source) => ({ source, headers: day }));
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
