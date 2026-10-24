"""Bridge from the API to the Phase 2 model artifacts.  SHARED (foundation).

Models train elsewhere (ml/, see ml/README.md) and commit artifacts under ml/artifacts/.
The API only reads them: no training dependencies, no network. This module makes the
artifact contract (ml/contract, pandas only) importable from backend/ and says where the
artifacts live. Set GRIDDY_ML_ARTIFACTS to point the API at another directory (e.g. a
fresh export on a demo laptop) without committing it.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from app import DATA_DIR

REPO_DIR = DATA_DIR.parent
if str(REPO_DIR) not in sys.path:
    sys.path.append(str(REPO_DIR))  # `import ml.contract` from backend/ (uvicorn and pytest run there)

ML_ARTIFACTS_DIR = Path(os.environ.get("GRIDDY_ML_ARTIFACTS") or REPO_DIR / "ml" / "artifacts")


def latest(kind_dir: str, pointer: str) -> Path | None:
    """The artifact a LATEST_* pointer file names, e.g. latest("demand_forecast", "LATEST_FORECAST")."""
    ptr = ML_ARTIFACTS_DIR / kind_dir / pointer
    if not ptr.is_file():
        return None
    path = ML_ARTIFACTS_DIR / kind_dir / ptr.read_text(encoding="utf-8").strip()
    return path if path.is_dir() else None
