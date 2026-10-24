# Griddy

_Last updated: 2026-10-24_

**Interactive energy-infrastructure planning for the AI era.** Pick a site on a real map
of California's grid, design the power supply for a 1 GW AI campus (solar, wind, gas,
batteries, grid imports), simulate every hour of a year, and see the cost, carbon, and
feasibility, with a source behind every number.

Built at the Stanford Cleantech Hackathon 2026. Live at **https://getgriddy.app**; the
[About page](https://getgriddy.app/about) explains the math, data sources and limitations.
Repo: https://github.com/KrishWu/griddy.

## What it does

- **Explore:** California's grid on a map (EIA-860 plants, transmission lines, substations,
  utility territories, the interconnection queue by county, zoning), place search, and a
  site summary with the nearest substations and lines.
- **Plan:** size a project for demand, with an ML demand forecast and ranked candidate sites
  for solar, wind, battery and gas from the site-location model.
- **Build and simulate:** presets or a custom portfolio, dispatched hour by hour over 2024
  weather, prices and grid carbon, plus stress tests (outages, heat, price spikes).
- **Evaluate:** CAPEX, OPEX, NPC, LCOE, emissions, 24/7 carbon-free-energy score and an
  electrical bill of materials, from NREL ATB 2025 and cited references.
- **Site intelligence:** Earth Engine land screening and Sentinel-2 imagery, air quality and
  nonattainment, and carbon-aware load shifting.
- **Report:** a printable report and CSV export, every number with its provenance.

The interface has Basic and Advanced modes, tabbed sidebars, Light/Dark/Mixed themes and
plain-language tooltips for jargon (settings gear in the header).

## Run it locally

```bash
scripts/setup.sh   # once: backend venv (Python 3.12-3.14, 3.13 preferred) + npm ci
scripts/dev.sh     # API on :8000, app on http://localhost:3000
```

Tests: `(cd backend && .venv/bin/pytest -q) && (cd frontend && npm run typecheck && npm run lint)`

Optional API keys (Earth Engine, AirNow, EIA, ...) go in `backend/.env`, copied from
`backend/.env.example`. Without them every feature falls back to committed data.

## How it fits together

```
frontend (Next.js 16, MapLibre, Recharts)                 backend (FastAPI)
  components/explore    /api/layers/*, /api/explore/*,       app/explore     (A)
                        /api/site/summary
  components/forecast   /api/forecast, /api/forecast/whatif  app/forecast    (A)
  components/simulate   /api/simulate, /api/stress           app/simulate    (B)
  components/sites      /api/sites, /api/sites/whatif        app/sites       (B)
  components/evaluate   /api/catalog, /api/evaluate,         app/evaluate    (C)
                        /api/evaluate/assumptions
  components/builder    /api/presets, /api/projects/plan,    app/builder     (D)
                        /api/report.csv
  components/site_intel /api/site/intel, /api/site/tiles/*,  app/site_intel  (E)
                        /api/site/carbon-aware
                        /api/run, /api/compare, /api/health  app/main.py + pipeline.py (shared)
```

`backend/app/contract.py` (mirrored in `frontend/lib/contract.ts`, exported to
`contracts/`) is the single definition of every type that crosses a module boundary.
The ML models behind the forecast and site ranking live in [`ml/`](ml/README.md).

## Deployment

- **Frontend:** static files on Cloudflare Pages (project `griddy`), served at
  https://getgriddy.app. A small Pages function forwards `/api/*` to the backend. See
  [deploy/cloudflare-pages/README.md](deploy/cloudflare-pages/README.md).
- **Backend:** FastAPI on Render's free plan (`render.yaml`), redeployed after CI passes on
  `main`. It sleeps after 15 idle minutes, so the first request can take about a minute. See
  [deploy/render/README.md](deploy/render/README.md).

## Team

The work is split into five vertical slices. See [docs/WORKSTREAMS.md](docs/WORKSTREAMS.md)
for who owns what, the integration checkpoints, and the merge process. The rules every
coding agent follows are in [CLAUDE.md](CLAUDE.md).
