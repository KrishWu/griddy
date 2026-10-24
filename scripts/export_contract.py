#!/usr/bin/env python3
"""Regenerate contracts/*.json from backend/app/contract.py.

Run after changing the contract:  backend/.venv/bin/python scripts/export_contract.py
Writes JSON Schemas (for reference / codegen) and example payloads from the
"hybrid" preset, with hourly arrays cut to the first 48 hours to stay small.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from app.builder.service import list_presets  # noqa: E402
from app.contract import Scenario, ScenarioResult  # noqa: E402
from app.pipeline import run_scenario  # noqa: E402

OUT = ROOT / "contracts"
HOURS = 48


def dump(name: str, obj: object) -> None:
    (OUT / name).write_text(json.dumps(obj, indent=2) + "\n")
    print(f"wrote contracts/{name}")


def truncate(result: dict) -> dict:
    h = result["simulation"]["hourly"]
    for k, v in h.items():
        if isinstance(v, list):
            h[k] = v[:HOURS]
        elif isinstance(v, dict):
            h[k] = {kk: vv[:HOURS] for kk, vv in v.items()}
    return result


def main() -> None:
    OUT.mkdir(exist_ok=True)
    dump("scenario.schema.json", Scenario.model_json_schema())
    dump("scenario_result.schema.json", ScenarioResult.model_json_schema())
    hybrid = next(p for p in list_presets() if p.id == "hybrid")
    dump("example.scenario.json", hybrid.model_dump(mode="json"))
    dump("example.result.json", truncate(run_scenario(hybrid).model_dump(mode="json")))


if __name__ == "__main__":
    main()
