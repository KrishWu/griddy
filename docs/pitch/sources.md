# Fact-check log

Every statistic used in the Devpost, slides or demo script, with its source.
Accessed 2026-10-24. Status: **verified** (exact wording read at the source),
**app** (computed by GridForge; refresh before submitting), or **assumption**.

## External statistics

| Claim as used | Source | Status | Notes |
|---|---|---|---|
| "Only 13% of capacity that submitted interconnection requests from 2000–2020 had reached commercial operations by the end of 2025." | LBNL, *Queued Up: 2026 Edition* (Rand et al., May 2026), <https://emp.lbl.gov/publications/queued-2026-edition-characteristics> | verified | Covers transmission-connected **generation and storage**, not loads. Use it for the campus's on-site plants, not the data center's load request. |
| "The median duration from interconnection request to commercial operation was over 5 years for projects built in 2025." | same | verified | "For the regions with available data." |
| 1,312 GW of generation and ~749 GW of storage in queues at the end of 2025 | same | verified | Optional. |
| Data centers "could account for 11.8% of total U.S. electricity by 2030" (range 9.5–15.3%) | LBNL, *United States Data Center Energy Usage Report: 2025 Update* (Smith, Shehabi et al., LBNL-2001758, June 2026), <https://www.osti.gov/biblio/3374245> | verified | From the abstract. Don't quote a 2024 share unless you read it in the report. |
| The San Joaquin Valley is in Extreme nonattainment for 8-hour ozone (2015 and 2008 standards) and Serious for PM2.5 (2012 and 2006) | EPA Green Book external data files, report date 2026-09-30, <https://www.epa.gov/green-book> | verified | Committed in `data/site_intel/nonattainment_ca.geojson`. |
| Major-source NOx threshold in an Extreme ozone area: 10 short tons/yr (9.1 t) | Clean Air Act §182(e), applied to NOx by §182(f) | verified | Serious 50, Severe 25, Marginal/Moderate 100 tpy. |
| NVIDIA DGX H100: 10.2 kW max for 8 GPUs | NVIDIA DGX H100/H200 User Guide, <https://docs.nvidia.com/dgx/dgxh100-user-guide/introduction-to-dgxh100.html> | verified | Used as 1.275 kW per GPU-hour: an upper bound (full load). |
| Embodied ≥150 kg CO2e per GPU; ~2,500 kg per server; 6-year replacement cycle | Luccioni, Viguier & Ligozat, *Estimating the Carbon Footprint of BLOOM* (JMLR 2023), <https://jmlr.org/papers/volume24/23-0069/23-0069.pdf> | assumption | 150 kg is the paper's lower-bound estimate. The server figure is an HPE ProLiant proxy. |
| SCI = (E × I + M) per R | Green Software Foundation SCI (ISO/IEC 21031:2024), <https://sci-guide.greensoftware.foundation/> | verified | R = one GPU-hour. |
| Carbon Aware SDK response shape (`optimalDataPoints`, `forecastData`, `windowSize` in minutes, `value` in gCO2e/kWh) | `EmissionsForecastDTO.cs` in the SDK's source on GitHub | verified | The SDK's tutorial page still shows the older singular `optimalDataPoint`. |

## Required attributions

- **LBNL Queued Up** (CC BY 4.0): "Lawrence Berkeley National Laboratory and GridTracker".
- **Sentinel-2 imagery:** "Contains modified Copernicus Sentinel data 2024, processed in Google Earth Engine".
- **ESA WorldCover:** "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium".
- **AirNow:** data are preliminary and not fully verified. Credit "AirNow (U.S. EPA and partners)".
- **WDPA** (protected areas): "UNEP-WCMC and IUCN, Protected Planet".
- **OpenStreetMap** (substations, via A): "© OpenStreetMap contributors (ODbL)".
- **Planet:** not used. Never put Planet imagery in the repo.

## App numbers (snapshot Sat Oct 24, ~1 AM, Buttonwillow site, before the 7 AM re-tune)

Refresh these from the running app (Compare view, or `POST /api/compare` with `/api/presets`)
before the 2 PM freeze, and update every doc that quotes them.

| Preset | CAPEX | LCOE | CO2 | Unmet | Other |
|---|---|---|---|---|---|
| Grid-connected (1,100 MW import) | $0.07 B | $64/MWh | 1.36 Mt/yr | 0 h | 30% flexible load avoids ~65 kt/yr (4.8%); SCI 272 → 260 g/GPU-h |
| Hybrid (1,300 MW PV, 700 MW gas CC, 300 MW × 4 h battery, 300 MW import) | $2.94 B | $61/MWh | 1.46 Mt/yr | 0 h | 297 battery cycles/yr, 0.6% curtailed; 24/7 CFE 22% vs 45% on annual netting; AIR_PERMIT_RISK: ~1,076 t NOx/yr (~80 t with SCR) vs 9.1 t threshold |
| Renewable-heavy | $5.40 B | $110/MWh | 1.09 Mt/yr | 3,331 h | 7.7% of demand unserved, up to 200 MW short |

Site facts (E and A): Midway 500 kV substation 1.6 km away (A), 0.4° mean slope, 5.6 kWh/m²/day
GHI, 74% actively cultivated (CDL 2025) → farmland-conversion warning, AQI from the AirNow snapshot.
