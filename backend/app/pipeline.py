"""Scenario pipeline: simulate -> evaluate -> stress test.  SHARED (foundation).

This is the only place modules are wired together. Workstreams change the
bodies of the functions called here, never these call sites, so this file
should not need edits on feature branches.
"""

from app.contract import Scenario, ScenarioResult
from app.evaluate.catalog import get_catalog
from app.evaluate.economics import evaluate
from app.simulate.engine import simulate
from app.simulate.stress import stress_test


def run_scenario(scenario: Scenario) -> ScenarioResult:
    catalog = get_catalog()
    sim = simulate(scenario, catalog)
    evaluation = evaluate(scenario, sim, catalog)
    findings = stress_test(scenario, sim)
    return ScenarioResult(scenario=scenario, simulation=sim, evaluation=evaluation, findings=findings)
