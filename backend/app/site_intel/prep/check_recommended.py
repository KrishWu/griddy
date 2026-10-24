"""Sanity check: B's recommended sites should grade well for the plants B recommends there.  OWNER: E.

    python -m app.site_intel.prep.check_recommended [--node PATH]     (from backend/)

Runs B's default recommendation (recommend(SiteRequest()): the sites the website lists under
"Where to build"), then grades every site with the live TypeScript (gradeSites.mjs) for its own
technology and nameplate MW, from the same offline inputs as the percentile reference
(grade_percentiles.py). Batteries are storage, which the power plant grade does not score by
design, so they are listed as not scored. Prints a table and a summary per technology.
"""

from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import tempfile
from pathlib import Path

from app.contract import SiteRequest
from app.explore.service import summarize_site
from app.site_intel.prep.grade_percentiles import FRONTEND, _node, nonattainment_loaded, offline_intel

SCRIPT = FRONTEND / "components" / "site_intel" / "prep" / "gradeSites.mjs"
# B's AssetKind -> the grade's technology. gas_cc is B's label for every gas plant the model learned from.
KIND_TO_TECH = {"solar_pv": "solar_pv", "onshore_wind": "onshore_wind", "gas_cc": "natural_gas"}


def recommended_sites() -> list:
    from app.sites.service import recommend

    rec = recommend(SiteRequest())
    if not rec.available:
        raise SystemExit("site recommendations unavailable (missing site or forecast artifact)")
    return rec.sites


def grade_sites(sites: list, node: str) -> tuple[list[dict], list]:
    """(grades for the generation sites, the storage sites left unscored)."""
    loaded = nonattainment_loaded()
    storage = [s for s in sites if s.kind not in KIND_TO_TECH]
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "sites.jsonl"
        with path.open("w", encoding="utf-8") as f:
            for s in sites:
                if s.kind not in KIND_TO_TECH:
                    continue
                row = {
                    "id": s.id,
                    "technology": KIND_TO_TECH[s.kind],
                    "capacityMw": s.mw,
                    "summary": summarize_site(s.location).model_dump(mode="json"),
                    "intel": offline_intel(s.location, loaded),
                }
                f.write(json.dumps(row, separators=(",", ":")) + "\n")
        cmd = [node, "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", str(SCRIPT), str(path)]
        r = subprocess.run(cmd, cwd=FRONTEND, capture_output=True, text=True, encoding="utf-8", check=False, timeout=300)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-4000:])
    return json.loads(r.stdout), storage


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--node", help="Node >= 22.18 executable (default: $NODE or node on PATH)")
    args = ap.parse_args()
    grades, storage = grade_sites(recommended_sites(), _node(args.node))
    print(f"{'site':<28} {'tech':<13} {'MW':>6} {'tier':>5} {'score':>5} {'pctl':>5} {'G':>5} {'R':>5} {'E':>5} {'C':>5} {'I':>5} compl  category")
    for g in sorted(grades, key=lambda g: (g["technology"], -g.get("raw", 0))):
        if not g["valid"]:
            print(f"{g['id']:<28} {g['technology']:<13} invalid: {'; '.join(g['errors'])}")
            continue
        c = g["components"]
        print(
            f"{g['id']:<28} {g['technology']:<13} {g['capacityMw']:>6.0f} {g['tierKv']:>5} {g['score']:>5} {g['percentile'] or float('nan'):>5.1f} "
            + " ".join(f"{c[k]['score']:>5.0f}" for k in ("grid", "resource", "environment", "community", "administrative"))
            + f" {g['completeness']:>4.0f}%  {g['category']}"
        )
    for s in storage:
        print(f"{s.id:<28} {s.kind:<13} {s.mw:>6.0f}  not scored: storage is not primary generation")
    print()
    for tech in sorted({g["technology"] for g in grades}):
        gs = [g for g in grades if g["technology"] == tech and g["valid"]]
        scores, pct = [g["score"] for g in gs], [g["percentile"] for g in gs if g["percentile"] is not None]
        print(
            f"{tech:<13} n={len(gs):>3}  score min {min(scores)} median {statistics.median(scores):.0f} max {max(scores)}"
            + (f"  percentile min {min(pct):.1f} median {statistics.median(pct):.1f}" if pct else "")
        )
    print(f"storage       n={len(storage):>3}  not scored")


if __name__ == "__main__":
    main()
