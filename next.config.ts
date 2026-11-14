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
  // The MediaPipe models (pinned by SHA-256 in scripts/copy-assets.mjs) and the sample clips are 4 to 9 MB each and
  // stand alone: a day in the browser's cache spares a phone revalidating them on every visit. The simulator's files
  // (mujoco.js with mujoco.wasm, so101.xml with its meshes) and MediaPipe's js with its wasm have unversioned names
  // and must match each other, so they keep revalidating: after a deploy, one cached half could meet a new other half.
  async headers() {
    const day = [{ key: "Cache-Control", value: "public, max-age=86400, must-revalidate" }];
    return ["/mediapipe/models/:file", "/samples/:name"].map((source) => ({ source, headers: day }));
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
