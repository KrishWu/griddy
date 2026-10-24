# GridForge — team rules for every coding agent

Five people build GridForge in parallel, each with their own agent, each on their own
branch, each merging their own PR into `main`. These rules keep the five PRs from
colliding. Follow them even if a task seems to need an exception; ask your human instead.

## 1. Know your workstream

Your human will tell you which workstream you are (A–E). Your brief is
`docs/workstreams/<letter>-*.md`. Read it fully before writing code. If you don't
know your letter, ask.

| | Workstream | Backend | Frontend |
|---|---|---|---|
| A | Explore (map + grid layers) | `backend/app/explore/` | `frontend/components/explore/` |
| B | Simulate + Stress Test | `backend/app/simulate/` | `frontend/components/simulate/` |
| C | Evaluate (costs, emissions, BOM) | `backend/app/evaluate/` | `frontend/components/evaluate/` |
| D | Build + Report + UI shell | `backend/app/builder/` | `frontend/components/builder/`, `frontend/components/shell/AppShell.tsx`, `frontend/app/`, `frontend/lib/store.tsx` |
| E | Site Intelligence (satellite, air, carbon) | `backend/app/site_intel/` | `frontend/components/site_intel/` |

The full map is `ownership.json`.

## 2. Edit only your own paths

- Only create or modify files your workstream owns (see `ownership.json`). Put data
  files in `data/<your module>/`, tests in `backend/tests/test_<your module>*.py`, and
  Python deps in `backend/requirements/<your letter>-*.txt`.
- **Shared files** (`backend/app/contract.py`, `frontend/lib/contract.ts`, `main.py`,
  `pipeline.py`, `frontend/lib/api.ts`, `package.json`, `CLAUDE.md`, ...) are frozen on
  feature branches. Never edit them in your feature PR, because two branches touching
  the same file is exactly what causes merge conflicts.
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

plus `get_layer` / `summarize_site` (A, `app/explore/service.py`), `site_intel` (E,
`app/site_intel/service.py`) and `list_presets` / `report_csv` (D, `app/builder/service.py`).
Replace the function **bodies** freely. Keep the names, parameters, and return types.
Each currently holds a working STUB so the app runs end to end from the start.

Frontend panels read state with `useGridForge()` from `frontend/lib/store.tsx` (owned by
D; ask D for new shared state, keep everything else in local component state) and call
the backend through `frontend/lib/api.ts`. New endpoint in your own router? Call it from
your own component with the exported `request()` / `post()` helpers; don't edit `api.ts`.
New backend endpoints go in your own `router.py`, which `main.py` already registers.

## 4. Stay green

From the repo root:

```bash
cd backend && .venv/bin/pytest -q          # contract + integration tests must pass
cd frontend && npm run typecheck && npm run lint
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

The frontend is Next.js 16 (APIs differ from older versions). Read
`frontend/AGENTS.md` and the guides in `frontend/node_modules/next/dist/docs/` before
writing Next-specific code. Map components must be client components, and MapLibre
must load inside `useEffect`.

## 7. Git

- Branch name: `ws/<letter>-<short-name>`, e.g. `ws/b-simulate`. Branch from the latest `main`.
- Open a **draft PR early** and merge at each integration checkpoint (see
  `docs/WORKSTREAMS.md`). Small merges beat one huge merge at 2 PM.
- Before merging: `git fetch && git merge origin/main`, rerun the tests, run the
  ownership check.
- Sync with `git merge origin/main`, never rebase (other people may have your commits).
- Never force-push. Never commit secrets: API keys go in `backend/.env`
  (git-ignored) and are read with `os.environ`.
