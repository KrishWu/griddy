# Workstream A — Explore (GIS map + grid data)

**Mission:** a real map of California's grid that judges can click. Power plants,
transmission lines, substations. Clicking a site gives an honest summary: nearest
substation and line, distance, voltage, nearby plants.

**Branch:** `ws/a-explore` · **Check:** `python3 scripts/check_ownership.py A`

## You own

- `backend/app/explore/` (service, router, data prep scripts)
- `frontend/components/explore/` (`MapView.tsx`, `SitePanel.tsx`, legends, popups, layer toggles)
- `data/explore/` (processed GeoJSON you commit; keep each file under ~10 MB)
- `backend/tests/test_explore*.py`, `backend/requirements/a-explore.txt` (geopandas, shapely, pyproj already there)

## Contract you implement (keep these signatures)

```python
# backend/app/explore/service.py
LAYERS = ("plants", "transmission", "substations", "boundaries")
def get_layer(layer: str) -> dict            # GeoJSON FeatureCollection
def summarize_site(location: LngLat) -> SiteSummary
```

Endpoints (already wired): `GET /api/layers/{layer}`, `GET /api/site/summary?lon=&lat=`.
Feature `properties` the frontend relies on: every feature has `id` and `name`; plants have
`fuel` and `capacity_mw`; lines and substations have `voltage_kv`. Add more properties freely.

`MapView` already draws `overlays` (raster/GeoJSON layers other slices publish, e.g. E's
satellite imagery). Keep that working when you restyle the map.

## P0, in order

| # | Task | Target |
|---|---|---|
| 1 | **Plants:** EIA-860 (2024) Plant + Generator files → California, operating, ≥1 MW → one point per plant with total nameplate MW and a fuel category (solar, wind, gas, hydro, geothermal, battery, nuclear, other). Write `data/explore/plants_ca.geojson` with a prep script `backend/app/explore/prepare_plants.py`. | 1 AM |
| 2 | **Transmission:** California Energy Commission transmission lines (CC BY, `voltage_kv`, owner), simplified with shapely to keep the file small; ≥ 69 kV only. | 1 AM |
| 3 | **Substations:** OpenStreetMap `power=substation` in California via Overpass (with `voltage` parsed to kV). HIFLD substations are restricted and EIA doesn't publish locations, so OSM is the open source. Note the coverage gap in a `Provenance`. | 7 AM |
| 4 | **summarize_site:** nearest 3 substations (distance km, voltage), nearest line ≥ 230 kV (km, kV), plants within 25 km, county (point-in-polygon on a CA counties layer). Compute distances in EPSG:3310 (California Albers). Emit findings: `info` "Nearest 230 kV+ substation X km"; `warn` if > 30 km; always `needs_utility_study` on capacity. | 7 AM |
| 5 | **Map polish:** color plants by fuel and size by MW, line width by voltage, popups on feature click (clicking empty map selects a site), layer toggles, a legend, fit to California. Draw `scenario.assets[].location` markers when D adds "place asset on map". | 11 AM |
| 6 | **Boundaries:** CA counties (Census TIGER cartographic boundaries) or electric retail service territories for the `boundaries` layer. | 11 AM |

**Demo-site decision (first 15 min):** agree the default site with the team (placeholder:
Kern County, `lon -119.47, lat 35.40`), then send D the coordinates for `DEFAULT_SITE`.

**Hand-off to D:** `SiteSummary.nearest_line_km` / nearest substation distance is what D
uses to prefill `scenario.grid.interconnection_km`. Make sure it's populated.

## Stretch

- Basemap fallback: if the tile provider is down on demo day, fall back to a bundled
  minimal style with just our layers (keep a copy of the style JSON in `data/explore/`).
- Population within 10 km (Census block groups) for the community / Mode B story.
- 2.5D: extruded facility footprints sized by `land_acres_per_mw` (from C's catalog).
- LBNL "Queued Up" interconnection-queue projects as a "what's already proposed nearby"
  layer (it has county, not coordinates: aggregate per county).

## Data sources

| Source | Use | Link |
|---|---|---|
| EIA-860 (annual ZIP, Plant + Generator xlsx) | Plant points, capacity, fuel, status | https://www.eia.gov/electricity/data/eia860/ |
| PUDL (cleaned EIA-860/923) | Faster alternative to raw EIA spreadsheets | https://catalyst.coop/pudl/ |
| CEC California transmission lines (CC BY) | Line geometry, voltage, owner | data.ca.gov (search "California Electric Transmission Lines") |
| HIFLD transmission lines (archived) | Backup / validation for lines | https://portal.datarescueproject.org/datasets/hifld-open-transmission-lines/ |
| OpenStreetMap via Overpass | Substations (and lines/plants to cross-check) | https://overpass-turbo.eu |
| OpenInfraMap | Eyeball OSM power coverage before you download | https://openinframap.org |
| EIA US Energy Atlas | More layers, quick sanity checks | https://atlas.eia.gov |

Licensing: OSM is ODbL. Credit "© OpenStreetMap contributors" in the map attribution.
Keep each feature's source and date in its properties.

## Done means

- `backend/tests/test_explore.py`: every layer is non-empty, features have `id`/`name`,
  and `summarize_site` at the demo site returns a substation within 50 km.
- The map loads in < 3 s, and clicking anywhere in CA shows a real summary.
