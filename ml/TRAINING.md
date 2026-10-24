# Training the Phase 2 models with a coding agent

This is a runbook for a coding agent (for example Claude Code) on a GPU machine. A person
starts it by pasting the prompt for that machine (below). The agent follows the steps,
checks each result against its acceptance check, and stops to ask when a stop condition
hits. The two models train on **different machines at the same time**. They only exchange
small artifact folders through git.

```
 Machine A (ws/a-ml-demand)                         Machine B (ws/b-ml-site)
 fetch EIA-930 + weather + DOF                      take A's 2024 baseline artifact (already committed)
 train demand model (GPU)                           train site model (GPU)
 export forecast artifact ──── git push ────►       re-export sites with A's forecast (no retraining)
                                                    export site artifact ──── git push
```

## Prompts to paste

**Machine A:**

> You are training the Griddy Phase 2 **demand forecast** (workstream A) on this machine.
> Repo: https://github.com/heruirayli/cleantech-hacks, branch `ws/a-ml-demand`. Read
> `CLAUDE.md` and `ml/TRAINING.md`, then do "Setup" and "Machine A" exactly as written. Check
> every acceptance check and stop at any stop condition. Commit only what the guide says to
> commit, and finish with the report described in "Report back".

**Machine B:**

> You are training the Griddy Phase 2 **site-location model** (workstream B) on this machine.
> Repo: https://github.com/heruirayli/cleantech-hacks, branch `ws/b-ml-site`. Read
> `CLAUDE.md` and `ml/TRAINING.md`, then do "Setup" and "Machine B" exactly as written. Check
> every acceptance check and stop at any stop condition. Commit only what the guide says to
> commit, and finish with the report described in "Report back".

## Ground rules (both machines)

- **Work in your own paths only.** Machine A touches `ml/demand_forecast/**` and
  `ml/artifacts/demand_forecast/**`. Machine B touches `ml/site_location/**` and
  `ml/artifacts/site_location/**`. Never edit `ml/contract/`, `backend/`, `frontend/`, or the
  other machine's paths. If code there looks wrong, stop and report it.
- **Don't change the model to "make it pass".** No editing features, splits, thresholds or
  tests. If a check fails, stop and report.
- **Commit only exported artifacts.** `data/raw/`, `cache/` and `runs/` are git-ignored and
  stay on the machine.
- **Git:** never force-push, never rebase, never commit to `main`. Sync with `git pull` (a merge).
- **Run every command from the repo root** with `python -m ml.<package>.<module>`.
- **Don't train in the website.** The website only reads the exported artifacts.
- **Windows:** use `.venv-ml\Scripts\activate` and `python`, not `python3` (that's often the
  Store alias). Git Bash is fine for the commands below.

## Setup (both machines)

```bash
nvidia-smi                                   # an NVIDIA GPU and driver must show up
git clone https://github.com/heruirayli/cleantech-hacks.git && cd cleantech-hacks   # skip if already cloned
python --version                             # 3.11-3.14
python -m venv .venv-ml
source .venv-ml/bin/activate                 # Windows: .venv-ml\Scripts\activate
```

Acceptance:
- `nvidia-smi` lists a GPU.
- Python is 3.11–3.14.
- At least 5 GB of free disk on Machine A; Machine B needs about 1 GB.

Stop if there's no GPU, or Python is outside 3.11–3.14. Report it instead of installing
drivers or other Pythons.

## Machine A: demand forecast

**1. Branch and dependencies**

```bash
git switch ws/a-ml-demand && git pull
pip install -r ml/demand_forecast/requirements.txt
python -c "import xgboost; print(xgboost.__version__, xgboost.build_info()['USE_CUDA'])"
python -m pytest ml
```

Acceptance:
- The xgboost line ends in `True`.
- All `ml` tests pass. They don't train anything and take about 5 s.

Stop if CUDA is `False` after installing the official wheel (`pip install --force-reinstall xgboost`).

**2. Download the training data** (about 5–10 minutes, about 1.2 GB)

