# Griddy: Devpost draft

> **Team note (delete before pasting):** app numbers are the Sat 1 AM snapshot in
> `sources.md`. Refresh them after the 7 AM re-tune and again before the 2 PM freeze.

## Inspiration

AI campuses want a gigawatt, and they want it now. LBNL expects data centers to reach
11.8% of U.S. electricity by 2030. But the grid's front door is jammed: only 13% of the
capacity that asked to interconnect from 2000 to 2020 had reached commercial operation by
the end of 2025, and the median project built in 2025 waited over 5 years (LBNL, *Queued
Up: 2026 Edition*). Most of those plans fail late and expensively, on things a first look
could have caught: steep or protected land, no transmission nearby, a supply mix that
can't cover every hour, or an air permit that won't be granted.

We wanted that first look to take minutes, and to show its work.

## What it does

Griddy plans power for a 1 GW AI data-center campus in California, from site to report:

1. **Explore:** a real California grid map (EIA-860 plants, CEC transmission lines,
   substations). Click a parcel to see the nearest substation and line voltage.
2. **Screen the site:** Google Earth Engine checks the 2 km around the parcel for land
   cover, fallowed vs actively farmed land, slope, protected areas, surface water and solar
   resource, with a Sentinel-2 2024 image over the map. AirNow and EPA's Green Book add
   current air quality and nonattainment status.
3. **Build:** pick a supply portfolio (grid-connected, a solar + gas + battery hybrid,
   renewable-heavy, or a community microgrid) and edit it.
4. **Simulate:** an hour-by-hour 2024 dispatch (8,784 hours) with real weather, CAISO
   prices and hourly grid carbon.
5. **Evaluate:** CAPEX, LCOE, CO2, NOx, a 24/7 carbon-free-energy score and an electrical
   bill of materials, with presets compared side by side.
6. **Stress test:** unmet hours, firm capacity, N-1, heat wave, renewable drought, and the
   interconnection and air-permit questions that need a utility or air-district study.
7. **Report:** export everything, and every number carries its source.

For the team's demo site at Buttonwillow (Kern County, 1.6 km from PG&E's Midway 500 kV
substation), the Hybrid preset meets demand in every hour of the year for about $2.9B
CAPEX at $61/MWh. It also tells you what that costs locally. The site is in the San
Joaquin Valley, an Extreme ozone nonattainment area, and 700 MW of gas emits about
1,100 t of NOx a year (about 80 t with SCR) against a 9.1 t major-source threshold, so it
gets an `AIR_PERMIT_RISK` flag. Hourly matching shows the campus is 22% carbon-free, not
the 45% an annual total would suggest. And making 30% of the AI load carbon-aware (shifted
within each day to the cleanest hours) avoids about 65,000 t CO2e a year on the grid-only
design.

## How we built it

- **Backend:** FastAPI + pydantic. One shared contract (`contract.py`, mirrored in
  TypeScript and checked by a test) let five people build five slices in parallel without
  merge conflicts.
- **Frontend:** Next.js 16, React 19, MapLibre and Recharts.
- **Data:** Open-Meteo 2024 weather; pvlib single-axis trackers; CAISO 2024 day-ahead
  prices and fuel mix (via gridstatus); NLR ATB 2025 costs; CAISO interconnection unit-cost
  guides; EPA emission factors (40 CFR 98, AP-42); EIA-860.
- **Sponsor tech:**
  - **Google Earth Engine:** one round trip screens ESA WorldCover, USDA CDL 2025, USGS
    3DEP, WDPA, JRC Global Surface Water and ERA5-Land, plus a live Sentinel-2 composite.
    We checked the land-cover shares against ESA's own data, and they agree within 0.1
    percentage points.
  - **AirNow:** current AQI near the site.
  - **Green Software Foundation:** carbon-aware shifting with a Carbon Aware SDK-shaped
    "best window", plus an SCI score in g CO2e per GPU-hour.
- **Offline first:** every sponsor integration falls back to committed cached data, so
  the demo never depends on a live API.

## Challenges we ran into

- **Time zones.** Weather, prices and charts had to agree on one clock (fixed UTC−8, no
  DST), or solar would peak at the wrong hour.
- **Defining "clean".** Annual netting flatters every design, so we score 24/7 hourly
  matching instead.
- **Honest carbon-aware savings.** Shifting load only helps when a cleaner MWh is
  available that hour, so we read each hour's marginal source from the dispatch rather
  than averaging grid carbon.
- **Five parallel workstreams in 24 hours:** a frozen contract, file ownership checks in
  CI, and small merges at fixed checkpoints.

## Accomplishments that we're proud of

- Every number on screen has a source, and estimates are labelled as estimates.
- The stress test fails our own Renewable-heavy preset, with 3,331 unmet hours, instead
  of hiding it.
- Site screening that would take days of GIS work runs in about a second, and still works
  with no network.

## What we learned

- A gas-backed campus isn't automatically cleaner than buying grid power. In California,
  our Hybrid emits slightly more CO2 than the grid-only design (1.46 vs 1.36 Mt/yr). What
  it buys is a much smaller grid connection: 300 MW of imports instead of 1,100 MW.
- Air quality is a siting constraint, not just a carbon footnote.

## What's next

- Marginal grid emissions (WattTime) alongside CAISO averages.
- Least-cost sizing and dispatch with an optimizer.
- Planet imagery for a recent close-up of the parcel.
- More regions beyond CAISO.

## Built with

Python, FastAPI, pydantic, NumPy, pandas, pvlib, gridstatus, Google Earth Engine,
TypeScript, Next.js, React, MapLibre GL, Recharts, Tailwind CSS. Data from CAISO, NLR ATB,
EIA, EPA, AirNow, ESA, USDA NASS, USGS, JRC, UNEP-WCMC/IUCN, ECMWF, Open-Meteo,
OpenStreetMap and LBNL (Queued Up, CC BY 4.0: Lawrence Berkeley National Laboratory and
GridTracker).
