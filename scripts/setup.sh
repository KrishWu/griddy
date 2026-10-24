#!/usr/bin/env bash
# One-time setup: Python venv for the backend, npm packages for the frontend.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT/backend"
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt

cd "$ROOT/frontend"
npm ci   # exact lockfile; never `npm install <pkg>` on a branch (see CLAUDE.md)
echo "Setup done. Run scripts/dev.sh and open http://localhost:3000"