```bash
python -m ml.demand_forecast.fetch_data
```

What it fetches:
- EIA-930 six-month files, 2019 to now, into `ml/demand_forecast/data/raw/`. Future
  half-years print "not published, skipped"; that's expected.
- About 30 Open-Meteo weather points, into `ml/demand_forecast/cache/`.
- The CA DOF projections.

Acceptance:
- At least 12 `EIA930_*` files are in `data/raw/`.
- `cache/weather_*.csv` files exist for all 7 regions (BANC, IID, LDWP, PGAE, SCE, SDGE, TIDC).
- `P2A_County_Total.xlsx` is in `data/raw/`.

If Open-Meteo returns HTTP 429, wait 60 s and rerun the same command; finished downloads are
reused. Stop if a source still fails after 3 tries.

**3. Dry run**

```bash
python -m ml.demand_forecast.train --dry-run
```

Acceptance:
- `train` has years 2019–2023 and `valid` has 2024.
- `test` has 2025 and later, all 7 regions, and roughly 400k rows in total.
- It ends with "dry run: data is ready; not training".

**4. Train (GPU)**

```bash
python -m ml.demand_forecast.train            # default --device cuda; about 1-3 minutes
```

It prints the metrics JSON and `saved ml/demand_forecast/runs/demand-<timestamp>`. Note that
path, because it's the run id for the next step.

Acceptance, from the printed `test` block:
- `mape_p50_pct` is **lower than** `mape_climatology_pct`, meaning the model beats the naive
  baseline. Expect low single-digit percent.
- `p10_p90_coverage` is roughly 0.6–0.95.
- `monthly_peak_error_pct` is under about 10.

Stop and report the numbers if the model doesn't beat climatology, or if training errors out.
Don't tune.

**5. Export the forecast artifact** (about 1–2 minutes, CPU)

```bash
python -m ml.demand_forecast.export forecast --run ml/demand_forecast/runs/<run_id>
python -m pytest ml
```

Acceptance:
- It prints `wrote ml/artifacts/demand_forecast/forecast-2024-<timestamp>`.
- `ml/artifacts/demand_forecast/LATEST_FORECAST` names that folder.
- The folder holds `manifest.json`, `county_demand.csv`, `region_hourly.csv.gz`,
  `region_shape.csv` and `county_population.csv`.
- Tests still pass.

**6. Optional: check the website reads it**

Run this only if the backend venv exists (`scripts/setup.sh`). On Windows use `.venv/Scripts/python`:

```bash
cd backend && .venv/bin/python -c "from app.contract import ForecastRequest; from app.forecast.service import forecast; f = forecast(ForecastRequest(scenario='mid', year=2035)); print(f.mode, f.total_growth_peak_mw_p90)"; cd ..
```

Acceptance: it prints `ml` followed by a positive MW number.

**7. Commit and push only the artifact**

```bash
git add ml/artifacts/demand_forecast
git status --short          # only ml/artifacts/demand_forecast/... may be staged
git commit -m "ws/a: trained demand forecast (<run_id>)"
git pull && git push
```

Then tell the person to let Machine B know: "A's forecast is pushed."

## Machine B: site-location model

B trains on A's **2024 baseline**, which is already committed on `ws/a-ml-demand`, so B
doesn't wait for A. A's files are extracted **outside the repo**, so they never appear in
B's commits or ownership check.

**1. Branch and dependencies**

```bash
git switch ws/b-ml-site && git pull
pip install -r ml/site_location/requirements.txt
python -c "import xgboost; print(xgboost.__version__, xgboost.build_info()['USE_CUDA'])"
python -m pytest ml
```

Acceptance:
- The xgboost line ends in `True`.
- All `ml` tests pass.

**2. Get A's demand artifact, outside the repo**

```bash
git fetch origin
rm -rf ../griddy-demand && mkdir -p ../griddy-demand
git archive origin/ws/a-ml-demand ml/artifacts/demand_forecast | tar -x -C ../griddy-demand
DEMAND_DIR=../griddy-demand/ml/artifacts/demand_forecast
BASELINE=$DEMAND_DIR/$(cat $DEMAND_DIR/LATEST_BASELINE)
echo $BASELINE && ls $BASELINE
```

