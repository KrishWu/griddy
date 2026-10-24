"""Runs the data center feasibility score's tests inside pytest.  OWNER: workstream E.

The score is computed in the browser (frontend/components/site_intel/feasibility.ts) so it can
follow the scenario's load without a round trip. Its tests are node:test files that Node 22.18+
runs directly (type stripping, no extra packages); skipped when no such Node is on PATH.
"""

import re
import shutil
import subprocess
from pathlib import Path

import pytest

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
TESTS = FRONTEND / "components" / "site_intel" / "feasibility.test.mjs"


def _node() -> str | None:
    node = shutil.which("node")
    if not node:
        return None
    version = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=30).stdout.strip()
    m = re.match(r"v(\d+)\.(\d+)", version)
    return node if m and (int(m[1]), int(m[2])) >= (22, 18) else None


def test_feasibility_score():
    node = _node()
    if node is None:
        pytest.skip("needs Node >= 22.18 on PATH to run the .ts scoring module directly")
    r = subprocess.run([node, "--test", str(TESTS)], cwd=FRONTEND, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stdout[-4000:] + r.stderr[-2000:]
