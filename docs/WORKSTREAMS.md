# GridForge: how the five of us split the work

**Build window:** Fri Oct 23, 5 PM → Sat Oct 24, 5 PM PDT · **Feature freeze:** Sat 2 PM · **Submit:** before 5 PM

Each person owns one **vertical slice**: its backend module, its API endpoint, its
frontend panel, its data, and its tests. Slices never share files, so five PRs merge
without conflicts. The shared foundation (contract, app shell, pipeline, stubs) is
already on `main`, and the app runs end to end with placeholder numbers from minute one.
Your job is to replace your stub with the real thing.

## Pick a slice

| | Slice | You'll build | Good fit for |
|---|---|---|---|
| **A** | [Explore](workstreams/A-explore.md) | Real CA grid map: EIA-860 plants, transmission lines, substations; click a site → nearest substation/line, distances | GIS / geopandas / MapLibre |
| **B** | [Simulate + Stress](workstreams/B-simulate.md) | 8,760-hour dispatch with real solar/wind/price/carbon profiles, battery logic, feasibility flags, dispatch chart | Energy systems / numpy |
| **C** | [Evaluate](workstreams/C-evaluate.md) | ATB 2025 cost catalog, CAPEX/OPEX/NPC/LCOE, emissions, BOM, cost waterfall, scenario comparison numbers | Finance / economics |
| **D** | [Build + Report + UI](workstreams/D-builder.md) | Scenario builder UX, preset compare view, placing assets on the map, report export, overall polish and demo flow | Frontend / product |
| **E** | [Site Intelligence + Pitch](workstreams/E-site-intel.md) | Earth Engine / Planet site screening (land cover, slope, solar resource, imagery overlay), AirNow, carbon-aware load shifting; owns Devpost + pitch | Remote sensing / storytelling |

Write your name next to a letter in the team chat. GitHub handles: `10zingC`,
`heruirayli`, `JosephtheUnbelievable`, `KrishWu`, `shaleenb36`.

## Getting started (10 minutes)

```bash
git clone https://github.com/heruirayli/cleantech-hacks.git && cd cleantech-hacks
scripts/setup.sh                      # backend venv + npm ci
scripts/dev.sh                        # http://localhost:3000 (API on :8000)
git switch -c ws/<letter>-<name>      # e.g. ws/b-simulate
git commit --allow-empty -m "ws/<letter>: start" && git push -u origin HEAD
gh pr create --draft --fill           # open your draft PR right away
```

Then give your Claude Code this prompt (replace the letter):

> I'm workstream **B** on GridForge. Read `CLAUDE.md`, `docs/WORKSTREAMS.md`, and
> `docs/workstreams/B-simulate.md`, then work through the P0 list in order. Only edit
> files workstream B owns (`ownership.json`). Run the tests and
> `python3 scripts/check_ownership.py B` before each commit.

## Integration checkpoints

Merging little and often is what keeps this safe. At each checkpoint, everyone merges
what they have, **as long as tests pass**, even if it's partial (stubs are fine).

| When | Checkpoint | Everyone merges... | The app should... |
|---|---|---|---|
| **Sat 1:00 AM** | First real data | Your first real piece behind the stable signature | Still run all 3 presets end to end; at least one real dataset visible |
| **Sat 7:00 AM** | Real numbers | Real profiles, real costs, real map layers | Baseline vs. proposed comparison with real data |
| **Sat 11:00 AM** | P0 complete | All P0 items | Full demo path works: map → site → build → simulate → costs → feasibility → report |
| **Sat 2:00 PM** | **Freeze** | Bug fixes only after this | Rehearse the demo on `main` |

**How to merge at a checkpoint:**

1. `git fetch && git merge origin/main` into your branch, then rerun the tests.
2. `python3 scripts/check_ownership.py <letter>` → no FAIL.
3. Mark the PR ready. **D is merge captain**: merges one PR at a time in producer →
   consumer order **C → B → A → E → D**, reruns the tests after each, posts "main is green".
4. Merge with **"Create a merge commit"** (not squash, so your branch can keep going),
   then keep working on the same branch and open a new draft PR.

## One visible moment per sponsor and resource

Judges include sponsors. Make sure each one sees itself in the demo:

