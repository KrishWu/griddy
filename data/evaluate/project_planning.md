# Demand-led project planning

`feature/project-planning` integrates A/B/C/D under the user's cross-workstream
request. Shared API contracts, pipeline signatures and dependency manifests stay
unchanged. Inputs use `Scenario.options.project` and `.area`; outputs use
`EvaluationResult.extras.project` and `SimulationResult.extras.resilience`.

## UI and endpoints

- Basic mode starts with a demand-led planner, selected-zone demographics, map,
  cost, power, emissions and feasibility headlines. Advanced mode exposes the
  existing builder, assumptions, dispatch, full economics, site intelligence and
  stress panels. Both modes share one scenario and report.
- Highlight area: click two opposite corners on the map. The rectangular polygon
  becomes `site.footprint`; its center selects the project site.
- `POST /api/projects/plan`: scenario, plant_type (`solar_storage`, `wind_storage`,
  `hybrid`, `gas_cc`, `gas_ct`), renewable_energy_share, storage_hours,
  reserve_margin and project assumptions. Returns a candidate scenario plus
  projected-demand hourly screening. “Use this design” applies the candidate;
  results thereafter evaluate current demand using the future-sized assets.
- `POST /api/explore/area`: footprint, persons_per_household,
  household_kwh_per_year and load_factor. Returns Census-based population and
  inferred household/residential demand. “Use zone’s residential demand” changes
  the community demand profile; it does not assert a service contract.
- `POST /api/explore/zoning/stream`: explicitly load a highlighted area of at most
  100 km². NDJSON sends each processed page of up to 50 features before requesting
  the next page. Polygons are clipped and simplified to about 4 m, with at most
  200 features per regional service and 30,000 coordinates in total. MapLibre adds
  each page with `updateData` and stable IDs. Stop preserves already loaded zones.
  Panning does not fetch again; changing the selection clears previous coverage.
  Upstream pages have a five-minute cache. Partial and unavailable states are
  explicit. GET `/api/explore/zoning` remains available for bounded queries.
- Map search is offline: 1,618 California places from the Census 2024 Gazetteer,
  bundled county/plant/substation names and latitude, longitude coordinates.
  Searches move the camera; click the map to change the project site.
- Light and Dark themes use explicit persisted preferences, separate forest/ivory
  and navy/cyan palettes, and corresponding OpenFreeMap basemaps. Switching theme
  restores selected-area zoning without requesting the data again.

## Calculations and limits

**Sizing:** demand grows by `(1 + annual_growth)^projection_years`. Mean demand
and per-MW renewable capacity factors come from the hourly site profiles. Solar
and wind capacity = projected average load × gross renewable target × technology
share / site capacity factor. Hybrid uses 60% solar / 40% wind energy shares.
Battery power = projected peak × max(renewable target, 0.25), with entered duration.
Gas fills projected peak × (1 + reserve margin) less connected import capacity,
derated 5% CC / 8% CT. Pure renewable designs preserve the entered grid connection;
they are allowed to fail hourly checks rather than silently add fossil power.
Budget and land constraints and the critical-load outage are checked explicitly.
This is a heuristic candidate, not cost optimization. The renewable target is
gross energy, not achieved hourly clean-energy matching. The existing CFE model
reports actual matching. Future economics repeat the chosen weather/price year;
they do not forecast energy prices or grid decarbonization.

**Jobs:** CAPEX × construction labor share / annual compensation = construction
FTE-years; divide by construction duration for average concurrent FTE. Fixed and
variable O&M × operations labor share / compensation = annual operations FTE.
Fuel, imports, carbon and offtake are excluded from payroll. Local share is an
input, not observed hiring. Defaults (20%, 35%, $120,000/FTE-year, two years, 60%
local) are illustrative assumptions, not calibrated NREL coefficients. No net,
indirect, induced or displaced jobs are modeled. FTE interpretation follows
[NREL JEDI](https://www.nrel.gov/analysis/jedi/results.html); this is not JEDI.

**Demographics:** sum population of 2020 Census California block groups whose
population-weighted centroids are in the polygon, respecting holes. Household
estimate = population / entered household size. Residential demand = households
× entered annual household kWh / 1,000; average MW = MWh / 8,760; estimated peak
= average / load factor. Defaults: 2.9 people/household, 6,500 kWh/year, 0.55 load
factor, all editable assumptions. This omits commercial/industrial demand and
does not identify actual utility customers. Small parcels may include no
centroids despite residents. Missing data returns null, not zero population.

**Resilience:** all outage start hours are ranked by critical residual energy
after derated gas and renewables, less preceding simulated battery SOC × discharge
efficiency. The highest-ranked window is dispatched with no imports/exports,
actual starting SOC and entered critical-load share. The ranking is a heuristic,
not exhaustive dispatch of every outage window or a reliability probability.
N-1 sustained supply removes the largest of one grid tie or one assumed gas unit
(up to 400 MW CC / 100 MW CT) from derated firm capacity. Renewables and batteries
are excluded from sustained firm capacity; storage is included in outage dispatch.
Islanding controls, protection, gas delivery, black start and utility approval
remain unverified and are called out in findings.

**Carbon:** booked annual cost sums financial-model carbon lines. All-emissions
exposure = annual CO2e × entered carbon price. Exposure is a sensitivity and is
not added again to owner costs. Cost and emissions per acre allocate this project
to its selected footprint; they are not observed ambient-area measurements.

**Production/contracts:** gross generation excludes storage discharge to avoid
double counting. Usable generation subtracts curtailment, before storage losses.
Illustrative offtake volume = usable generation × contracted share. Its price ×
volume is an indicative gross annual value, not an executed agreement or firm
delivery guarantee. It never reduces owner costs. CSV and printable reports
include production, jobs, carbon, area, demographic, contract, resilience and
assumption rows with units, provenance and caveats.

**Zoning:** authoritative source services:
[North](https://services8.arcgis.com/Xr1lDrwMv89PhjD9/arcgis/rest/services/California_Statewide_Zoning_North/FeatureServer/1),
[South](https://services8.arcgis.com/Xr1lDrwMv89PhjD9/arcgis/rest/services/California_Statewide_Zoning_South/FeatureServer/0).
LCI says collection was largely 2021–22, with some 2023 updates. Preserve and show
each feature's Code, Description, Jurisdiction, Source and Date. Dataset portal
update dates do not establish current zoning. Verify allowed uses with the local
jurisdiction; no permit eligibility is inferred. Only enabling the zoning overlay
makes external runtime requests; core planning and Census summaries use cached data.
