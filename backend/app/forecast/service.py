"""Demand forecast for the website.  OWNER: workstream A (Phase 2).

STUB: reports "unavailable" until workstream A serves ml/artifacts/demand_forecast (see
ml/README.md). Keep the signature: workstream B's site recommendations call forecast().
"""

from __future__ import annotations

from app.contract import DemandForecast, ForecastRequest


def forecast(req: ForecastRequest) -> DemandForecast:
    return DemandForecast(
        available=False,
        mode="unavailable",
        scenario=req.scenario,
        year=req.year,
        notes=["Demand forecast not wired up yet (workstream A, Phase 2)."],
    )
