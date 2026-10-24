import type { NextConfig } from "next";

// The FastAPI backend runs on :8000 (see scripts/dev.sh). Proxying /api/* through
// Next means the browser never needs CORS and every fetch can use a relative URL.
const API_ORIGIN = process.env.GRIDFORGE_API_ORIGIN ?? "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  // GridForge is a client-heavy single page app; keep the classic rendering model
  // so map/chart components don't trip Cache Components prerender checks.
  cacheComponents: false,
  partialPrefetching: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_ORIGIN}/api/:path*` }];
  },
};

export default nextConfig;
