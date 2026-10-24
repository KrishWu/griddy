"""Griddy API.  SHARED (foundation): every workstream's router is already
registered here, so feature branches should not need to edit this file.

Run:  backend/.venv/bin/uvicorn app.main:app --reload --port 8000  (from backend/)
"""

from fastapi import FastAPI

from app.builder.router import router as builder_router
from app.contract import SCHEMA_VERSION, Scenario, ScenarioResult
from app.evaluate.router import router as evaluate_router
from app.explore.router import router as explore_router
from app.pipeline import run_scenario
from app.simulate.router import router as simulate_router
from app.site_intel.router import router as site_intel_router

app = FastAPI(title="Griddy API", version=SCHEMA_VERSION)

for r in (explore_router, simulate_router, evaluate_router, builder_router, site_intel_router):
    app.include_router(r)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "schema_version": SCHEMA_VERSION}


@app.post("/api/run", response_model=ScenarioResult)
def run(scenario: Scenario) -> ScenarioResult:
    return run_scenario(scenario)


@app.post("/api/compare", response_model=list[ScenarioResult])
def compare(scenarios: list[Scenario]) -> list[ScenarioResult]:
    return [run_scenario(s) for s in scenarios]
