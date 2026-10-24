# Griddy — team rules for every coding agent

Five people build Griddy in parallel, each with their own agent, each on their own
branch, each merging their own PR into `main`. These rules keep the five PRs from
colliding. Follow them even if a task seems to need an exception; ask your human instead.

The product was renamed from GridForge to Griddy on 2026-10-24. Use "Griddy" in anything a
user or judge sees. Code identifiers keep the old name on purpose (`useGridForge`,
`GridForgeProvider`, `GRIDFORGE_API_ORIGIN`, the `gridforge:scenario` storage key); don't
rename them mid-hackathon.

## 1. Know your workstream

Your human will tell you which workstream you are (A–E). Your brief is
`docs/workstreams/<letter>-*.md`. Read it fully before writing code. If you don't
know your letter, ask.

| | Workstream | Backend | Frontend |
|---|---|---|---|
| A | Explore (map + grid layers), demand forecast | `backend/app/explore/`, `backend/app/forecast/`, `ml/demand_forecast/` | `frontend/components/explore/`, `frontend/components/forecast/` |
| B | Simulate + Stress Test, site ranking | `backend/app/simulate/`, `backend/app/sites/`, `ml/site_location/` | `frontend/components/simulate/`, `frontend/components/sites/` |
| C | Evaluate (costs, emissions, BOM) | `backend/app/evaluate/` | `frontend/components/evaluate/` |
| D | Build + Report + UI shell | `backend/app/builder/` | `frontend/components/builder/`, `frontend/components/shell/AppShell.tsx`, `frontend/app/`, `frontend/lib/store.tsx`, `frontend/public/` |
| E | Site Intelligence (satellite, air, carbon), pitch | `backend/app/site_intel/` | `frontend/components/site_intel/`, `docs/pitch/` |

The full map is `ownership.json`. The app-wide UI added on 2026-10-24 (`frontend/components/`
`about/`, `glossary/`, `settings/`, the other `shell/` files, `frontend/lib/settings.tsx` and
`frontend/lib/glossary.ts`) isn't assigned to a workstream, so `check_ownership.py` fails a `ws/*`
branch that touches it: change it in a `foundation/<what>` PR, like a shared file.

## 2. Edit only your own paths

- Only create or modify files your workstream owns (see `ownership.json`). Put data
  files in `data/<your module>/`, tests in `backend/tests/test_<your module>*.py`, and
  Python deps in `backend/requirements/<your letter>-*.txt`.
