import type { NextConfig } from "next";

// The FastAPI backend runs on :8000 (see scripts/dev.sh). Proxying /api/* through
// Next means the browser never needs CORS and every fetch can use a relative URL.
const API_ORIGIN = process.env.GRIDFORGE_API_ORIGIN ?? "http://127.0.0.1:8000";

// STATIC_EXPORT=1 builds plain files into out/ for Cloudflare Pages (scripts/deploy-frontend.sh).
// Static exports can't rewrite, so there deploy/cloudflare-pages/functions forwards /api/*.
const STATIC_EXPORT = process.env.STATIC_EXPORT === "1";

const nextConfig: NextConfig = {
  // Griddy is a client-heavy single page app; keep the classic rendering model
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
  ...(STATIC_EXPORT
    ? { output: "export" as const }
    : {
        async rewrites() {
          return [{ source: "/api/:path*", destination: `${API_ORIGIN}/api/:path*` }];
        },
      }),
};

export default nextConfig;
