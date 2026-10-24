# Workstream D — Build + Report + UI shell

**Mission:** the product people click through. A scenario builder that feels like
designing a power campus, a side-by-side compare of the presets, an exportable report,
and the overall layout and polish that makes the other four slices look like one app.
You drive the demo.

**Branch:** `ws/d-builder` · **Check:** `python3 scripts/check_ownership.py D`

## You own

- `backend/app/builder/` (presets, report export, `router.py`)
- `frontend/components/builder/` (`BuildPanel.tsx`, `ReportPanel.tsx`, compare view, assumptions drawer)
- `frontend/components/shell/AppShell.tsx` (layout: which panels show where and when)
- `frontend/lib/store.tsx` (app state: **you are its only editor**; others ask you for new shared state)
- `frontend/app/` (page, layout, globals.css), `frontend/public/`
- `backend/tests/test_builder*.py`, `backend/requirements/d-builder.txt`

## Contract you implement (keep these signatures)

```python
# backend/app/builder/service.py
def list_presets(site: Site | None = None) -> list[Scenario]
def report_csv(result: ScenarioResult) -> str
```

Endpoints (already wired): `GET /api/presets`, `POST /api/report.csv`, and from the
foundation: `POST /api/run`, `POST /api/compare`.

## P0, in order

| # | Task | Target |
|---|---|---|
| 1 | **Builder UX:** asset cards with sliders + number inputs (MW, battery hours), add/remove assets, demand inputs (peak MW, PUE, load factor, profile), grid import/export limits, interconnection km (prefill from A's `SiteSummary.nearest_line_km`). Debounced auto-run after edits: `useEffect(() => { const t = setTimeout(run, 500); return () => clearTimeout(t); }, [run]);` (`run()` already drops stale responses). | 1 AM |
| 2 | **Presets:** keep the three (Grid-connected, Hybrid, Renewable-heavy) on the agreed demo site (A gives you coordinates). Label them as "illustrative configurations" in the UI. Sizes are set *relative to load* (see the docstring in `service.py`) so each tells its story: Hybrid meets every hour and its battery cycles daily; Renewable-heavy is deliberately thin on firm power so the stress test has something honest to flag. If the user changes peak MW, consider scaling the preset assets with it. | 1 AM |
| 3 | **Compare mode:** run `/api/compare` on the presets (plus the user's current scenario) and show C's `ComparisonTable` (`@/components/evaluate/ComparisonTable`; it already exists as a working stub, and C fills it in) + small dispatch thumbnails you build from `simulation.hourly`. Toggle between Single and Compare in `AppShell`. Add the store fields for this. | 7 AM |
| 4 | **Report:** CSV (exists) + a printable report page (`frontend/app/report/page.tsx`, print CSS → "Save as PDF"; no new deps). `GridForgeProvider` lives in `app/layout.tsx`, so `/report` sees the same `result` after a client-side `<Link>` navigation (a hard reload starts empty) with headline metrics, BOM, findings, and a full assumptions/provenance table. | 11 AM |
| 5 | **Polish + demo flow:** loading/error/empty states, a header with mode switch (Industrial / Community), assumptions drawer (basic/advanced: discount rate, gas price (edits the `gas_price_usd_per_mmbtu` scalar, which C treats as the annual average), carbon price, weather year), consistent colors, works on a projector at 1280×720. Rehearse the 3-minute demo with E. | 11 AM |

## Stretch

- **Place assets on the map:** "Place" button sets `asset.location` on the next map click
  (store field); A draws the markers in `MapView`.
- **Mode B (community):** a community preset (e.g. 20 MW neighborhood with rooftop solar
  and a community battery) using B's `community` demand profile.
- Save/load scenarios to `localStorage`; shareable URL with the scenario encoded.

## Coordination

- **A:** default site coordinates, and the nearest-line distance for interconnection km.
- **B / C / E:** they build their own panels; you decide where those panels sit and when
  they show. If someone needs shared state (e.g. E's carbon-aware toggle), you add it
  to `store.tsx`.
- New npm packages for anyone go through you, so the lockfile only changes on one
  branch. The repo's `.claude/settings.json` blocks agents from `npm install`, so run it
  yourself in a terminal on a `deps/<what>` branch (a `ws/` branch would fail the ownership
  check), commit `package.json` + `package-lock.json` alone in a small PR,
  merge it to `main` right away, and tell everyone to `git merge origin/main && npm ci`.
- You are the **merge captain** at each checkpoint: merge PRs one at a time in producer →
  consumer order (**C → B → A → E → D**), run the tests after each, and post "main is green".
- When results come from STUB/placeholder data (any `Provenance.source` starting with
  "STUB" or "PLACEHOLDER"), show a visible "placeholder data" badge. Judges reward honesty.

## Done means

- A first-time user can go map → preset → tweak → run → compare → export without help.
- `npm run typecheck && npm run lint` clean; the layout holds at 1280×720 and 1920×1080.
