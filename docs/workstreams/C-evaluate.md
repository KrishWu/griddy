# Workstream C — Evaluate (costs, emissions, BOM)

**Mission:** turn a scenario plus its simulated year into money and carbon that a judge
trusts: CAPEX, OPEX, net present cost, LCOE, annual CO2e, and a bill of materials.
Every number cites its source.

**Branch:** `ws/c-evaluate` · **Check:** `python3 scripts/check_ownership.py C`

## You own

- `backend/app/evaluate/` (`catalog.py`, `economics.py`, `router.py`, ATB prep script)
- `frontend/components/evaluate/` (`EvaluatePanel.tsx`, cost waterfall, emissions breakdown, `ComparisonTable.tsx`)
- `data/evaluate/` (extracted ATB numbers as JSON with citations)
- `backend/tests/test_evaluate*.py`, `backend/requirements/c-evaluate.txt`

## Contract you implement (keep these signatures)

```python
# backend/app/evaluate/catalog.py
def get_catalog() -> Catalog
# backend/app/evaluate/economics.py
def evaluate(scenario: Scenario, sim: SimulationResult, catalog: Catalog) -> EvaluationResult
```

You consume B's `SimulationResult`: `generation_mw` by kind, `imports_mw`, `exports_mw`,
`price_usd_per_mwh`, `grid_co2_kg_per_mwh`. B (`simulate`) also reads your catalog
(battery round-trip efficiency), so keep `TechSpec` fields populated.

**Financial boundary (already stated in the stub):** the campus owner builds and owns all
on-site assets and buys grid imports at the hourly price. Owned generation is costed via
CAPEX + O&M + fuel; only imports are purchased power. Never count both.

## P0, in order

| # | Task | Target |
|---|---|---|
| 1 | **ATB 2025 catalog:** download the ATB 2025 CSV, extract Moderate scenario, Market financial case, a 2027 COD for: Utility PV, Land-based wind, NG combined cycle, NG combustion turbine, Utility-scale battery (4 h; split $/kW and $/kWh). Save to `data/evaluate/atb_2025_catalog.json` with the exact ATB parameter names, then have `catalog.py` load it. Fill `Provenance` per tech. | 1 AM |
| 2 | **Land, heat rates, CO2 factors:** land-use (acres/MW) from published land-use studies; heat rates from ATB; gas CO2 53.06 kg/MMBtu (EPA). Transmission: per-km line and substation costs from a utility per-unit-cost guide (CAISO participating TOs publish these). Cite each. | 7 AM |
| 3 | **Economics correctness:** fuel cost (gas price from the **same year** as the LMPs, e.g. 2024 PG&E Citygate monthly, so you don't pair a calm-year gas price with spike-year power prices); purchased power = imports × (LMP + `import_adder_usd_per_mwh`, default $20/MWh for transmission access and delivery, already in the stub); export credit defaults to 0 (presets have `export_limit_mw = 0`); optional carbon price (CA cap-and-trade allowance price), NPC with discounting, LCOE = NPC / discounted MWh served. **Fix the horizon mismatch:** the analysis runs 20 years but PV/wind/gas last 30 and batteries 15, so either annualize each asset's CAPEX with its own capital recovery factor CRF(r, lifetime) or add battery replacement at year 15 and linear salvage value at year 20, and document which. Unit tests on annuity math, double counting, and a hand-checked 100 MW PV example. | 7 AM |
| 4 | **Emissions:** direct (gas) + imports (hourly grid intensity from B), with an annual total, intensity (kg/MWh served), and breakdown by source. Cross-check against eGRID CAMX. **Be honest about ordering:** a CCGT (~0.35 t/MWh) is dirtier than CAISO's average grid (~0.2 t/MWh), so Hybrid may emit *more* than Grid-connected. That's a talking point for the demo, not a bug. Never tune factors to force an ordering; show both import accounting methods (CAISO hourly average vs. CARB's 0.428 t/MWh for unspecified imports) instead. Optional upstream methane toggle (assumption, cited). | 7 AM |
| 5 | **24/7 CFE score (SVCE's question) + NOx:** share of hours in which on-site clean generation + the clean share of imports covers demand (hourly matching, not annual netting). NOx and PM2.5 from gas using EPA AP-42 factors, which E uses for the `AIR_PERMIT_RISK` finding. Put both in `EvaluationResult.extras` first. | 11 AM |
| 6 | **BOM:** solar modules (e.g. 550 W modules, DC/AC 1.3), inverters, turbines (count from the ATB reference turbine size), battery containers (MWh/container), line km, acres, plus an **electrical BOM** (step-up transformers, HV breakers, MV switchgear, inverters, UPS for the data center), which is SE Ventures' moment. Every item has a `basis` string. | 11 AM |
| 7 | **Frontend:** headline stats, cost waterfall (CAPEX by asset → NPC), emissions breakdown, provenance tooltip on every number, and a `ComparisonTable` component taking `ScenarioResult[]` that D's compare view imports (three presets side by side: CAPEX, LCOE, CO2e, unmet hours, land). | 11 AM |

## Stretch

- Tax-credit toggle: federal credits for wind/solar changed in 2025. Check current law
  before modeling them; default to **no incentives** and label it an assumption.
- Sensitivity tornado: LCOE vs. gas price, discount rate, CAPEX ±20%.
- Cost objective for B's least-cost sizing optimizer.

## Data sources

| Source | Use | Link |
|---|---|---|
| Annual Technology Baseline (ATB) 2025 | CAPEX, O&M, heat rate, CF, lifetimes | https://atb.nlr.gov/electricity/2025/data |
| EIA-923 (+ EIA-860) | Real capacity factors / fuel use to sanity-check | https://www.eia.gov/electricity/data/eia923/ |
| PUDL | Pre-joined EIA tables | https://catalyst.coop/pudl/ |
| EPA eGRID | Regional average emission rates (validation) | https://www.epa.gov/egrid |
| EPA CAMPD | Measured hourly plant emissions (validation) | https://campd.epa.gov |
| LBNL Queued Up | Interconnection-delay stats for the feasibility story | https://emp.lbl.gov/queues |

## Done means

- Numbers within sane ranges (PV CAPEX ~ $1.2–1.8M/MW; LCOE for presets $40–150/MWh),
  every `CostLine` has a non-placeholder `Provenance`, and `test_evaluate.py` covers
  double counting and NPC math.
- `ComparisonTable` renders three `ScenarioResult`s from `/api/compare`.
