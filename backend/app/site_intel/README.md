# Site intelligence (workstream E)

Answers "is this land and this air shed a good place to build, and how much cleaner can
the campus run?" for a clicked site. Brief: `docs/workstreams/E-site-intel.md`.

## Setup (once)

1. **Earth Engine project.** Register a Google Cloud project for noncommercial Earth Engine
   use at <https://code.earthengine.google.com/register> and enable the Earth Engine API.
2. **Log in** from `backend/`: `.venv/bin/earthengine authenticate --auth_mode=localhost`
   (Windows: `.venv\Scripts\earthengine`). Credentials land in `~/.config/earthengine/`.
   A service account works too: set `EE_SERVICE_ACCOUNT_KEY=<path to its JSON key>`.
3. **`backend/.env`** (git-ignored; copy `backend/.env.example`):
   `EE_PROJECT=<your project id>`, and optionally `AIRNOW_API_KEY=` (<https://docs.airnowapi.org/>).
4. **Check:** `.venv/bin/python -m app.site_intel.earthengine` prints `Earth Engine OK`.

Nothing here is required for the app to run: without keys every part falls back to the
committed offline data in `data/site_intel/` or returns a finding saying what's missing.

## How a click is answered

`GET /api/site/intel?lon=&lat=` → `site_intel()` in `service.py` runs three sources in
parallel (30 s overall deadline, shorter per-call timeouts) and never raises:

| Part | Module | Order of preference |
|---|---|---|
| Land screening, 2 km buffer: WorldCover land cover, CDL fallow vs active cropland, 3DEP slope, protected areas, JRC surface water, ERA5 solar resource | `land.py`, thresholds in `screening.py` | committed demo-area grid → runtime cache → live Earth Engine → `warn` finding |
| Satellite overlay (Sentinel-2 2024 true color) | `imagery.py` | live Earth Engine `getMapId()` (never stored: map ids expire) → cached tiles at `/api/site/tiles/{z}/{x}/{y}.png` → `info` finding |
| Air quality + EPA nonattainment | `air.py` | live AirNow (key, 1 h cache) → AirNow public-file snapshot → `info` finding; nonattainment from committed EPA Green Book polygons |

Cache keys are the site's lat/lon rounded to 0.01° (`config.site_key`), never `site.id`.

`site_findings()` adds, on every `/api/run` and `/api/compare`, from cached data only:
`AIR_PERMIT_RISK` (on-site gas NOx from C's `evaluation.extras["nox_t_per_yr"]` in a
nonattainment area) and `carbon_aware_shift` (when `demand.flexible_share > 0`).

`POST /api/site/carbon-aware` (`carbon.py`) shifts the flexible share of each day's load
to its cleanest hours and reports avoided t CO2e/yr and an SCI score per GPU-hour.

## GriddyGrade: data center feasibility score (frontend)

The GriddyGrade scores the selected site 0-100 in the browser from data already loaded: A's site
summary and this module's site intel. No extra endpoint, so it follows the scenario's load
instantly. GriddyGrade = 0.36 grid + 0.25 generation + 0.17 community exposure + 0.17 air quality /
permitting + 0.05 utility / balancing authority (land is not scored), capped at 35 when both the
nearest 220 kV+ substation and line are 20 km or more away. `feasibility.ts` holds the pure
scoring math (weights, thresholds, missing-data rules); `feasibilityInput.ts` maps the summary and
intel onto it. The weights are initial product heuristics, not validated predictions. The score
relies on `extras["nonattainment_available"]` here so that a Green Book layer that failed to load
isn't read as attainment.

**Model signals** (`ml.py` → `extras["ml"]`, a few ms, offline): the nearest 5 km cell of B's site
artifact (`ml/artifacts/site_location/LATEST`, at most 5 km away, so none outside California)
gives the county's interconnection queue (LBNL Queued Up; a congestion penalty on G, up to 25%
off, and a `needs_utility_study` finding at 10 GW or more) and the best solar / wind / battery
suitability within 25 km (30% of P, labeled a similarity score; gas is left out). A's demand
forecast (`mid`, 2035, P50 first: its P10-P90 band is too narrow) gives the region's demand
pressure, shown as context and never scored. The cell's nonattainment flag and grid distances are
not used (E and A already score those). Without the signals the grade falls back to the rules alone
and data completeness is unchanged.

**Percentile.** `GriddyGradeCard.tsx` leads with the grade's percentile among plausible California
sites (5 km cells within 50 km of a 220 kV+ line, inside a utility territory), with the raw grade
and its components in `GriddyGradeDetails.tsx`. `percentile.ts` interpolates in
`gradePercentiles.json`: 101 cut-offs per tabulated load (25-2,000 MW), using the middle of a tied
range. Rebuild it after changing the formula or the artifacts (about 90 s; Node >= 22.18 runs the
same TypeScript on every cell, so it can't drift from the live grade):
`python -m app.site_intel.prep.grade_percentiles --node <node>` (`--reuse` skips rescoring the cells).

**California only.** `regionGuard.ts` keeps data centers inside California plus a 2 km Pacific
margin (`caOutline.json`, from `python -m app.site_intel.prep.region`); D's `selectSite` calls it,
and the card says why a click was refused.

Tests: `node --test components/site_intel/feasibility.test.mjs` and `percentile.test.mjs` from
`frontend/` (Node >= 22.18); `tests/test_site_intel_feasibility.py` runs them inside pytest when such
a Node is on PATH, and `tests/test_site_intel_ml.py` covers the model signals.

## Offline data (`data/site_intel/`)

Committed, small, regenerated by the prep scripts (from `backend/`, after
`.venv/bin/pip install -r app/site_intel/prep/requirements.txt`; land and imagery need
Earth Engine):

| Data | Script |
|---|---|
| `areas/<site>.json`: Earth Engine screening grid (11 × 11 cells at 0.01°, ~12 km square) around each demo site; 25 s for all three | `python -m app.site_intel.prep.land --site all` |
| `tiles/{z}/{x}/{y}.png` + `tiles/meta.json`: the live Sentinel-2 layer's tiles, z12–z16, 5 km box (~1.2 MB) | `python -m app.site_intel.prep.imagery --site kern` |
| `nonattainment_ca.geojson`, `airnow_snapshot.json` | `python -m app.site_intel.prep.air` |

When the team picks the demo site, rerun the imagery script for it. `raw/` and `cache/`
are git-ignored.
