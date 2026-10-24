"""Stream completed scenario-workflow stages without changing the shared pipeline."""
from __future__ import annotations

import json
import logging
from collections.abc import Iterator

from app.contract import Finding, Scenario, ScenarioResult
from app.evaluate.catalog import get_catalog
from app.evaluate.economics import evaluate
from app.simulate.engine import simulate
from app.simulate.stress import stress_test
from app.site_intel.service import site_findings

log = logging.getLogger(__name__)


def _event(**data) -> str:
    return json.dumps(data, separators=(",", ":")) + "\n"


def run_progress(scenario: Scenario) -> Iterator[str]:
    """Percent means completed workflow stages, not elapsed time or simulated hours."""
    try:
        yield _event(type="progress", percent=0, message="Preparing simulation data")
        catalog = get_catalog()
        yield _event(type="progress", percent=20, message="Simulating a full year")
        sim = simulate(scenario, catalog)
        yield _event(type="progress", percent=40, message="Calculating costs and carbon")
        evaluation = evaluate(scenario, sim, catalog)
        yield _event(type="progress", percent=60, message="Testing reliability")
        findings = stress_test(scenario, sim)
        yield _event(type="progress", percent=80, message="Checking site conditions")
        try:
            findings += site_findings(scenario, sim, evaluation)
        except Exception as exc:  # optional sponsor hook, matching app.pipeline
            log.exception("site_findings failed")
            findings.append(Finding(id="site_findings_error", module="site", severity="info",
                                    title="Site checks unavailable", detail=str(exc)[:200]))
        result = ScenarioResult(scenario=scenario, simulation=sim, evaluation=evaluation, findings=findings)
        # Serialize before announcing completion: a serialization failure must remain an error.
        payload = result.model_dump_json()
        yield '{"type":"result","result":' + payload + '}\n'
    except Exception:
        log.exception("scenario workflow failed")
        yield _event(type="error", message="Simulation could not finish. Please retry.")
