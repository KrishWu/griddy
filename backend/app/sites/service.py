"""Site recommendations for the website.  OWNER: workstream B (Phase 2).

STUB: reports "unavailable" until workstream B serves ml/artifacts/site_location (see
ml/README.md). Keep the signature.
"""

from __future__ import annotations

from app.contract import SiteRecommendation, SiteRequest


def recommend(req: SiteRequest) -> SiteRecommendation:
    return SiteRecommendation(
        available=False,
        mode="unavailable",
        scenario=req.forecast.scenario,
        year=req.forecast.year,
        caveats=["Site recommendations not wired up yet (workstream B, Phase 2)."],
    )
