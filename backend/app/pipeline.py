"""Scenario pipeline: simulate -> evaluate -> stress test -> site findings.  SHARED (foundation).

This is the only place modules are wired together. Workstreams change the
bodies of the functions called here, never these call sites, so this file
should not need edits on feature branches.
"""

import logging

from app.contract import Finding, Scenario, ScenarioResult
from app.evaluate.catalog import get_catalog
from app.evaluate.economics import evaluate
from app.simulate.engine import simulate
from app.simulate.stress import stress_test
from app.site_intel.service import site_findings

log = logging.getLogger(__name__)


def run_scenario(scenario: Scenario) -> ScenarioResult:
    catalog = get_catalog()
    sim = simulate(scenario, catalog)
    evaluation = evaluate(scenario, sim, catalog)
    findings = stress_test(scenario, sim)
    # Optional sponsor hook (E): must never take the core result down with it.
    try:
        findings += site_findings(scenario, sim, evaluation)
    except Exception as exc:  # noqa: BLE001
        log.exception("site_findings failed")
        findings.append(
            Finding(id="site_findings_error", module="site", severity="info", title="Site checks unavailable", detail=str(exc)[:200])
        )
    return ScenarioResult(scenario=scenario, simulation=sim, evaluation=evaluation, findings=findings)
