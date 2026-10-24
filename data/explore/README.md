# Explore data (workstream A)

Processed, committed layers behind the map and `summarize_site()`. Each file is rebuilt by
a prep script from public sources. Raw downloads are cached in `data/explore/raw/`, which is
git-ignored.

Map search also uses `places_ca.json`: 1,618 California place names and representative
coordinates from the [2024 Census Gazetteer](https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_gaz_place_06.txt).
Rebuild with `python -m app.explore.prepare_places` from `backend/`. Search combines
these places with county and named infrastructure layers; it makes no external
geocoding requests and does not provide street-address lookup.

Zoning is loaded only on request for a highlighted area of up to 100 km². The
streaming endpoint returns processed pages incrementally, clips geometry to the
selection, simplifies boundaries for screening and limits rendering complexity.
Partial coverage and source outages are disclosed. Source zoning dates remain
visible in popups; it does not establish current permitted land uses.

```bash
cd backend
.venv/bin/python -m app.explore.prepare_plants        # Windows: .venv/Scripts/python
.venv/bin/python -m app.explore.prepare_transmission
.venv/bin/python -m app.explore.prepare_substations
.venv/bin/python -m app.explore.prepare_boundaries    # counties, utilities, balancing authorities
.venv/bin/python -m app.explore.prepare_population
.venv/bin/python -m app.explore.prepare_queue         # LBNL interconnection queue by county
```

The prep scripts need `openpyxl` (in `requirements/a-explore.txt`). The API reads only the
files below, so it makes no network calls at runtime.

| File | Source | License | Vintage | Contents |
|---|---|---|---|---|
| `plants_ca.geojson` | [EIA-860 2024](https://www.eia.gov/electricity/data/eia860/) Plant + Generator (Operable) | Public domain (US gov) | Status at end of 2024 | One point per California plant with at least 1 MW of operating (`OP`) nameplate capacity. Fuel = the category with the most operating MW. |
| `transmission_ca.geojson` | [CEC California Electric Transmission Lines](https://cecgis-caenergy.opendata.arcgis.com/datasets/CAEnergy::california-electric-transmission-lines-1) | CC BY 4.0, California Energy Commission | Last edited 2025-07-10 | Lines of 69 kV and above, simplified to about 10 m. `operational` is false for proposed or closed lines. |
| `substations_ca.geojson` | OpenStreetMap `power=substation` via the Overpass API | ODbL, © OpenStreetMap contributors | Snapshot 2026-10-24 | Points inside California, plus up to 2 km into Nevada, Arizona and Oregon (Mexico is excluded). Traction, minor-distribution and street-cabinet substations are excluded. Voltage is dropped from bare, untagged nodes. |
| `counties_ca.geojson` | US Census cartographic boundaries, 1:500k | Public domain | 2024 | The 58 counties (the map's `boundaries` layer). |
| `utilities_ca.geojson` | [CEC Electric Load Serving Entities (IOU & POU)](https://services3.arcgis.com/bWPjFyq029ChCGur/arcgis/rest/services/ElectricLoadServingEntities_IOU_POU/FeatureServer/0) | CEC open data | Layer edited 2026-09-04 | Retail service territories. `special_purpose` marks water-agency suppliers that overlap a retail utility. |
| `balancing_authorities_ca.geojson` | [CEC Balancing Authority areas](https://services3.arcgis.com/bWPjFyq029ChCGur/arcgis/rest/services/Balancing_Authority/FeatureServer/0) | CEC open data | Boundaries as of 2021-08-03 | Lookup only: CAISO, BANC, LADWP, IID, TIDC, PACW, NEVP, WALC. |
| `population_bg_ca.csv` | [2020 Census population-weighted block-group centroids](https://www2.census.gov/geo/docs/reference/cenpop2020/blkgrp/CenPop2020_Mean_BG06.txt) | Public domain | 2020 Census | `lon,lat,population` for each block group. Used for the population-within-10-km estimate. |
| `queue_ca_by_county.json` | [LBNL "Queued Up" 2026 Edition](https://emp.lbl.gov/queues) data file (requests through end of 2025) | CC BY 4.0, LBNL / GridTracker | Through 2025-12-31 | Active transmission-level interconnection requests in California, aggregated by county: count, MW by type, and the largest projects. Rebuilt by `prepare_queue`. |
| `basemap_fallback.json` | Hand-written MapLibre style | — | — | Plain background the map switches to if the OpenFreeMap basemap is unreachable. |

## Caveats to say out loud

- **Substations are volunteer-mapped.** HIFLD substations are restricted, and EIA publishes no
  substation locations, so OpenStreetMap is the only open source. About half of the OSM
  substations have no voltage tag and two-thirds have no name. Some may be missing entirely.
- **"220 kV+" means the 230 kV class and above.** SCE's backbone runs at 220 kV, so a strict
  230 kV cutoff would skip it entirely.
- **Queue MW is requested capacity, not a forecast.** Per LBNL, only about 13% of capacity
  requested in 2000–2020 was ever built.
- **Distances are straight lines** in EPSG:3310 (California Albers). Real gen-tie routes are
  longer, so treat them as lower bounds.
- **No capacity data.** Public maps show where lines and substations are, not how much spare
  capacity they have. That is why every site summary carries a `needs_utility_study` finding.
- **Plant capacity is nameplate.** That totals about 99 GW statewide, including about 12 GW of
  batteries; net summer capacity is lower. Status is as of the end of 2024, so for example the
  Moss Landing battery is shown as operating even though the January 2025 fire damaged part of it.
