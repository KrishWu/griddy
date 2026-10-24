# 3-minute demo script

**Roles:** D drives the clicks, E narrates. Rehearse on `main` after the 2 PM freeze.
Numbers are the Sat 1 AM snapshot (`sources.md`): refresh them before rehearsing.

## Before you start (T−10 min)

- Run `python -m app.site_intel.prep.air --skip-greenbook` from `backend/` for a fresh
  daytime AirNow snapshot (30 s, no key needed). Commit it only if it looks sane.
- Start the app and click the Buttonwillow site once to warm everything up.
- Open the backup video in a second tab.

## Script

| Time | D clicks | E says |
|---|---|---|
| 0:00 | The app opens on the California grid map. | "A 1 GW AI campus wants power, and only 13% of projects that join the interconnection queue ever get built. Griddy tells you in minutes whether a site is worth a queue position." |
| 0:15 | Click the parcel at Buttonwillow, next to Midway substation. | "Buttonwillow in Kern County: 1.6 km from PG&E's Midway 500 kV substation." |
| 0:25 | Point at the satellite overlay and the 2 km circle, then the Site intelligence panel. | "Google Earth Engine screens the 2 km around the parcel: flat at 0.4°, strong sun at 5.6 kWh/m²/day. But 74% of it is actively farmed, so there's a farmland-conversion flag. And it's in the San Joaquin Valley, Extreme ozone nonattainment." |
| 0:50 | In Build, choose **Hybrid** (1.3 GW solar, 700 MW gas, 300 MW × 4 h battery). Run. | "Our hybrid campus: solar, gas and a battery, with only 300 MW from the grid." |
| 1:05 | Simulate: a July day. | "Every hour of 2024 at this site: the solar surplus at midday charges the battery, the battery covers the evening ramp, and gas plus a little grid power carry the night. Zero unmet hours." |
| 1:25 | Evaluate: CAPEX, LCOE, CO2, 24/7 CFE. Then Compare the presets. | "$2.9B, $61 per MWh. It's honest about carbon: 22% carbon-free hour by hour, not the 45% an annual total claims, and a bit more CO2 than just buying grid power." |
| 1:50 | Stress test on Hybrid: `AIR_PERMIT_RISK`. | "Here's what usually surfaces a year in: about 1,100 t of NOx against a 9 t major-source threshold. Expect offsets and top-tier controls from the air district." |
| 2:05 | Switch to **Renewable-heavy**. Run. Stress test. | "The 'green' option misses 3,331 hours. It needs firming, and its interconnection needs a CAISO study. The tool says so instead of hiding it." |
| 2:25 | Switch to **Grid-connected**. Carbon-aware panel: drag the slider to 30%. | "The campus as a virtual battery: moving 30% of the AI load to the cleanest hours of each day avoids about 65,000 t CO2e a year. The Green Software Foundation's SCI score drops per GPU-hour." |
| 2:45 | Report: export. | "Every number with its source, plus an electrical bill of materials, ready for the utility conversation. That's Griddy." |

## If something breaks

- **Earth Engine slow or down:** say nothing. The panel falls back to the cached screening
  and imagery for the demo area, which is identical.
- **AQI shows "No nearby AQI":** "AirNow is a live feed. The nonattainment status is what
  drives the permit risk, and that's EPA data."
- **A run errors:** press Run again. If it still fails, switch to the backup video at the
  same timestamp.
- **Map won't load:** start from the Build panel. The site is already set to Buttonwillow.

## Backup video

Record the full script once by **2 PM** (screen and voice, about 3 minutes). Keep it
local, and upload it to Devpost if the rules allow.
