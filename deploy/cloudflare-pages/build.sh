#!/usr/bin/env bash
# Build the static frontend into deploy/cloudflare-pages/out. Cloudflare's GitHub builds
# (build command: bash build.sh, root directory: deploy/cloudflare-pages) only accept an
# output folder inside the root directory; scripts/deploy-frontend.sh runs this too.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../../frontend"
[ -d node_modules ] || npm ci # fresh clones (Cloudflare); never reinstalls a dev checkout
rm -rf out && STATIC_EXPORT=1 npm run build
rm -rf "$HERE/out" && cp -R out "$HERE/out"
