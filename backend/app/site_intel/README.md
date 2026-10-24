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

## GriddyGrade: power plant site feasibility score (frontend)

The GriddyGrade screens the selected site for a proposed generation project (technology and
nameplate MW, set on the card; default solar PV at 100 MW) in the browser, from data already
loaded: A's site summary and this module's site intel. No extra endpoint, so a technology or
capacity change only recomputes. S = 0.30 G (grid interconnection proximity) + 0.30 R
(technology-specific resource and operating prerequisites) + 0.20 E (environmental and permitting
screening) + 0.15 C (community exposure proxy) + 0.05 I (administrative context). Land suitability
is excluded from the score and from data completeness. Critical constraints are assessed apart
from the score, so a high score can't average them away. Layers: `feasibilityPolicy.ts` (versioned
weights, voltage-search tiers, ATB reference ranges, mappings, constraint checks),
`feasibilityInput.ts` (summary + intel → SiteData, every input with a SourceState), `feasibility.ts`
(pure math, `calculatePowerPlantFeasibility(siteData, project, policy)`), `ProjectControls.tsx`,
`GriddyGradeCard.tsx` and `GriddyGradeDetails.tsx` (rendering). The numbers are initial product
heuristics, not validated predictions. The score relies on `extras["nonattainment_available"]`
here so that a Green Book layer that failed to load isn't read as attainment.

**Grid tiers** (`grid_tiers.py` → `extras["grid_tiers"]`, offline): the nearest qualifying
substation and operational AC line at 69, 115 and 220 kV, from A's layers (read-only). The card
picks the tier for the project size (≤ 20 MW 69 kV, ≤ 100 MW 115 kV, larger 220 kV); untagged or
lower-voltage assets never qualify.

**Model signals** (`ml.py` → `extras["ml"]`, a few ms, offline): the site's own 5 km cell of B's
site artifact (`ml/artifacts/site_location/LATEST`, at most 5 km away, so none outside California)
gives the trained models' siting similarity per technology (solar, wind, gas; an inferred
submetric of R), the cell's ERA5 2024 annual GHI and 100 m wind with their basis (GHI is scored on
ATB's PV resource classes; the ~50 km, 100 m wind is shown but not scored, since ATB's wind classes
are at 110 m from a terrain-resolving dataset) and the county's interconnection queue (LBNL; context,
plus a `needs_utility_study` finding at 10 GW or more). The cell's nonattainment flag and grid
distances are not used (E and A already provide those).

**Percentile.** `GriddyGradeCard.tsx` leads with the score's percentile among plausible California
sites for the same technology and voltage tier (5 km cells inside a utility territory within 50 km
of a qualifying line), with the 0-100 score and its components in `GriddyGradeDetails.tsx`.
`percentile.ts` reads `gradePercentiles.json`: 101 cut-offs per technology and tier, using the
middle of a tied range. Rebuild it after changing the policy, the formula or the artifacts (about
3 min; Node >= 22.18 runs the same TypeScript on every cell, so it can't drift from the live grade):
`python -m app.site_intel.prep.grade_percentiles --node <node>` (`--reuse` skips rebuilding the cells).
`python -m app.site_intel.prep.check_recommended --node <node>` grades B's recommended sites for the
technology and MW B recommends there (batteries are storage, so they are not scored).

**California only.** `regionGuard.ts` keeps the selected site inside California plus a 2 km Pacific
margin (`caOutline.json`, from `python -m app.site_intel.prep.region`); D's `selectSite` calls it,
and the card says why a click was refused.

Tests: `node --test components/site_intel/feasibility.test.mjs` and `percentile.test.mjs` from
`frontend/` (Node >= 22.18); `tests/test_site_intel_feasibility.py` runs them inside pytest when such
a Node is on PATH; `tests/test_site_intel_ml.py` covers the model signals, `test_site_intel_grid_tiers.py`
the tier search and `test_site_intel_recommended.py` the recommended-site check.

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
