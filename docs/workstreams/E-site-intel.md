# Workstream E — Site Intelligence (satellite, air, carbon) + Pitch

**Mission:** use the hackathon's own resources (Google Earth Engine, Planet, AirNow, Green
Software Foundation) to answer "is this land and this air shed a good place to build, and
how much cleaner can the data center run?" You also own the Devpost and pitch, which
is half the score.

**Branch:** `ws/e-site-intel` · **Check:** `python3 scripts/check_ownership.py E`

## You own

- `backend/app/site_intel/` (`service.py`, `router.py`, Earth Engine/AirNow/carbon helpers)
- `frontend/components/site_intel/` (`SiteIntelPanel.tsx`, carbon-aware panel)
- `data/site_intel/` (cached results for the demo site so the demo never depends on a live API)
- `docs/pitch/` (Devpost text, slide outline, demo script, screenshots)
- `backend/tests/test_site_intel*.py`, `backend/requirements/e-site-intel.txt` (earthengine-api already there)

## Contract you implement (keep this signature)

```python
# backend/app/site_intel/service.py
def site_intel(location: LngLat) -> SiteIntel
```

Endpoint (already wired): `GET /api/site/intel?lon=&lat=`. `SiteIntel.overlays` is a list
of `MapOverlay`. A raster overlay with an XYZ `url` is drawn on the map automatically by
A's `MapView`, so you never touch the map code.

New endpoints (e.g. carbon-aware shifting) go in your own `router.py`; call them from
your panel with `post()` from `frontend/lib/api.ts`. Return new outputs in
`SiteIntel.extras` or your own router's response. If a typed contract field is truly
needed, follow CLAUDE.md §2 (a separate `contract/<what>` PR to main), never in your feature PR.

Findings that need the scenario's *results* (like `AIR_PERMIT_RISK`) go in
`site_findings(scenario, sim, evaluation)` in your `service.py`. The pipeline calls it on
every run and puts its findings in the results, the stress panel and the report. It runs
on every run and compare, so use cached data only (no live API calls), and if it raises,
the run still succeeds.

## P0, in order

