"""The site artifact: what the site-location model (B) hands to the website.  SHARED.

A directory under ml/artifacts/site_location/<artifact_id>/ (LATEST names the newest):

    manifest.json        SiteManifest (below)
    candidates.csv.gz    one row per candidate cell: location, grid/resource/air features, and the
                         suitability of each technology (p_<kind>, kinds as in the backend contract)

The website re-runs the site selection live from candidates (any what-if demand or mix), so the
artifact stores scores and features, not one fixed answer. mode "model" = scores from trained
classifiers; "heuristic" = a transparent hand-weighted score used before the models are trained.
"""

from __future__ import annotations

import json
import shutil
import tempfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal

import numpy as np
import pandas as pd

from ml.contract.demand_artifact import ArtifactError
from ml.contract.regions import REGIONS

SITE_SCHEMA_VERSION = "1.0"
MANIFEST_FILE = "manifest.json"
CANDIDATES_FILE = "candidates.csv.gz"
KINDS = ("solar_pv", "onshore_wind", "battery", "gas_cc")  # AssetKind values the model scores

CANDIDATE_COLUMNS: dict[str, str] = {
    "cell": "int64",
    "lon": "float64",
    "lat": "float64",
    "geoid": "string",  # county FIPS
    "county": "string",
    "region": "string",  # forecast region (ml.contract.regions)
    "d_line_hv_km": "float64",  # nearest operational AC line >= 220 kV
    "d_sub_hv_km": "float64",  # nearest network substation >= 220 kV
    "queue_mw": "float64",  # active interconnection requests in the county (LBNL Queued Up)
    "growth_150km_gwh": "float64",  # new annual demand within 150 km (demand artifact, manifest scenario/year)
    "in_nonattainment": "int64",  # 1 inside an EPA nonattainment area (gas permitting risk)
    "ghi_kwh_m2_day": "float64",  # mean solar resource (ERA5 via Open-Meteo)
    "wind100_ms": "float64",  # mean wind speed at 100 m (ERA5 via Open-Meteo)
}


@dataclass
class SiteManifest:
    artifact_id: str
    mode: Literal["model", "heuristic"]
    created_utc: str
    demand_artifact_id: str
    scenario: str  # demand scenario/year behind the nearby-demand features and growth_150km_gwh
    year: int
    kinds: list[str]  # which p_<kind> columns are present
    grid_spacing_km: float
    producer: dict[str, Any]
    model_metrics: dict[str, Any] = field(default_factory=dict)  # per kind: spatial-CV ROC-AUC, PR-AUC, positives
    provenance: list[dict[str, Any]] = field(default_factory=list)
    schema_version: str = SITE_SCHEMA_VERSION

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> SiteManifest:
        missing = {"artifact_id", "mode", "created_utc", "demand_artifact_id", "scenario", "year", "kinds", "grid_spacing_km", "producer"} - set(d)
        if missing:
            raise ArtifactError(f"site manifest is missing {sorted(missing)}")
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class SiteArtifact:
    manifest: SiteManifest
    candidates: pd.DataFrame


def _validate(manifest: SiteManifest, cand: pd.DataFrame) -> pd.DataFrame:
    if manifest.schema_version.split(".")[0] != SITE_SCHEMA_VERSION.split(".")[0]:
        raise ArtifactError(f"site schema {manifest.schema_version} is incompatible with this reader ({SITE_SCHEMA_VERSION})")
    if manifest.mode not in ("model", "heuristic"):
        raise ArtifactError(f"unknown site artifact mode {manifest.mode!r}")
    if not manifest.kinds or set(manifest.kinds) - set(KINDS):
        raise ArtifactError(f"kinds must be a non-empty subset of {KINDS}")
    cols = {**CANDIDATE_COLUMNS, **{f"p_{k}": "float64" for k in manifest.kinds}}
    missing = [c for c in cols if c not in cand.columns]
    if missing:
        raise ArtifactError(f"{CANDIDATES_FILE}: missing columns {missing}")
    out = cand[list(cols)].copy()
    for c, t in cols.items():
        out[c] = out[c].astype(t)
    if out.isna().any().any():
        raise ArtifactError(f"{CANDIDATES_FILE}: null values in {out.columns[out.isna().any()].tolist()}")
    if out["cell"].duplicated().any():
        raise ArtifactError(f"{CANDIDATES_FILE}: duplicate cell ids")
    if set(out["region"]) - set(REGIONS):
        raise ArtifactError(f"{CANDIDATES_FILE}: unknown regions {sorted(set(out['region']) - set(REGIONS))}")
    p = out[[f"p_{k}" for k in manifest.kinds]].to_numpy()
    if not np.isfinite(p).all() or (p < 0).any() or (p > 1).any():
        raise ArtifactError(f"{CANDIDATES_FILE}: suitability must be within [0, 1]")
    if not out["lon"].between(-125, -113).all() or not out["lat"].between(32, 42.5).all():
        raise ArtifactError(f"{CANDIDATES_FILE}: coordinates outside California")
    return out


def write_site_artifact(out_dir: str | Path, manifest: SiteManifest, candidates: pd.DataFrame) -> Path:
    cand = _validate(manifest, candidates)
    out = Path(out_dir)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=f".{out.name}-", dir=out.parent))
    try:
        (tmp / MANIFEST_FILE).write_text(json.dumps(manifest.to_dict(), indent=2, allow_nan=False), encoding="utf-8")
        cand.to_csv(tmp / CANDIDATES_FILE, index=False, float_format="%.5f", compression="gzip")
        if out.exists():
            shutil.rmtree(out)
        tmp.replace(out)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return out


def read_site_artifact(path: str | Path) -> SiteArtifact:
    p = Path(path)
    if not (p / MANIFEST_FILE).is_file() or not (p / CANDIDATES_FILE).is_file():
        raise ArtifactError(f"{p} is not a site artifact (needs {MANIFEST_FILE} and {CANDIDATES_FILE})")
    manifest = SiteManifest.from_dict(json.loads((p / MANIFEST_FILE).read_text(encoding="utf-8")))
    cand = pd.read_csv(p / CANDIDATES_FILE, dtype={"geoid": "string", "county": "string", "region": "string"})
    return SiteArtifact(manifest=manifest, candidates=_validate(manifest, cand))
