#!/usr/bin/env bash
# Build the static frontend into deploy/cloudflare-pages/out. Cloudflare's GitHub builds
# (build command: bash build.sh, root directory: deploy/cloudflare-pages) only accept an
# output folder inside the root directory; scripts/deploy-frontend.sh runs this too.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../../frontend"
[ -d node_modules ] || npm ci # fresh clones (Cloudflare); never reinstalls a dev checkout
# MapLibre's worker file is git-ignored and only copied into public/ by npm ci's postinstall, so a
# checkout whose node_modules came from elsewhere would ship without it and the map would not draw
# (deployment 89424c49 did). Copy it on every build.
npm run --silent postinstall
rm -rf out && STATIC_EXPORT=1 npm run build
rm -rf "$HERE/out" && cp -R out "$HERE/out"
if [ ! -s "$HERE/out/maplibre-gl-worker.mjs" ]; then
  echo "build.sh: out/maplibre-gl-worker.mjs is missing, so the map would not draw; refusing to deploy this build." >&2
  exit 1
fi