Acceptance:
- `$BASELINE` exists and contains `manifest.json` and `county_demand.csv`.
- `git status --short` shows nothing new under `ml/artifacts/demand_forecast`.

**3. Dry run**

```bash
python -m ml.site_location.train --dry-run --demand $BASELINE
```

Acceptance:
- About 16,000 candidate cells.
- Positives of roughly solar 300+, wind 60+, battery 70+, gas 100+.
- It ends with "dry run: data is ready; not training".

**4. Train (GPU)**

```bash
python -m ml.site_location.train --demand $BASELINE      # default --device cuda; about 1-2 minutes
```

It prints a line per technology with "spatial-CV ROC-AUC" and PR-AUC, then
`saved ml/site_location/runs/sites-<timestamp>`. Note that path.

Acceptance:
- Every technology's spatial-CV ROC-AUC is above 0.7.
- PR-AUC is above the printed base rate.
- Gas scoring highest is expected and is a known optimism in the README. Note it in the
  report; it's not a failure.

Stop and report if any ROC-AUC is below 0.6 or training errors out.

**5. Export the site artifact the website reads**

Use A's forecast if it's pushed, otherwise the baseline:

```bash
git fetch origin
rm -rf ../griddy-demand && mkdir -p ../griddy-demand
git archive origin/ws/a-ml-demand ml/artifacts/demand_forecast | tar -x -C ../griddy-demand
if [ -f $DEMAND_DIR/LATEST_FORECAST ]; then DEMAND=$DEMAND_DIR/$(cat $DEMAND_DIR/LATEST_FORECAST); else DEMAND=$BASELINE; fi
python -m ml.site_location.export_sites --run ml/site_location/runs/<run_id> --demand $DEMAND
python -m pytest ml
```

Acceptance:
- It prints about 15,000 candidate cells, all four kinds, `mode model`, and
  `wrote ml/artifacts/site_location/sites-model-<timestamp>`.
- `ml/artifacts/site_location/LATEST` names it.
- Tests still pass.

**6. Commit and push only B's artifact**

```bash
git rm -r -q ml/artifacts/site_location/sites-heuristic-*    # the pre-training placeholder; LATEST now names the model's
git add ml/artifacts/site_location
git status --short          # only ml/artifacts/site_location/... may change
python scripts/check_ownership.py B origin/foundation/ml-phase2   # must say OK
git commit -m "ws/b: trained site model (<run_id>)"
git pull && git push
```

**7. When A says "A's forecast is pushed"**

Repeat step 5 (it picks up `LATEST_FORECAST`), then step 6. **Don't retrain.** The site model
learns from the base year; the forecast only changes the demand features used for ranking.

## Report back (both machines)

End with a short report for the person:

- **Machine and GPU:** model name and CUDA yes/no.
- **Run id** and **artifact folder** committed, with the commit hash pushed.
- **A:**
  - test `mape_p50_pct` vs `mape_climatology_pct`;
  - `p10_p90_coverage`;
  - `monthly_peak_error_pct`;
  - statewide `total_growth_peak_mw_p90` for mid 2035, if step 6 ran.
- **B:** spatial-CV ROC-AUC and PR-AUC per technology, plus which demand artifact the export used.
- **Anything that hit a stop condition**, or looked off, with the exact error text.

## How it reaches the website

The API (`backend/app/forecast`, `backend/app/sites`) serves whatever the `LATEST*` pointer
files name under `ml/artifacts/`. The new artifacts show up as soon as these branches merge
to `main`:
- `/api/forecast` switches from `scenario_on_observed` to `ml`;
- `/api/sites` switches from `heuristic` to `model`.

To preview without merging, run the backend with `GRIDDY_ML_ARTIFACTS=<folder that contains
demand_forecast/ and site_location/>`. Nothing in the UI changes, and training never shows
there.
