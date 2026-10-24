#!/usr/bin/env bash
# Build the frontend as static files and upload them to Cloudflare Pages (project "griddy").
# Usage: scripts/deploy-frontend.sh        (first time: npx wrangler login; see deploy/cloudflare-pages)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WRANGLER=(npx --yes wrangler@4.149.0)

bash "$ROOT/deploy/cloudflare-pages/build.sh"

cd "$ROOT/deploy/cloudflare-pages"
if ! "${WRANGLER[@]}" pages project list 2>/dev/null | grep -qw griddy; then
  "${WRANGLER[@]}" pages project create griddy --production-branch main
fi
"${WRANGLER[@]}" pages deploy --branch main --commit-dirty=true
