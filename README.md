# GridForge

_Last updated: 2026-10-23_

**Interactive energy-infrastructure planning for the AI era.** Pick a site on a real map
of California's grid, design the power supply for a 1 GW AI campus (solar, wind, gas,
batteries, grid imports), simulate every hour of a year, and see the cost, carbon, and
feasibility, with a source behind every number.

Built at the Stanford Cleantech Hackathon 2026.

## Run it

```bash
scripts/setup.sh   # once: backend venv (Python 3.12-3.14, 3.13 preferred) + npm ci
scripts/dev.sh     # API on :8000, app on http://localhost:3000
```

Tests: `(cd backend && .venv/bin/pytest -q) && (cd frontend && npm run typecheck && npm run lint)`

## How it fits together

```
frontend (Next.js 16, MapLibre, Recharts)          backend (FastAPI)
  components/explore    ── /api/layers, /api/site/summary ──  app/explore      (A)
  components/builder    ── /api/presets, /api/report.csv  ──  app/builder      (D)
  components/simulate   ── /api/simulate, /api/stress     ──  app/simulate     (B)
  components/evaluate   ── /api/catalog, /api/evaluate    ──  app/evaluate     (C)
  components/site_intel ── /api/site/intel                ──  app/site_intel   (E)
                         ── /api/run, /api/compare        ──  app/pipeline.py  (shared)
```

`backend/app/contract.py` (mirrored in `frontend/lib/contract.ts`, exported to
`contracts/`) is the single definition of every type that crosses a module boundary.

## Team

The work is split into five vertical slices. See [docs/WORKSTREAMS.md](docs/WORKSTREAMS.md)
for who owns what, the integration checkpoints, and the merge process. The rules every
coding agent follows are in [CLAUDE.md](CLAUDE.md).
