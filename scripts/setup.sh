#!/usr/bin/env bash
# One-time setup: Python venv for the backend, npm packages for the frontend.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT/backend"
# Any Python 3.12-3.14 works (3.13 preferred; gridstatus caps the top end).
ok='import sys; sys.exit(not (3,12) <= sys.version_info[:2] < (3,15))'
PY=
for c in ${PYTHON:-} python3.13 python3.12 python3.14 python3; do
  command -v "$c" >/dev/null 2>&1 && "$c" -c "$ok" && { PY=$c; break; }
done
[ -n "$PY" ] || { echo "Need Python 3.12-3.14 (3.13 preferred): brew install python@3.13" >&2; exit 1; }
.venv/bin/python -c "$ok" 2>/dev/null || "$PY" -m venv --clear .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt

cd "$ROOT/frontend"
npm ci   # exact lockfile; never `npm install <pkg>` on a branch (see CLAUDE.md)
echo "Setup done. Run scripts/dev.sh and open http://localhost:3000"
