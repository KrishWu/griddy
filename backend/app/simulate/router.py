"""Simulate + stress-test endpoints.  OWNER: workstream B."""

from fastapi import APIRouter
from pydantic import BaseModel

from app.contract import Finding, Scenario, SimulationResult
from app.evaluate.catalog import get_catalog
from app.simulate.engine import simulate
from app.simulate.stress import stress_test

router = APIRouter(prefix="/api", tags=["simulate"])


class StressRequest(BaseModel):
    scenario: Scenario
    simulation: SimulationResult


@router.post("/simulate", response_model=SimulationResult)
def run_simulation(scenario: Scenario) -> SimulationResult:
    return simulate(scenario, get_catalog())


@router.post("/stress", response_model=list[Finding])
def run_stress(req: StressRequest) -> list[Finding]:
    return stress_test(req.scenario, req.simulation)
