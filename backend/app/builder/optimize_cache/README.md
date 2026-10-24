# Committed optimizer responses

`POST /api/projects/optimize` serves a file from this folder instead of searching live when the
request matches it exactly, so the demo never depends on a live run on Render's free plan.

- Each `<name>.json` holds `{name, optimizer_version, request_hash, created_utc, request, response}`.
- `request_hash` is `optimizer.request_hash(request)`: sha256 of the canonical request (defaults
  filled in, plus `OPTIMIZER_VERSION`). The scenario's assets, name, preset and the options the
  search overwrites (`project`, `sizing`, `optimizer`) are left out, so the cache hits from any
  starting design on the same site, demand, grid and assumptions.
- A served file says so: `precomputed: true`, and its `basis` ends with "(precomputed for this
  exact request on <date>)".
- Bumping `OPTIMIZER_VERSION` in `optimizer.py` invalidates every file here; rewrite them.
- With `placement: "site_model"` (the default) the response also depends on B's site model and on
  the weather at its cells. Write the file with the network on: a cell that isn't pre-baked or in
  `data/simulate/cache/` costs one Open-Meteo fetch, and offline it gets the nearest pre-baked site's
  weather as a stand-in (the response's `placement.notes` say which). A new site artifact or catalog
  makes a file stale without changing its hash, so rewrite it after those merge.

Write or refresh one (from `backend/`):

```bash
.venv/Scripts/python -m app.builder.optimizer --write-cache kern_80            # built-in demo request
.venv/Scripts/python -m app.builder.optimizer --write-cache my_demo --request body.json
```

`kern_80` is the store's default industrial preset (hybrid, Buttonwillow by Midway 500 kV) with an
80% on-site clean target and every other input at its default. `--request` takes the exact JSON body
the UI posted (copy it from the browser's network tab) so the hash matches what the demo sends.
Files are compact JSON of a few hundred KB; keep only the demo requests here.
