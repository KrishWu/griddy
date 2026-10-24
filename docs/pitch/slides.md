# Slide outline (problem → product → demo → impact → scale)

Seven slides, about 3 minutes plus the live demo. App numbers come from the Sat 1 AM
snapshot in `sources.md`: refresh them before the freeze.

## 1. The queue is the bottleneck

- **On screen:** "13%" in large type, and under it: *of the capacity that requested
  interconnection in 2000–2020 had reached commercial operation by the end of 2025.*
  Second line: *Median wait for projects built in 2025: over 5 years.*
- **Say:** "AI campuses want a gigawatt now. Data centers could reach almost 12% of U.S.
  electricity by 2030. But most projects that join the interconnection queue never get
  built, and the ones that do wait five years."
- **Credit:** LBNL *Queued Up: 2026 Edition* (Lawrence Berkeley National Laboratory and
  GridTracker, CC BY 4.0); LBNL Data Center Energy Usage Report, 2025 Update.

## 2. Projects fail late, on things a first look could catch

- **On screen:** four icons: land (steep, protected, prime farmland), wires (no
  substation), hours (can't serve every hour), air (no permit).
- **Say:** "Each of these usually shows up after months of studies. Griddy checks them
  in the first five minutes, and shows its sources."

## 3. Griddy: map → site → build → simulate → evaluate → stress test → report

- **On screen:** an app screenshot with the panels labelled.
- **Say:** "One flow, every number sourced, built by five people in 24 hours on one shared
  contract."

## 4. Live demo (switch to the app; see `demo-script.md`)

## 5. What the demo showed (Buttonwillow, Kern County)

- **On screen:** a three-column compare of Grid-connected, Hybrid and Renewable-heavy:
  CAPEX, LCOE, CO2, unmet hours, 24/7 CFE.
- **Say:**
  - "Hybrid meets every hour for about $2.9B at $61/MWh, with a 300 MW grid connection
    instead of 1,100."
  - "It isn't cleaner than the grid: 1.46 Mt versus 1.36, and only 22% carbon-free hour by
    hour, not the 45% an annual total suggests."
  - "Renewable-heavy looks green but misses 3,331 hours. It needs firming."
  - "And the air district matters: about 1,100 t of NOx a year in an Extreme ozone area,
    against a 9 t major-source threshold."

## 6. The campus as a virtual battery

- **On screen:** the carbon-aware panel's 24-hour chart, with load moving into the low-carbon
  midday hours and the SCI number before → after.
- **Say:** "Training jobs can wait a few hours. Shifting 30% of the load within each day
  avoids about 65,000 t CO2e a year on the grid-connected design, and the SCI score per
  GPU-hour drops from 272 to 260 g. That's the Green Software Foundation's metric."

## 7. Who it's for, and what's next

- **On screen:** sponsor relevance, one line each:
  - **Google Earth Engine:** site screening and imagery.
  - **AirNow:** air-permit risk.
  - **Green Software Foundation:** carbon-aware load and SCI.
  - **Silicon Valley Clean Energy:** the 24/7 CFE score.
  - **TotalEnergies:** honest hybrid gas and solar trade-offs.
  - **SE Ventures / Schneider Electric:** the electrical BOM in the report.
- **Say:** "Next: marginal emissions from WattTime, least-cost sizing, more regions, and
  Planet close-ups of the parcel."
- **Visual:** the team, plus the repo QR code.

## Screenshots to capture by 2 PM

1. The map with the Sentinel-2 overlay and the 2 km buffer at Buttonwillow.
2. The Site intelligence panel: land-cover bar, findings, AQI.
3. The Simulate chart for a July day on Hybrid.
4. The Compare view of the three presets.
5. The Stress panel on Renewable-heavy, and `AIR_PERMIT_RISK` on Hybrid.
6. The carbon-aware panel at 30% on Grid-connected.
