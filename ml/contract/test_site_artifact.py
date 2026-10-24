"""Contract tests for the site artifact.  Run from the repo root:  python -m pytest ml"""

from __future__ import annotations

import pandas as pd
import pytest

from ml.contract.demand_artifact import ArtifactError
from ml.contract.site_artifact import SiteManifest, read_site_artifact, write_site_artifact


def _manifest(kinds=("solar_pv", "battery")) -> SiteManifest:
    return SiteManifest("s", "heuristic", "2026-10-24T00:00:00Z", "demand-x", "mid", 2035, list(kinds), 5.0, {"package": "test"})


def _cand(n=3) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "cell": range(n),
            "lon": [-119.5] * n,
            "lat": [35.4] * n,
            "geoid": ["06029"] * n,
            "county": ["Kern"] * n,
            "region": ["PGAE"] * n,
            "d_line_hv_km": [1.0, 5.0, 20.0][:n],
            "d_sub_hv_km": [2.0] * n,
            "queue_mw": [28_000.0] * n,
            "growth_150km_gwh": [900.0] * n,
            "in_nonattainment": [1] * n,
            "ghi_kwh_m2_day": [5.6] * n,
            "wind100_ms": [5.0] * n,
            "p_solar_pv": [0.9, 0.5, 0.1][:n],
            "p_battery": [0.8, 0.4, 0.2][:n],
        }
    )


def test_roundtrip(tmp_path):
    art = read_site_artifact(write_site_artifact(tmp_path / "s", _manifest(), _cand()))
    assert art.candidates["geoid"].iloc[0] == "06029" and art.manifest.kinds == ["solar_pv", "battery"]


@pytest.mark.parametrize(
    "mutate, message",
    [
        (lambda c: c.drop(columns="p_battery"), "missing columns"),
        (lambda c: c.assign(p_solar_pv=1.5), r"\[0, 1\]"),
        (lambda c: c.assign(region="XX"), "unknown regions"),
        (lambda c: c.assign(lat=45.0), "outside California"),
        (lambda c: c.assign(cell=0), "duplicate"),
    ],
)
def test_rejects_violations(tmp_path, mutate, message):
    with pytest.raises(ArtifactError, match=message):
        write_site_artifact(tmp_path / "x", _manifest(), mutate(_cand()))


def test_rejects_unknown_kind(tmp_path):
    with pytest.raises(ArtifactError, match="kinds"):
        write_site_artifact(tmp_path / "k", _manifest(kinds=("coal",)), _cand())
