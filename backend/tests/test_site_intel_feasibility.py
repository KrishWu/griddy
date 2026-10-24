"""Runs the GriddyGrade's tests inside pytest.  OWNER: workstream E.

The power plant score is computed in the browser (frontend/components/site_intel/feasibility.ts)
so a technology or capacity change needs no round trip. Its tests (the score, its percentile and the
California placement region) are node:test files that Node 22.18+ runs directly (type stripping,
no extra packages); skipped when no such Node is on PATH.
"""

import re
import shutil
import subprocess
from pathlib import Path

import pytest

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
TESTS = sorted((FRONTEND / "components" / "site_intel").glob("*.test.mjs"))


def _node() -> str | None:
    node = shutil.which("node")
    if not node:
        return None
    version = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=30).stdout.strip()
    m = re.match(r"v(\d+)\.(\d+)", version)
    return node if m and (int(m[1]), int(m[2])) >= (22, 18) else None


@pytest.mark.parametrize("tests", TESTS, ids=lambda p: p.name)
def test_griddy_grade(tests: Path):
    node = _node()
    if node is None:
        pytest.skip("needs Node >= 22.18 on PATH to run the .ts scoring module directly")
    r = subprocess.run([node, "--test", str(tests)], cwd=FRONTEND, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stdout[-4000:] + r.stderr[-2000:]


def test_both_test_files_are_found():
    assert {p.name for p in TESTS} >= {"feasibility.test.mjs", "percentile.test.mjs"}
