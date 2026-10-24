"""B's recommended sites grade well for the plants B recommends there.  OWNER: workstream E.

A cross-check between two independent views of "where to build": B's site recommender (an LP over
the site-location model, grid distance, queue and demand growth) and E's power plant GriddyGrade
(app/site_intel/prep/check_recommended.py runs the same TypeScript the browser does). Thresholds
are ranges, not exact grades: the artifacts will keep moving the numbers. Batteries are storage,
which the grade does not score by design.

Needs Node >= 22.18 on PATH (skipped otherwise) and takes about a minute (recommend() solves an LP).
"""

import re
import shutil
import subprocess

import pytest

from app.site_intel.prep import check_recommended as check

MIN_SCORE = 55  # every recommended generation site is at least "Mixed constraints" and above the median
MIN_PERCENTILE = 50
TOP_SHARE = 0.9  # and nearly all of them rank in the top fifth for their technology and size class
TOP_PERCENTILE = 80


def _node() -> str | None:
    node = shutil.which("node")
    if not node:
        return None
    version = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=30).stdout.strip()
    m = re.match(r"v(\d+)\.(\d+)", version)
    return node if m and (int(m[1]), int(m[2])) >= (22, 18) else None


@pytest.fixture(scope="module")
def graded():
    node = _node()
    if node is None:
        pytest.skip("needs Node >= 22.18 on PATH to run the .ts scoring module directly")
    try:
        sites = check.recommended_sites()
    except SystemExit as e:
        pytest.skip(str(e))
    return check.grade_sites(sites, node)


def test_every_recommended_generation_site_grades_relatively_high(graded):
    grades, _ = graded
    assert grades, "no generation sites recommended"
    assert all(g["valid"] for g in grades)
    low = [(g["id"], g["score"], g["percentile"]) for g in grades if g["score"] < MIN_SCORE or (g["percentile"] or 0) < MIN_PERCENTILE]
    assert not low, low
    top = sum((g["percentile"] or 0) >= TOP_PERCENTILE for g in grades) / len(grades)
    assert top >= TOP_SHARE, f"only {top:.0%} in the top fifth"


def test_grades_use_each_site_s_own_technology_and_size(graded):
    grades, _ = graded
    for g in grades:
        assert g["technology"] in ("solar_pv", "onshore_wind", "natural_gas")
        assert g["tierKv"] == (69 if g["capacityMw"] <= 20 else 115 if g["capacityMw"] <= 100 else 220)
        assert g["components"]["resource"]["status"] != "unavailable"  # the model scores every one of these kinds
        assert g["constraints"] != "none_identified_in_available_data"  # Griddy can't clear what it has no data for


def test_storage_sites_are_listed_not_scored(graded):
    _, storage = graded
    assert all(s.kind == "battery" for s in storage)
