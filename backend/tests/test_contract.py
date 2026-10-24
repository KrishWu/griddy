"""Contract + integration tests every branch must keep green.  SHARED (foundation).

Run from backend/:  .venv/bin/pytest
Workstreams add their own unit tests in tests/test_<module>.py.
"""

import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.builder.service import list_presets
from app.contract import Scenario, ScenarioResult
from app.main import app
from app.pipeline import run_scenario

CONTRACTS = Path(__file__).resolve().parents[2] / "contracts"
client = TestClient(app)


def test_example_fixtures_match_contract():
    Scenario.model_validate_json((CONTRACTS / "example.scenario.json").read_text())
    ScenarioResult.model_validate_json((CONTRACTS / "example.result.json").read_text())


def test_schema_files_are_current():
    """If this fails, run: .venv/bin/python ../scripts/export_contract.py"""
    on_disk = json.loads((CONTRACTS / "scenario.schema.json").read_text())
    assert on_disk == Scenario.model_json_schema()
    on_disk = json.loads((CONTRACTS / "scenario_result.schema.json").read_text())
    assert on_disk == ScenarioResult.model_json_schema()


@pytest.mark.parametrize("preset", list_presets(), ids=lambda p: p.id)
def test_every_preset_runs_and_balances(preset: Scenario):
    result = run_scenario(preset)
    h = result.simulation.hourly
    n = len(h.demand_mw)
    assert n in (8760, 8784)
    for name in ("battery_charge_mw", "battery_discharge_mw", "imports_mw", "exports_mw", "unmet_mw", "curtailed_mw", "price_usd_per_mwh", "grid_co2_kg_per_mwh"):
        assert len(getattr(h, name)) == n, name
    for kind, series in h.generation_mw.items():
        assert len(series) == n, kind

    # demand = generation + discharge + imports + unmet - charge - exports - curtailed, every hour
    gen = np.sum([np.array(v) for v in h.generation_mw.values()], axis=0) if h.generation_mw else np.zeros(n)
    supply = gen + np.array(h.battery_discharge_mw) + np.array(h.imports_mw) + np.array(h.unmet_mw)
    sinks = np.array(h.battery_charge_mw) + np.array(h.exports_mw) + np.array(h.curtailed_mw)
    assert np.allclose(np.array(h.demand_mw), supply - sinks, atol=0.05)

    # Physical limits
    assert max(h.imports_mw) <= preset.grid.import_limit_mw + 1e-6
    for a in preset.assets:
        if a.kind in h.generation_mw:
            cap = sum(x.capacity_mw for x in preset.assets if x.kind == a.kind)
            assert max(h.generation_mw[a.kind]) <= cap + 1e-6

    e = result.evaluation.economics
    assert e.capex_total_usd >= 0 and e.npc_usd >= e.capex_total_usd
    assert result.evaluation.emissions.annual_t_co2e >= 0


def test_api_endpoints_respond():
    assert client.get("/api/health").json()["ok"]
    for layer in ("plants", "transmission", "substations", "boundaries"):
        assert client.get(f"/api/layers/{layer}").json()["type"] == "FeatureCollection"
    assert client.get("/api/site/summary", params={"lon": -119.4, "lat": 35.4}).status_code == 200
    assert client.get("/api/site/intel", params={"lon": -119.4, "lat": 35.4}).status_code == 200
    assert client.get("/api/catalog").status_code == 200
    presets = client.get("/api/presets").json()
    res = client.post("/api/run", json=presets[0])
    assert res.status_code == 200
    assert client.post("/api/report.csv", json=res.json()).status_code == 200
    assert len(client.post("/api/compare", json=presets).json()) == len(presets)


def _ts_interfaces() -> dict[str, dict[str, bool]]:
    """Parse frontend/lib/contract.ts into {Interface: {field: optional}}."""
    import re

    src = (Path(__file__).resolve().parents[2] / "frontend" / "lib" / "contract.ts").read_text()
    out: dict[str, dict[str, bool]] = {}
    for name, body in re.findall(r"export interface (\w+) \{(.*?)\n\}", src, re.S):
        fields = re.findall(r"^\s+(\w+)(\??):", body, re.M)
        out[name] = {f: bool(opt) for f, opt in fields}
    return out


def test_typescript_contract_mirrors_python():
    """contract.ts must declare exactly the same fields as contract.py, and every field
    Python requires must be required in TypeScript too."""
    import inspect

    from pydantic import BaseModel

    import app.contract as contract

    ts = _ts_interfaces()
    models = {
        n: m
        for n, m in inspect.getmembers(contract, inspect.isclass)
        if issubclass(m, BaseModel) and m.__module__ == contract.__name__ and n != "Model"
    }
    problems = []
    for name, model in models.items():
        if name not in ts:
            problems.append(f"{name}: missing from contract.ts")
            continue
        py = model.model_fields
        if missing := sorted(set(py) - set(ts[name])):
            problems.append(f"{name}: in contract.py but not contract.ts: {missing}")
        if extra := sorted(set(ts[name]) - set(py)):
            problems.append(f"{name}: in contract.ts but not contract.py: {extra}")
        for field, info in py.items():
            if info.is_required() and ts[name].get(field):
                problems.append(f"{name}.{field}: required in contract.py but optional (?) in contract.ts")
    assert not problems, "\n".join(problems)
