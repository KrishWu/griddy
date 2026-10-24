# A · Demand forecast

Forecasts hourly electricity demand for California's seven EIA-930 load regions (PG&E,
SCE and SDG&E areas of CAISO, plus LADWP, BANC, IID, TID), scales it to scenario years
(2030/2035/2040), downscales it to counties, and exports the **demand artifact** that B's
site-location model reads (`ml/contract/`).

## Run it (training machine, repo root)

```bash
pip install -r ml/demand_forecast/requirements.txt
python -m pytest ml                                   # unit + contract tests, no training (~5 s)

python -m ml.demand_forecast.fetch_data               # EIA-930 2019..now (~1 GB), Open-Meteo weather (~30 points), CA DOF projections
python -m ml.demand_forecast.export baseline          # observed 2024 artifact → hand to B right away
python -m ml.demand_forecast.train --dry-run          # build the dataset, check splits, no training
python -m ml.demand_forecast.train                    # GPU (XGBoost CUDA); --device cpu also works
python -m ml.demand_forecast.export forecast --run ml/demand_forecast/runs/<run_id>
```

Then commit `ml/artifacts/demand_forecast/<artifact_id>/` and the `LATEST_*` pointer
files (a few hundred KB) so B can pull them. `runs/`, `data/raw/` and `cache/` stay local.

**Expected effort:**
- Download: a few minutes.
- Training: about 400k rows × 23 features, so roughly 1–3 minutes on a recent NVIDIA GPU, or 10–20 minutes on CPU.
- Forecast export: 7 regions × 3 years × 6 weather years of inference, about a minute on CPU.

## How it works

| Step | What | Labelled as |
|---|---|---|
| Load | EIA-930 hourly demand: CAISO sub-regions PGAE/SCE/SDGE and BAs LDWP/BANC/IID/TIDC, 2019 onward. EIA's adjusted series where available, plus a spike/zero filter | observed |
| Weather | Open-Meteo archive (ERA5), up to 6 population-weighted points per region (the region's biggest counties) | observed |
| Model | One XGBoost booster, multi-quantile objective (P10/P50/P90). Target = load ÷ that region-year's mean load, i.e. the **shape**. Features: calendar, holidays, temperature with lags and degree-days, humidity, solar radiation (behind-the-meter PV), region | simulated |
| Validation | Time split: train ≤ 2023, early-stop on 2024, **test on 2025–2026** (never seen). Reports MAPE, monthly-peak error, P10–P90 coverage, and the same metrics for a naive climatology baseline | metrics in the manifest |
| Level | Base-year (2024) observed mean × per-county growth: CA DOF P-2A projected population × `(1 + electrification − efficiency)^years` (or a CEC IEPR calibration CSV), plus new data-center load per county. Its carbon-aware flexible share adds energy but not peak | assumption + DOF projection |
| Peaks | Each forecast year is run under every historical weather year. P50 peak = median annual peak; P90 = 90th percentile of the P90 peaks | simulated |
| Counties | Region totals split by 2020 Census population within each region (BA and IOU territories from `data/explore/`) | estimated |

Scenarios are plain JSON (`scenarios.json`: `low`, `mid`, `high`). Edit it or pass
`--scenarios my.json` to export different futures; no retraining is needed.

## In the website

`export` also writes `region_shape.csv` (the model's peak/mean ratio per region and year) and
`county_population.csv` (the DOF projections). With those, `backend/app/forecast` recomputes any
what-if from the website's sliders with the same formulas, in about 3 ms, without loading the model.
Until a trained forecast is exported, the website runs on the observed baseline: the same scenario
math, using 2024's observed peak/mean ratio.

## Known limitations (say them out loud)

- **County demand is population-weighted**, so industrial counties are understated. Kern
  (oil fields, food processing) shows about 6.5 TWh. The CEC's county consumption data
  would be a better weight.
- **Four counties** are outside every forecast region (PacifiCorp / NV Energy areas: Del
  Norte, Siskiyou, Modoc, Alpine) and are not in the artifact.
- **Long-term growth is a scenario, not a prediction.** The model learns hourly shape and
  weather response; it cannot see future EV or heat-pump adoption. Calibrate against the
  CEC 2025 IEPR by adding `"calibration_csv"` (columns `region, year, annual_energy_gwh`)
  to a scenario.
- **Electrification changes the shape** (evening EV charging, winter heat pumps); scaling
  today's shape doesn't capture that. Treat 2040 peaks as indicative.
- **New data-center load** is modelled flat at peak × load factor (default 0.9).
