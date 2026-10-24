"""GriddyGrade percentile cut-offs: every 5 km cell of California, scored like a live click.  OWNER: E.

For each cell of B's site artifact this runs A's site summary and the parts of E's site intel
the grade reads (EPA nonattainment, the model signals and the voltage-tier grid search, all
offline), writes them to data/site_intel/cache/grade_reference.jsonl.gz, then has Node score them
with the live TypeScript (readSummary -> feasibilityInput -> calculatePowerPlantFeasibility, see
frontend/components/site_intel/prep/gradePercentiles.mjs), so the percentile can't drift from
the grade. Node keeps the plausible sites, computes 101 cut-offs per technology and voltage tier
and writes frontend/components/site_intel/gradePercentiles.json (a few KB). Rerun after changing
the policy (feasibilityPolicy.ts), the formula or the artifacts.

    python -m app.site_intel.prep.grade_percentiles [--node PATH] [--limit N]     (from backend/)

Needs Node >= 22.18 (runs the .ts directly). About a minute for ~15,000 cells.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

from app import DATA_DIR
from app.contract import LngLat
from app.explore.service import summarize_site
from app.site_intel import air, grid_tiers, ml

FRONTEND = DATA_DIR.parent / "frontend"
REFERENCE = DATA_DIR / "site_intel" / "cache" / "grade_reference.jsonl.gz"
SCRIPT = FRONTEND / "components" / "site_intel" / "prep" / "gradePercentiles.mjs"
OUT = FRONTEND / "components" / "site_intel" / "gradePercentiles.json"


def offline_intel(loc: LngLat, nonattainment_loaded: bool) -> dict:
    """The parts of site_intel(loc) the grade scores, without the network (AQI and land are context only)."""
    return {
        "location": loc.model_dump(),
        "land_cover": {},
        "air_quality": None,  # context only, never scored
        "overlays": [],
        "findings": [],
        "provenance": [],
        "extras": {
            "nonattainment": air.nonattainment_at(loc),
            "nonattainment_available": nonattainment_loaded,
            "ml": ml.ml_context(loc),
            "grid_tiers": grid_tiers.grid_tiers(loc),
        },
    }


def nonattainment_loaded() -> bool:
    return isinstance((air._load(air.NONATTAINMENT) or {}).get("features"), list)


def write_reference(path: Path = REFERENCE, limit: int | None = None) -> int:
    table = ml._table()
    if table is None:
        raise SystemExit("no site-location artifact (ml/artifacts/site_location/LATEST)")
    loaded = nonattainment_loaded()
    path.parent.mkdir(parents=True, exist_ok=True)
    n = len(table.cell) if limit is None else min(limit, len(table.cell))
    t0 = time.monotonic()
    with gzip.open(path, "wt", encoding="utf-8") as f:
        for i in range(n):
            loc = LngLat(lon=float(table.lon[i]), lat=float(table.lat[i]))
            summary = summarize_site(loc).model_dump(mode="json")
            intel = offline_intel(loc, loaded)
            f.write(json.dumps({"cell": int(table.cell[i]), "summary": summary, "intel": intel}, separators=(",", ":")) + "\n")
            if (i + 1) % 2000 == 0:
                print(f"  {i + 1:,}/{n:,} cells, {time.monotonic() - t0:.0f} s", flush=True)
    return n


def _node(explicit: str | None) -> str:
    node = explicit or os.environ.get("NODE") or shutil.which("node")
    if not node:
        raise SystemExit("Node >= 22.18 not found: pass --node PATH or set NODE")
    return node


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--node", help="Node >= 22.18 executable (default: $NODE or node on PATH)")
    ap.add_argument("--limit", type=int, help="score only the first N cells (a quick check)")
    ap.add_argument("--reuse", action="store_true", help="reuse the cached reference file instead of rebuilding it")
    args = ap.parse_args()
    node = _node(args.node)
    if not (args.reuse and REFERENCE.is_file()):
        n = write_reference(REFERENCE, args.limit)
        print(f"{REFERENCE.name}: {n:,} cells", flush=True)
    t = ml._table()
    meta = {"site_artifact": t.artifact_id if t else None}
    cmd = [node, "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", str(SCRIPT), str(REFERENCE), str(OUT), json.dumps(meta)]
    r = subprocess.run(cmd, cwd=FRONTEND, check=False)
    if r.returncode != 0:
        raise SystemExit(r.returncode)


if __name__ == "__main__":
    main()
