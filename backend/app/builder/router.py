"""Presets + report endpoints.  OWNER: workstream D."""

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

from app.builder.service import list_presets, report_csv
from app.contract import Scenario, ScenarioResult

router = APIRouter(prefix="/api", tags=["build"])


@router.get("/presets", response_model=list[Scenario])
def presets() -> list[Scenario]:
    return list_presets()


@router.post("/report.csv", response_class=PlainTextResponse)
def report(result: ScenarioResult) -> str:
    return report_csv(result)
