# Workstream B — Simulate + Stress Test

**Mission:** a credible hour-by-hour year (8,760/8,784 h) of how the campus is supplied:
real solar, wind, price and grid-carbon profiles; correct battery behavior; and honest
feasibility flags. This is the "it actually works" part of the demo.

**Branch:** `ws/b-simulate` · **Check:** `python3 scripts/check_ownership.py B`

## You own

- `backend/app/simulate/` (`engine.py`, `stress.py`, `router.py`, profile prep scripts)
- `frontend/components/simulate/` (`SimulatePanel.tsx`, `StressPanel.tsx`, charts)
- `data/simulate/` (processed hourly profiles; a 2024 CSV of ~8,784 rows is fine to commit)
- `backend/tests/test_simulate*.py`, `backend/requirements/b-simulate.txt` (gridstatus, scipy already there)

## Contract you implement (keep these signatures)

```python
# backend/app/simulate/engine.py
def simulate(scenario: Scenario, catalog: Catalog) -> SimulationResult
# backend/app/simulate/stress.py
def stress_test(scenario: Scenario, sim: SimulationResult) -> list[Finding]
```

`HourlySeries` must keep every array the same length and satisfy, every hour:

```
demand = Σ generation + discharge + imports + unmet − charge − exports − curtailed
```

`backend/tests/test_contract.py` enforces this, plus imports ≤ limit and generation ≤ capacity.
C prices imports with your `price_usd_per_mwh` and counts their emissions with your
`grid_co2_kg_per_mwh`, so those two arrays are part of your deliverable.

## P0, in order

| # | Task | Target |
|---|---|---|
| 1 | **Real 2024 weather at the site:** Open-Meteo archive API (free, no key), hourly `shortwave_radiation`, `wind_speed_100m`, `temperature_2m` for the site lat/lon → per-MW solar CF (single-axis tracker; simple GHI model or pvlib) and wind CF (generic power curve: cut-in 3 m/s, rated 12 m/s, cut-out 25 m/s). Validate solar against PVWatts (≈ 23% CF for a tracker at the Kern site). Cache per site in `data/simulate/`. | 1 AM |
| 2 | **CAISO 2024 prices + grid carbon:** `gridstatus` → hourly day-ahead LMP. A load buys at its **load aggregation point** (`DLAP_PGAE-APND` for PG&E, `DLAP_SCE-APND` for SCE), not at a generator trading hub (`TH_*_GEN-APND`), so use the DLAP for import prices (C adds a delivery adder on top) and hourly fuel mix → average CO2 intensity of the grid (gas ≈ 0.40 t/MWh fleet average; imports at CARB's unspecified-import factor 0.428 t/MWh; zero-carbon for solar/wind/hydro/nuclear/geothermal). OASIS is slow: fetch once, save `data/simulate/caiso_2024_hourly.csv`, load from the file at runtime. | 1 AM |
| 3 | **Demand profiles:** `flat`, `ai_training` (≈ flat, 0.95 LF), `ai_inference` (diurnal), and PUE that rises with outdoor temperature (cooling load). `community` from EIA-930 PG&E demand shape (for Mode B). | 7 AM |
| 4 | **Co-tune presets with C at the 7 AM checkpoint:** once real data lands, the Hybrid preset should still meet demand every hour, or the demo story breaks. Ask D to adjust preset sizes. |  |
| 5 | **Dispatch correctness:** SOC bounds, round-trip efficiency, no simultaneous charge+discharge, import/export limits, gas CC before CT, curtailment. Unit tests for each rule. | 7 AM |
| 6 | **Stress tests** (each → `Finding`): unmet hours / energy; storage duration vs. the *residual* deficit after firm resources (gas + import limit), not the raw overnight deficit, which fires on every battery for a flat data-center load; **point-of-interconnection voltage** (one 230 kV circuit carries roughly 400–600 MW, 500 kV up to ~2 GW; flag a 1.1 GW grid-connected campus on a 230 kV tie, using A's nearest-line voltage); firm capacity with derates (gas forced-outage rate, battery capacity credit by duration); peak import vs. limit; worst renewable drought (lowest 72 h solar+wind); **heat wave** (rerun with July 2024 heat-wave temperatures/prices); **N-1** (largest gas unit offline). Flag anything that needs a utility study. | 11 AM |
| 7 | **Charts** (render only the visible 24 h or 168 h window, never all 8,760 points; Recharts gets slow): dispatch chart with day/week toggle, battery charge shown below zero, SOC line, "jump to worst day" button; summary stats; findings grouped by severity. | 11 AM |

## Stretch

- Least-cost dispatch / sizing with `scipy.optimize.linprog` (HiGHS): battery arbitrage on
  price, or "size the battery to hit 0 unmet hours" (talk to C about the cost objective).
- Price-aware grid charging of the battery.
- Marginal (vs. average) emissions from WattTime for CAISO_NORTH (E uses this for
  carbon-aware shifting; agree on one source with E).

## Data sources

| Source | Use | Link |
|---|---|---|
| Open-Meteo archive | Hourly irradiance, 100 m wind, temperature (no key) | https://open-meteo.com |
| PVWatts v8 API | Validation baseline for solar output (`DEMO_KEY` works; get a free key) | https://developer.nlr.gov/docs/solar/pvwatts/ |
| NSRDB | Higher-quality irradiance if needed | https://nsrdb.nlr.gov |
| WIND Toolkit | Modeled wind if Open-Meteo looks off | https://developer.nlr.gov/docs/wind/wind-toolkit/ |
| gridstatus | CAISO LMPs, load, fuel mix in one call | https://github.com/gridstatus/gridstatus |
| CAISO OASIS | Raw source behind gridstatus | http://oasis.caiso.com |
| EIA-930 Grid Monitor / EIA API | Hourly demand by BA (community shape), validation | https://www.eia.gov/electricity/gridmonitor/ · https://www.eia.gov/opendata/ |
| WattTime | Marginal CO2, free for CAISO_NORTH | https://docs.watttime.org |
| EPA eGRID / CAMPD | Validate emission factors | https://www.epa.gov/egrid · https://campd.epa.gov |

Note: NREL's developer site moved to `developer.nlr.gov` (the old `developer.nrel.gov`
no longer resolves). Update any tutorial code you copy.

## Done means

- Hybrid preset (real data): unmet = 0 h, battery ≥ 150 equivalent cycles/yr, curtailment
  < 10%. If real profiles break this, re-tune the preset sizes with C and D; don't bend the physics.
- A test asserts solar output peaks at local hour 12 ± 1 (catches UTC/PST misalignment
  between Open-Meteo, CAISO and the chart).
- Hybrid preset at the demo site: solar CF 20–30%, no hour violates the balance, battery
  SOC stays within [0, capacity], and a July day looks like a real duck curve.
- `simulate()` runs in < 1 s per scenario from cached profiles (no network at request time).