- **Data paths:** build them with `from app import DATA_DIR` (e.g.
  `DATA_DIR / "explore" / "plants_ca.geojson"`), never relative to the working directory
  (it's `backend/` under uvicorn and pytest). Raw downloads go in `data/<module>/raw/`
  and caches in `data/<module>/cache/`; both are git-ignored. Commit only small processed
  files, never anything over ~20 MB, and never licensed imagery.
- **Shared files** (`backend/app/contract.py`, `frontend/lib/contract.ts`, `main.py`,
  `pipeline.py`, `frontend/lib/api.ts`, `package.json`, `CLAUDE.md`, ...) are frozen on
  feature branches. Never edit them in your feature PR, because two branches touching
  the same file is exactly what causes merge conflicts. `check_ownership.py` (and CI)
  fails a `ws/*` branch that touches one. Shared changes travel in their own small PR
  from a `contract/<what>`, `deps/<what>` or `foundation/<what>` branch, merged right away.
- **Need a contract change?** First try the escape hatches: `extras` on your result,
  `scenario.options` for inputs. If a typed field is truly needed, make a separate tiny
  PR to `main` from a `contract/<what>` branch containing ONLY `contract.py`, the matching
  `contract.ts` change, and the output of `backend/.venv/bin/python scripts/export_contract.py`.
  Optional fields only: never rename, remove, or change units. Get it merged right away,
  have your human post it in chat, then `git merge origin/main` into your branch.
- Need something from another workstream? Don't edit their file. Use the stub that's
  already there, and ask your human to message its owner.
- Need a new npm package? Ask your human to ask D. Never run `npm install <pkg>` on a
  feature branch: one lockfile rewrite conflicts with every other PR. Use `npm ci` to sync
  (`.claude/settings.json` blocks the install commands).
- Never run a formatter, linter `--fix`, or search-and-replace across the repo. Limit it
  to your own paths, or you'll silently create conflicts in four other PRs.
- Before every push, run `python3 scripts/check_ownership.py <letter>` and fix any FAIL.

## 3. Keep function signatures stable

`backend/app/pipeline.py` wires the modules together by calling:

```python
catalog = get_catalog()                          # C: app/evaluate/catalog.py
sim = simulate(scenario, catalog)                # B: app/simulate/engine.py
evaluation = evaluate(scenario, sim, catalog)    # C: app/evaluate/economics.py
findings = stress_test(scenario, sim)            # B: app/simulate/stress.py
```

then appends `site_findings(scenario, sim, evaluation)` (E, `app/site_intel/service.py`;
an optional hook: if it raises, the run still succeeds), plus `get_layer` /
`summarize_site` (A, `app/explore/service.py`), `site_intel` (E) and `list_presets` /
`report_csv` (D, `app/builder/service.py`).
Replace the function **bodies** freely. Keep the names, parameters, and return types.
Each currently holds a working STUB so the app runs end to end from the start.

Frontend panels read state with `useGridForge()` from `frontend/lib/store.tsx` (owned by
D; ask D for new shared state, keep everything else in local component state) and call
the backend through `frontend/lib/api.ts`. New endpoint in your own router? Call it from
your own component with the exported `request()` / `post()` helpers; don't edit `api.ts`.
New backend endpoints go in your own `router.py`, which `main.py` already registers.

## 4. Stay green

From the repo root (subshells, so your working directory doesn't change):

```bash
(cd backend && .venv/bin/pytest -q) && (cd frontend && npm run typecheck && npm run lint) && python3 scripts/check_ownership.py <letter>
```

`backend/tests/test_contract.py` checks that every preset runs and that energy
balances every hour. If you break it, fix it before you push. When you write tests,
assert ranges and invariants (e.g. "LCOE between $40 and $200/MWh"), not exact dollars,
because other workstreams' real data will keep moving the numbers.

Need a new output or input that isn't in the contract yet? Put it in the `extras`
dict on your result (or `scenario.options` for inputs) first. It gets a typed field later
if other workstreams need it.

## 5. Transparency over magic

Every number shown to a judge needs a `Provenance` (observed / assumption / simulated /
inferred, with source). Label estimates as estimates. Anything that would really need a
utility interconnection study gets a `Finding` with `needs_utility_study: true`.

## 6. Running the app

```bash
scripts/setup.sh    # once: backend venv + npm ci
scripts/dev.sh      # backend on :8000, frontend on :3000 (frontend proxies /api)
```

The live app is https://getgriddy.app: the frontend is static files on Cloudflare Pages and
the backend runs on Render. Render redeploys the backend after CI passes on `main`; the
frontend is deployed separately (`deploy/cloudflare-pages/README.md`), so a merged frontend
change isn't live until someone deploys it.

The frontend is Next.js 16 (APIs differ from older versions). Read
`frontend/AGENTS.md` and the guides in `frontend/node_modules/next/dist/docs/` before
writing Next-specific code. Map components must be client components, and MapLibre
must load inside `useEffect`.

## 7. Git

- The repo is https://github.com/KrishWu/griddy (it moved from `heruirayli/cleantech-hacks`;
  old URLs and remotes redirect, or run `git remote set-url origin https://github.com/KrishWu/griddy.git`).
- Branch name: `ws/<letter>-<short-name>`, e.g. `ws/b-simulate`. Branch from the latest `main`.
- Open a **draft PR early** (GitHub needs one commit first:
  `git commit --allow-empty -m "ws/<letter>: start" && git push -u origin HEAD && gh pr create --draft --fill`)
  and merge at each integration checkpoint (see `docs/WORKSTREAMS.md`). Small merges
  beat one huge merge at 2 PM.
- Before merging: `git fetch && git merge origin/main`, rerun the tests, run the
  ownership check.
- Sync with `git merge origin/main`, never rebase (other people may have your commits).
- Never force-push. Never commit secrets: API keys go in `backend/.env` (git-ignored;
  copy `backend/.env.example`). `backend/app/__init__.py` loads it automatically, so
  read keys with `os.environ.get("NAME")`.