| # | Task | Target |
|---|---|---|
| 1 | **Earth Engine setup:** register a Google Cloud project for noncommercial Earth Engine use, `earthengine authenticate`, put `EE_PROJECT=...` in `backend/.env`. Do this first; approval can take a while. | 10 PM |
| 2 | **Land screening** (2 km buffer around the site): ESA WorldCover 10 m class shares (`ESA/WorldCover/v200`), fallowed/idle cropland from USDA CDL (`USDA/NASS/CDL`, class 61), mean slope from USGS 3DEP 10 m (`USGS/3DEP/10m`), protected areas (`WCMC/WDPA/current/polygons`), surface water (`JRC/GSW1_4/GlobalSurfaceWater`). Findings: slope > 5° → warn for PV; active cropland → "farmland conversion" warn; fallowed land → `pass` ("build on degraded land"); protected/water/built-up → fail. | 1 AM |
| 3 | **Imagery overlay:** (cache per site keyed on lat/lon rounded to 0.01°, never `site.id`) a 2024 Sentinel-2 true-color composite (or NAIP ~0.6 m, `USDA/NAIP/DOQQ`) as `MapOverlay(type="raster", url=...)`. **Live:** call `getMapId()` on every request; never store its URL, because Earth Engine map IDs expire after a few hours. **Offline fallback:** a one-off prep script downloads that layer's tiles for the demo site's 2 km box at z12–z16 into `data/site_intel/tiles/{z}/{x}/{y}.png` (keep it under ~10 MB; Sentinel-2/NAIP are fine to commit, Planet is not). Serve them from `GET /api/site/tiles/{z}/{x}/{y}.png` in your router (404 when missing) and return `url="/api/site/tiles/{z}/{x}/{y}.png"` when Earth Engine isn't available; `MapView` handles relative URLs. | 7 AM |
| 4 | **AirNow:** current AQI near the site (free API key; ~500 requests/hour, so snapshot and cache) → finding. Then emit the `AIR_PERMIT_RISK` warning from `site_findings()`: read C's `evaluation.extras["nox_t_per_yr"]` (and `"pm25_t_per_yr"`; metric tons/yr, `0.0` without gas, available from 7 AM) and fire when it's > 0 at a site in a nonattainment area (cached AQI + EPA Green Book status). Context worth stating: the San Joaquin Valley is a federal nonattainment area for ozone and PM2.5, so on-site gas has a local air cost, not just a carbon one. | 7 AM |
| 5 | **Carbon-aware load shifting** (Green Software Foundation): given `demand.flexible_share` and B's hourly `grid_co2_kg_per_mwh`, shift flexible load within each day to the cleanest hours and report avoided t CO2e/yr and an SCI score per GPU-hour (SCI = (E × I + M) per functional unit; ISO/IEC 21031). Implement the shift natively in Python with an API shaped like the Carbon Aware SDK's "best window"; the SDK itself needs .NET/Docker, so that's stretch. Show it as a panel with a slider. (Agree with B on average vs. marginal carbon; WattTime is free for CAISO_NORTH.) **Demo it on Grid-connected or Renewable-heavy, not Hybrid:** in Hybrid, imports are small and solar is rarely curtailed, so shifting load saves almost nothing. | 11 AM |
| 6 | **Pitch + Devpost:** problem → product → demo → impact → scale. Hook: LBNL *Queued Up* finds only ~13% of capacity that requested interconnection in 2000–2020 had reached commercial operation by end-2025, and the median wait was over 5 years. GridForge screens sites *before* they join the queue. (These figures come from the team's research notes; confirm them on the LBNL page before they go on a slide.) Credit sponsors' relevance (TotalEnergies, SVCE, SE Ventures). Screenshots + a backup screen recording by 2 PM. | 2 PM |

## Stretch (high creativity score, the "ML on satellite data" angle)

- **Solar-farm look-alike search** with Google's AlphaEarth Satellite Embeddings
  (`GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL`, 64-dim per 10 m pixel, CC BY 4.0): take
  embeddings at known CA solar farms (A's EIA-860 plants), score how similar each pixel
  within 25 km is → heatmap overlay + "site similarity score". Attribution: "The
  AlphaEarth Foundations Satellite Embedding dataset is produced by Google and Google DeepMind."
- Planet daily 4 m imagery (education access) for a recent close-up of the parcel.

## Rules for sponsor integrations

- `site_intel()` must **never raise**. Wrap every external call (Earth Engine, Planet,
  AirNow, WattTime) with a timeout; on failure return the cached result for the demo
  site or a `warn` finding saying what's missing.
- **Planet imagery licensing:** never commit imagery to the repo (the repo is public).
  Keep scenes in `data/site_intel/cache/` (git-ignored), keep the API key server-side (`backend/.env`), and
  show "Imagery © Planet Labs PBC" wherever a scene appears.
- Kill-time: if Earth Engine auth isn't working by 2 AM, ship the cached fallback and move on.

## Data sources

| Source | Use | Link |
|---|---|---|
| Google Earth Engine + catalog | WorldCover, 3DEP, WDPA, Sentinel-2, NAIP, Satellite Embeddings | https://code.earthengine.google.com · https://developers.google.com/earth-engine/datasets/ |
| Hackathon GEE/Planet workshop repo | Working starter code | https://github.com/mapninja/The_101s_GEE_Planet |
| Planet (education access) | Daily 4 m multispectral imagery | Stanford: https://forms.gle/oTMeMi4zTqcD4U9n8 · others: https://www.planet.com/industries/education-and-research/ |
| AirNow API | Current/forecast AQI by lat/lon | https://docs.airnowapi.org/ |
| Carbon Aware SDK / SCI | Method + vocabulary for carbon-aware shifting | https://carbon-aware-sdk.greensoftware.foundation/ · https://sci-guide.greensoftware.foundation/ |
| WattTime | Marginal CO2 for CAISO_NORTH (free tier) | https://docs.watttime.org |
| LBNL Queued Up | Pitch statistic (CC BY 4.0: credit LBNL & GridTracker) | https://emp.lbl.gov/queues |

## Done means

- Clicking the demo site shows land-cover shares, slope, AQI, and a satellite overlay on
  the map, even with no network (cached fallback).
- The carbon-aware panel shows a believable t CO2e/yr saving for a 30% flexible load.
- Devpost draft, slide outline and backup video exist in `docs/pitch/` by 2 PM.
