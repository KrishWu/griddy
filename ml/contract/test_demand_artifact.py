"""Contract tests for the demand artifact.  Run from the repo root:  python -m pytest ml"""

from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest

from ml.contract.demand_artifact import (
    COUNTY_FILE,
    HOURLY_FILE,
    MANIFEST_FILE,
    ArtifactError,
    Manifest,
    read_artifact,
    write_artifact,
)


def _manifest(kind="forecast", years=(2024, 2035), scenarios=("base", "mid")) -> Manifest:
    return Manifest(
        artifact_id="test",
        kind=kind,
        base_year=2024,
        years=list(years),
        scenarios={s: {} for s in scenarios},
        created_utc="2026-10-24T00:00:00Z",
        producer={"package": "test"},
    )


def _county(rows=(("base", 2024, 1.0), ("mid", 2035, 1.3))) -> pd.DataFrame:
    out = []
    for scenario, year, f in rows:
        for geoid, county, region, share in (("06029", "Kern", "PGAE", 0.03), ("06029", "Kern", "SCE", 0.01), ("06019", "Fresno", "PGAE", 0.06)):
            mwh = 1e6 * share * 10 * f
            out.append(
                {
                    "geoid": geoid,
                    "county": county,
                    "region": region,
                    "scenario": scenario,
                    "year": year,
                    "annual_energy_mwh": mwh,
                    "avg_mw": mwh / 8760,
                    "peak_mw_p50": mwh / 8760 * 1.6,
                    "peak_mw_p90": mwh / 8760 * 1.7,
                    "added_load_mw": 0.0,
                    "population_share": share,
                    "kind": "observed_downscaled" if scenario == "base" else "forecast",
                }
            )
    return pd.DataFrame(out)


def _hourly(region="PGAE", scenario="mid", year=2035) -> pd.DataFrame:
    n = 8760
    p50 = 10_000 + 2_000 * np.sin(np.arange(n) / 24 * 2 * np.pi)
    return pd.DataFrame(
        {"region": region, "scenario": scenario, "year": year, "hour": np.arange(n), "demand_mw_p10": p50 * 0.95, "demand_mw_p50": p50, "demand_mw_p90": p50 * 1.05}
    )


def test_roundtrip_and_growth(tmp_path):
    out = write_artifact(tmp_path / "a", _manifest(), _county(), _hourly())
    assert {p.name for p in out.iterdir()} == {MANIFEST_FILE, COUNTY_FILE, HOURLY_FILE}
    art = read_artifact(out)
    assert art.county["geoid"].dtype == "string" and art.county["geoid"].iloc[0] == "06019"  # leading zero kept
    kern = art.county_year("mid", 2035).set_index("county").loc["Kern"]
    assert kern["annual_energy_mwh"] == pytest.approx(1e6 * 0.04 * 10 * 1.3, rel=1e-6)  # two regions summed
    g = art.growth("mid", 2035).set_index("county")
    assert g.loc["Fresno", "annual_energy_mwh_growth"] == pytest.approx(1e6 * 0.06 * 10 * 0.3, rel=1e-6)
    assert len(art.hourly) == 8760


def test_baseline_artifact_needs_only_base_year(tmp_path):
    m = _manifest(kind="baseline", years=(2024,), scenarios=("base",))
    art = read_artifact(write_artifact(tmp_path / "b", m, _county(rows=(("base", 2024, 1.0),))))
    assert art.hourly is None and art.manifest.kind == "baseline"
    with pytest.raises(ArtifactError, match="base year only"):
        write_artifact(tmp_path / "c", _manifest(kind="baseline"), _county())


@pytest.mark.parametrize(
    "mutate, message",
    [
        (lambda c: c.drop(columns="peak_mw_p90"), "missing columns"),
        (lambda c: c.assign(region="VEA"), "unknown regions"),
        (lambda c: c.assign(peak_mw_p90=c["peak_mw_p50"] * 0.5), "below peak_mw_p50"),
        (lambda c: c.assign(annual_energy_mwh=-1.0), ">= 0"),
        (lambda c: pd.concat([c, c.iloc[:1]]), "duplicate"),
        (lambda c: c.assign(geoid=["6029"] + c["geoid"].iloc[1:].tolist()), "5-digit"),
        (lambda c: c.replace({"scenario": {"base": "low"}}), "scenarios"),
    ],
)
def test_rejects_contract_violations(tmp_path, mutate, message):
    with pytest.raises(ArtifactError, match=message):
        write_artifact(tmp_path / "x", _manifest(), mutate(_county()))
    assert not (tmp_path / "x").exists()  # nothing partial left behind


def test_rejects_bad_hourly(tmp_path):
    with pytest.raises(ArtifactError, match="hours 0..8759"):
        write_artifact(tmp_path / "h", _manifest(), _county(), _hourly().iloc[:-1])
    bad = _hourly()
    bad["demand_mw_p10"] = bad["demand_mw_p90"] * 2
    with pytest.raises(ArtifactError, match="quantiles"):
        write_artifact(tmp_path / "h", _manifest(), _county(), bad)


def test_rejects_incompatible_schema(tmp_path):
    out = write_artifact(tmp_path / "s", _manifest(), _county())
    m = json.loads((out / MANIFEST_FILE).read_text())
    m["schema_version"] = "2.0"
    (out / MANIFEST_FILE).write_text(json.dumps(m))
    with pytest.raises(ArtifactError, match="incompatible"):
        read_artifact(out)
