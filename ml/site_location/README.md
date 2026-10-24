# B · Nearby demand and where to build

Learns where each kind of plant (solar, wind, battery, gas) actually gets built in
California, then places the new capacity that A's demand forecast calls for on the
best-scoring sites. **Input from A:** a demand artifact (`ml/contract/`).

## Run it (training machine, repo root)

```bash
pip install -r ml/site_location/requirements.txt
python -m pytest ml                                   # unit + contract tests, no training (~5 s)

git pull                                              # get A's latest artifact under ml/artifacts/demand_forecast/
python -m ml.site_location.train --dry-run            # features + labels from data/explore, no training
python -m ml.site_location.train                      # GPU (XGBoost CUDA); --device cpu also works
python -m ml.site_location.export_sites --run ml/site_location/runs/<run_id>   # what the website reads
```

`export_sites` writes `ml/artifacts/site_location/<id>/` plus a `LATEST` pointer: every 5 km cell
with its features and each technology's suitability. Commit it. The website
(`backend/app/sites`) then sizes and places capacity live for whatever demand scenario the user
picks; the model itself never runs in the website. Until the models are trained,
`export_sites --heuristic` writes the same artifact from a fixed, documented blend of the features,
so the site picker works from day one. `recommend.py` remains for offline experiments.

- **Which artifact.** `train` uses `LATEST_BASELINE`, falling back to `LATEST_FORECAST`, or
  `--demand <dir>`. Only the base year is used, so you can train before A's model exists.
- **What `recommend` needs.** A *forecast* artifact; it uses `LATEST_FORECAST` by default.
- **What to commit.** `ml/artifacts/site_location/<id>/`:
  - `recommended_sites.geojson` is map-ready, so the Explore map can draw it as an overlay;
  - `summary.json` holds the need, allocation, unmet MW, assumptions and model scores.
- **Runtime.** Features take seconds. Each model trains on a few thousand rows (5-fold
  spatial CV plus a final fit), in under a minute on GPU or CPU. The GPU matters more if you
  raise `--rounds` or move to a finer grid.

## How it works

| Step | What |
|---|---|
| Candidates | 5 km grid over California: 16,393 cells |
| Features | Grid access (A's layers): distance to the nearest network substation ≥ 220 kV and ≥ 60 kV, distance to the nearest operational AC line ≥ 220 kV and ≥ 69 kV, highest substation voltage within 10 km. People (Census): population within 10 and 50 km. **Nearby demand** (A's demand artifact, spread to block groups, summed within 50 and 150 km). Resource (ERA5 via Open-Meteo, `fetch_resource.py`, committed as `data/resource_grid.csv`): mean solar irradiance and 100 m wind speed. Air quality (E's EPA nonattainment layer) |
| Labels | Operating EIA-860 plants ≥ 5 MW online since 2000: about 347 solar, 66 wind, 74 battery, 114 gas. Negatives are 10 random cells per positive, at least 3 km from any plant of that type |
| Model | One XGBoost classifier per technology, `device=cuda`; class weights balance the 1:10 sampling |
| Validation | 5-fold GroupKFold over 50 km blocks (spatial CV, so neighbours never straddle train and test). Reports ROC-AUC, PR-AUC and precision in the top 10% |
| Need (website) | From A's forecast: solar + wind cover a clean share (default 80%) of the **new energy** at B's 2024 capacity factors. Batteries + gas cover the **new P90 peak** left after the renewables' capacity credit, measured from B's 2024 profiles at CAISO's 100 highest net-load hours (solar ≈ 5%, wind ≈ 14%). All shares can be edited in the website |
| Selection (website) | HiGHS linear program over the artifact's cells: minimize (1 − suitability) + gen-tie distance + county queue congestion (LBNL) + distance from demand growth + nonattainment (gas only). Cell capacity comes from C's land use per MW, and CAPEX and gen-tie dollars from C's ATB 2025 catalog. Need it can't place is reported as unmet |

## Read the results honestly

- **Suitability means "looks like where plants of this type were built"**, not a feasibility
  study. Land use, zoning, habitat and interconnection capacity are not modeled; every site
  needs a utility study.
- **Grid built for a plant makes its site look good after the fact.** Plants' own switchyards
  (OSM `substation=generation`) are excluded from the features. Gas plants still sit unusually
  close to lines (61% within 300 m), so the gas model's scores are likely optimistic.
  Solar shows no such spike (5%).
- **Random-land negatives make the task easier** than choosing between two good sites, so
  AUCs will look high. Compare the technologies with each other, not with an absolute bar.
- **Resource is annual-mean ERA5 on a 0.5° grid** (about 50 km). It is fine for screening, too coarse for wind
  micro-siting (ridges, hub-height shear).
