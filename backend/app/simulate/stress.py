"""Feasibility / stress-test screening.  OWNER: workstream B (Simulate + Stress Test).

STUB: a handful of transparent rule-based checks. Keep the signature of
stress_test() unchanged; app/pipeline.py calls it.
"""

from __future__ import annotations

from app.contract import Finding, Scenario, SimulationResult


def stress_test(scenario: Scenario, sim: SimulationResult) -> list[Finding]:
    s = sim.summary
    g = scenario.grid
    findings: list[Finding] = []

    if s.hours_unmet:
        findings.append(
            Finding(
                id="unmet_demand",
                module="stress",
                severity="fail",
                title=f"Demand not met in {s.hours_unmet} hours",
                detail=f"{s.unmet_mwh:,.0f} MWh/yr of load is unserved. Add firm capacity, storage, or import headroom.",
                metric=s.hours_unmet,
                threshold=0,
            )
        )
    else:
        findings.append(Finding(id="unmet_demand", module="stress", severity="pass", title="Demand met every hour", detail="No unserved energy in the simulated year."))

    if g.connected and g.import_limit_mw and s.peak_import_mw > 0.9 * g.import_limit_mw:
        findings.append(
            Finding(
                id="import_headroom",
                module="stress",
                severity="warn",
                title="Grid imports near the interconnection limit",
                detail=f"Peak import {s.peak_import_mw:,.0f} MW vs limit {g.import_limit_mw:,.0f} MW.",
                metric=s.peak_import_mw,
                threshold=0.9 * g.import_limit_mw,
                needs_utility_study=True,
            )
        )

    if g.connected:
        findings.append(
            Finding(
                id="interconnection_unverified",
                module="stress",
                severity="warn",
                title="Interconnection capacity not verified",
                detail="Import/export limits are user assumptions. Real capacity requires a CAISO interconnection study.",
                needs_utility_study=True,
            )
        )
    return findings
