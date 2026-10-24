"""Evaluate endpoints.  OWNER: workstream C."""

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from app.contract import Catalog, EvaluationResult, Scenario, SimulationResult
from app.evaluate.catalog import atb_data, get_catalog, reference_files
from app.evaluate.economics import evaluate

router = APIRouter(prefix="/api", tags=["evaluate"])

# ATB fields worth showing in the assumptions drawer (raw trajectories and per-duration rows left out).
_ATB_TECH_KEYS = ("label", "atb", "parameters", "derived", "lifetime_years", "lifetime_source", "class_rationale", "reference_unit", "pv_ilr")


class EvaluateRequest(BaseModel):
    scenario: Scenario
    simulation: SimulationResult


@router.get("/catalog", response_model=Catalog)
def catalog() -> Catalog:
    return get_catalog()


@router.post("/evaluate", response_model=EvaluationResult)
def run_evaluate(req: EvaluateRequest) -> EvaluationResult:
    return evaluate(req.scenario, req.simulation, get_catalog())


@router.get("/evaluate/assumptions")
def assumptions() -> dict[str, Any]:
    """The cited reference data behind every Evaluate number, for the UI's assumptions view."""
    atb = atb_data()
    return {
        **reference_files(),
        "atb": {
            "source": atb["source"],
            "selection": atb["selection"],
            "techs": {k: {f: t[f] for f in _ATB_TECH_KEYS if f in t} for k, t in atb["techs"].items()},
        },
    }
