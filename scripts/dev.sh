#!/usr/bin/env bash
# Start the FastAPI backend (:8000) and the Next.js frontend (:3000) together.
# Usage: scripts/dev.sh        (first run: scripts/setup.sh)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

(cd "$ROOT/backend" && exec .venv/bin/uvicorn app.main:app --reload --port 8000) &
BACKEND=$!
trap 'kill $BACKEND 2>/dev/null' EXIT

cd "$ROOT/frontend" && npm run dev
