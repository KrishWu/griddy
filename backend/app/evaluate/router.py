"""Evaluate endpoints.  OWNER: workstream C."""

from fastapi import APIRouter
from pydantic import BaseModel

from app.contract import Catalog, EvaluationResult, Scenario, SimulationResult
from app.evaluate.catalog import get_catalog
from app.evaluate.economics import evaluate

router = APIRouter(prefix="/api", tags=["evaluate"])


class EvaluateRequest(BaseModel):
    scenario: Scenario
    simulation: SimulationResult


@router.get("/catalog", response_model=Catalog)
def catalog() -> Catalog:
    return get_catalog()


@router.post("/evaluate", response_model=EvaluationResult)
def run_evaluate(req: EvaluateRequest) -> EvaluationResult:
    return evaluate(req.scenario, req.simulation, get_catalog())