| Sponsor / resource | Where it shows up | Owner |
|---|---|---|
| Google Earth / Earth Engine | Site-suitability screening + satellite overlay on the map | E |
| Planet | Latest high-res scene of the chosen parcel ("ground truth"); stretch, since it depends on Planet approving education access | E |
| AirNow | Air-quality context + `AIR_PERMIT_RISK` finding when on-site gas adds NOx in a nonattainment area | E (+ C's NOx numbers) |
| Green Software Foundation | Carbon-aware flexible AI load ("the campus as a virtual battery") + SCI per GPU-hour | E (+ B's hourly carbon) |
| Silicon Valley Clean Energy | 24/7 carbon-free-energy (CFE) score: how many hours are truly clean, not just annual totals | C |
| TotalEnergies | Hybrid preset: solar + gas + storage, with its fuel, CO2 and NOx trade-offs shown honestly | B + C |
| SE Ventures (Schneider Electric) | Electrical BOM (transformers, HV breakers, switchgear, inverters, UPS) in the report; community microgrid preset (D's stretch "Mode B") | C + D |

Sponsor integrations are **optional hooks**: if an external API is down or a key is missing,
they return cached results or a `warn` finding. They never break the core map → build →
simulate → evaluate flow.

## Rules that prevent 3 AM disasters

- **Contract first.** Everything that crosses a slice boundary is a type in
  `backend/app/contract.py` (mirrored in `frontend/lib/contract.ts`; a test fails if they
  drift). New outputs go in `extras` first. Typed additions travel in their own tiny
  `contract/<what>` PR to `main`, never inside a feature PR. Optional fields only.
- **Signatures are frozen, bodies are yours.** `pipeline.py` calls `simulate()`,
  `evaluate()`, `stress_test()`, etc. Change what's inside; never the call.
- **Shared files are frozen** on branches: `main.py`, `pipeline.py`, `frontend/lib/api.ts`,
  `package.json` (full list in `ownership.json`); the ownership check fails a `ws/*`
  branch that touches one. Need a change? Post in chat and send it as its own small PR
  from a `contract/`, `deps/` or `foundation/` branch. `frontend/lib/store.tsx` belongs to D: ask D for new shared state.
- **Python deps** go in your own `backend/requirements/<letter>-*.txt`.
- **Secrets** (EIA, AirNow, WattTime, Earth Engine keys) go in `backend/.env` (git-ignored).
- **Every number has a source.** Use `Provenance` and label estimates.

## Open decisions (settle in the first 15 minutes)

1. **Demo region/site.** Three good options:
   - **Kern County** (current placeholder, `-119.47, 35.40`): cheap flat land, strong
     solar, major transmission. Mostly PG&E territory, so imports price at `DLAP_PGAE`.
   - **Tracy / San Joaquin County**, by the 500 kV Tesla substation: PG&E (`DLAP_PGAE`),
     closest to Silicon Valley (SVCE's backyard), and WattTime's free tier covers CAISO_NORTH.
   - **Westside San Joaquin Valley near Los Banos** (500 kV): lots of fallowed farmland
     (a strong "build on degraded land" story for E's screening), still PG&E/NP15.
   A recommends, the team picks, D updates `DEFAULT_SITE` in `app/builder/service.py`,
   and A centers `MapView` on `scenario.site.location` instead of the hard-coded Kern view.
2. **Weather year.** 2024 (full CAISO + Open-Meteo history available).
3. **Who demos.** E owns the pitch; D drives the clicks.

## The 3-minute demo this produces

1. *Explore:* California grid map → click a parcel in Kern County → nearest 230/500 kV
   substation 12 km away, nearby plants, satellite screening (flat, scrubland, high solar).
2. *Build:* "We want a 1 GW AI campus here." Pick **Hybrid** (about 1.3 GW solar, 600 MW gas,
   300 MW × 4 h battery; sizes get re-tuned at 7 AM). Raise solar ~25%: gas burn and CO2 fall,
   curtailment rises. That's the trade-off, live.
3. *Simulate:* July day: midday solar surplus charges the battery, which covers the evening
   ramp; gas and imports carry the night.
4. *Evaluate:* $X B CAPEX, LCOE $Y/MWh, Z Mt CO2e/yr; compare all three presets side by side.
5. *Stress test:* switch to **Renewable-heavy**: "unmet in N hours: it needs firming", and
   "interconnection needs a CAISO study" (honest flags; Hybrid itself meets every hour).
6. *Report:* export the BOM + assumptions. Every number shows its source.
