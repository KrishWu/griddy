# Griddy Phase 2: demand forecast → where to build

Phase 1 answered "what is here and what would this design cost?" Phase 2 answers
**what will happen** (demand forecast) and **where to build** (site-location model),
with every number traceable to data or a stated assumption.

```
 A · ml/demand_forecast                         B · ml/site_location
 EIA-930 hourly load + Open-Meteo weather       EIA-860 plants, CEC lines, OSM substations,
   → XGBoost quantile model (GPU)                 Census population (data/explore/)
   → scenario growth (population,                 + nearby demand  ◄──────────────┐
     electrification, data centers)               → XGBoost siting model (GPU)     │
   → county demand, base year + 2030/35/40        → least-cost site selection (LP) │
            │                                                                      │
            └──────────── demand artifact (ml/contract) ──────────────────────────┘
```

## Work distribution

| | Owner | Builds | Paths (see `ownership.json`) |
|---|---|---|---|
| **A** | Forecast and demand | Hourly demand model per load region (P10/P50/P90), scenario growth to 2030/2035/2040, downscaling to counties, the demand artifact | `ml/demand_forecast/**`, `ml/artifacts/demand_forecast/**` |
| **B** | Nearby demand and where to build | Site-suitability model per technology (solar, wind, battery, gas) trained on where plants were actually built, with nearby demand as a feature; picks sites that cover the forecast demand growth at least cost | `ml/site_location/**`, `ml/artifacts/site_location/**` |
| shared | Everyone (foundation PR only) | The demand artifact contract and region list | `ml/contract/**`, `ml/README.md` |

C, D and E stay on their Phase 1 slices. The Phase 2 plan's suggested extensions there are
cost and carbon scenarios (C), the what-if sliders and forecast/recommendation views (D),
and the resilience stress test (B's simulate module, or E). Those live in each owner's
existing paths, not under `ml/`.

## In the website

The models train offline. The website only *uses* their exported artifacts, and nothing about
training shows in the UI.

| Endpoint | Owner | What it does |
|---|---|---|
| `GET /api/forecast`, `POST /api/forecast/whatif` | A, `backend/app/forecast` | Recomputes any scenario (population, electrification, efficiency, data centers, flexible load) from the demand artifact in milliseconds |
| `GET /api/sites`, `POST /api/sites/whatif` | B, `backend/app/sites` | Sizes new solar/wind/battery/gas for that forecast and places it on the site artifact's cells with a linear program (C's costs, B's capacity factors, LBNL queue, EPA air quality) |

`backend/app/ml_bridge.py` points the API at `ml/artifacts/`; set `GRIDDY_ML_ARTIFACTS` to use
another export without committing it. The map's "Forecast" drawer (A) shows the forecast, its
what-if sliders and B's `SitesPanel`. "Use this site" hands a recommended site to the normal
build → simulate → evaluate flow.

## Training on separate machines

The two models never import each other. The only thing they exchange is a **demand
artifact**: a directory with `manifest.json`, `county_demand.csv` and optionally
`region_hourly.csv.gz`, validated by `ml/contract/demand_artifact.py`. So:

1. **A and B start at the same time.** B does not wait for A's model. A first exports a
   *baseline* artifact (observed base-year demand downscaled to counties, no model
   needed). B trains on it, because historical siting decisions should be explained by
   historical demand, not a forecast.
2. **A trains** the forecast model on A's GPU and exports a *forecast* artifact (the base
   year plus scenario years).
3. **B ranks sites** with the forecast artifact. Its trained model is unchanged, but the
   "nearby demand" features are recomputed for the target year, and the optimizer covers
   the forecast demand growth.

Move artifacts between machines by committing them under
`ml/artifacts/demand_forecast/<artifact_id>/` (small: county CSV + manifest, hourly ~5 MB
gzipped), or by copying the directory. Every reader validates the schema version, so a
mismatched artifact fails loudly instead of producing quietly wrong rankings.

## Setup on a training machine

```bash
git clone https://github.com/KrishWu/griddy.git && cd griddy
python -m venv .venv-ml && . .venv-ml/bin/activate       # Windows: .venv-ml\Scripts\activate
pip install -r ml/demand_forecast/requirements.txt       # A
pip install -r ml/site_location/requirements.txt         # B
python -m pytest ml                                      # contract + unit tests, no training
```

Run every module from the repo root (`python -m ml.<package>.<module>`), so the `ml`
package and `data/explore/` resolve the same way on every machine. GPU training uses
XGBoost's CUDA backend (`--device cuda`, the default). The pip wheels for Linux x86_64 and
Windows include CUDA support; an NVIDIA driver is all that's needed. `--device cpu` works
everywhere and is useful for a quick check on a laptop.

Each package's README has the exact commands, expected runtimes and outputs. To have a coding agent
do the training, paste the prompts in [`ml/TRAINING.md`](TRAINING.md): a step-by-step runbook with
acceptance checks and stop conditions for each machine.

## Rules for Phase 2

- Same rules as Phase 1 (`CLAUDE.md`): edit only your paths, never change `ml/contract/`
  inside a feature PR, and change the artifact schema only in its own foundation PR with a
  version bump.
- Raw downloads (`ml/*/data/raw/`), caches (`ml/*/cache/`) and training runs
  (`ml/*/runs/`) stay on the training machine. Commit only exported artifacts.
- Report held-out accuracy (A: MAPE on a later year than training; B: ROC-AUC with
  spatial-block cross-validation) in the artifact manifest, and label outputs honestly:
  *estimated* (downscaled), *forecast* (scenario), *ranked* (model + optimizer), never
  "optimal location" without the interconnection caveat.
