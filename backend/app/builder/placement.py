"""Where the optimizer's solar and wind MW go: B's site-model candidates.  OWNER: workstream D.

optimizer.py decides how much to build; this decides where the solar and wind go. It runs once per
optimize request (optimizer._placement() calls site_options(); any exception falls back to the campus):

1. Candidates: app.sites.service.recommend(req.site_request or SiteRequest()) once. The default
   SiteRequest is the forecast the Forecast page opens with (mid scenario, 2035).
2. Campus region. Rule: the campus county's main load region in A's demand forecast (the same
   CountyForecast.region the site model labels its cells with; Kern -> PGAE). If the scenario has no
   county, or the forecast doesn't list it, the most common region among the 5 site-model cells nearest
   the campus (a tie goes to the nearest cell's region).
3. Keep per kind (solar_pv, onshore_wind) the top 3 cells in that region with suitability >=
   req.min_suitability. "Top" = suitability rounded to 0.01 (finer differences aren't meaningful), then the
   cheaper gen-tie, then the cell nearer the campus.
4. Weather: profiles.site_weather() once per kept location (at most 6 calls, in parallel). Pre-baked and
   runtime-cached locations load from disk; the rest cost one live Open-Meteo fetch each. A location whose
   weather hasn't arrived within FETCH_BUDGET_S is skipped (its fetch may still land mid-run, so its
   profile could change under the exact run). A failed fetch gets profiles' stand-in (the nearest
   pre-baked site): profiles keeps serving that stand-in for WEATHER_RETRY_S (90 s), longer than a run,
   so the screen and the exact run see the same profile. optimizer._weather_matches() checks that on the
   winner, and the response says so either way.
5. Rank per kind by cost per MWh at each option, per MW of the candidate:
       (CRF x CAPEX + fixed O&M + CRF x gen_tie_usd / candidate MW) / annual MWh per MW  (+ variable O&M)
   with CRF from the scenario's discount rate and the catalog lifetime (the gen-tie is folded into the
   asset's CAPEX, so it shares the asset's life). The campus is always an option: unlimited, no gen-tie.
   Fill order = the options cheaper per MWh than the campus, cheapest first, then the campus; the dearer
   ones are reported under "considered" but never filled (the unlimited campus would take that MW first).

Gas and batteries stay at the campus. Site candidates are screening candidates, not buildable sites,
sized by the site model for regional growth (not for this campus), and the dispatch treats remote output
as delivered to the campus every hour, so designs with remote assets get delivery_finding() below.
"""
from __future__ import annotations

import logging
import math
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, wait
from typing import TYPE_CHECKING

import numpy as np

from app.builder.optimizer import RENEWABLE, Placement, SiteOption, _crf
from app.contract import Catalog, Finding, LngLat, Provenance, Scenario, SiteCandidate, SiteRecommendation, SiteRequest, TechSpec
from app.simulate import profiles

if TYPE_CHECKING:
    from app.builder.optimizer import OptimizeRequest
    from app.simulate.engine import Prepared

log = logging.getLogger(__name__)

TOP_PER_KIND = 3
MAX_WEATHER_CALLS = TOP_PER_KIND * len(RENEWABLE)  # 6
FETCH_BUDGET_S = 5.0  # wall time for all live weather fetches together (they run in parallel)
NEAREST_VOTE = 5  # cells that vote on the campus region when the county rule can't decide
KIND_LABEL = {"solar_pv": "Solar PV", "onshore_wind": "Onshore wind"}
CAVEAT = ("Site candidates are screening candidates, not buildable sites, sized by the site model for regional growth rather than "
          "this campus. The dispatch counts remote output as delivered to the campus every hour.")


def _km(a: LngLat, b: LngLat) -> float:
    p1, p2 = math.radians(a.lat), math.radians(b.lat)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(b.lon - a.lon) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(min(1.0, h)))


def _county(name: str | None) -> str:
    n = (name or "").strip().lower()
    return n.removesuffix(" county").strip()


# ---------------------------------------------------------------------------
# Which cells: the campus region, then the top cells per kind
# ---------------------------------------------------------------------------


def campus_region(scenario: Scenario, rec: SiteRecommendation, site_req: SiteRequest) -> tuple[str | None, str]:
    """(region, the rule that decided it). See the module docstring, step 2."""
    county = _county(scenario.site.county)
    if county:
        try:
            from app.forecast.service import forecast

            fc = forecast(site_req.forecast)  # recommend() just ran the same request, so this is cached
            for c in fc.counties:
                if _county(c.county) == county and c.region:
                    return c.region, f"{c.county} County's main load region in the demand forecast"
        except Exception:  # noqa: BLE001 - the nearest-cells vote below still decides
            log.exception("forecast county lookup failed")
    near = sorted(rec.sites, key=lambda s: _km(scenario.site.location, s.location))[:NEAREST_VOTE]
    if not near:
        return None, "no site-model cells to compare with"
    votes = Counter(s.region for s in near)
    top = max(votes.values())
    region = next(s.region for s in near if votes[s.region] == top)  # ties: the nearest cell's region
    return region, f"most common region among the {len(near)} site-model cells nearest the campus"


def pick(sites: list[SiteCandidate], kind: str, region: str | None, min_suitability: float, campus: LngLat,
         top: int = TOP_PER_KIND) -> list[SiteCandidate]:
    """The top cells of a kind in the region (module docstring, step 3)."""
    pool = [s for s in sites if s.kind == kind and s.region == region and s.mw > 0 and s.suitability >= min_suitability - 1e-12]
    pool.sort(key=lambda s: (-round(s.suitability, 2), s.gen_tie_usd or 0.0, _km(campus, s.location), s.id))
    return pool[:top]


# ---------------------------------------------------------------------------
# Weather, once per location, bounded
# ---------------------------------------------------------------------------


def load_weather(cells: list[SiteCandidate], year: int, budget_s: float | None = None) -> tuple[dict[str, profiles.SiteWeather], list[str]]:
    """profiles.site_weather() per cell (one call per 0.01-degree weather key, at most MAX_WEATHER_CALLS),
    in parallel, waiting at most budget_s (default FETCH_BUDGET_S). Returns ({cell id: weather}, notes about
    skipped or stand-in cells)."""
    budget_s = FETCH_BUDGET_S if budget_s is None else budget_s
    by_key: dict[str, list[SiteCandidate]] = {}
    for c in cells:
        by_key.setdefault(profiles.site_key(c.location.lat, c.location.lon), []).append(c)
    keys = list(by_key)[:MAX_WEATHER_CALLS]
    out: dict[str, profiles.SiteWeather] = {}
    notes: list[str] = []
    if not keys:
        return out, notes
    pool = ThreadPoolExecutor(max_workers=len(keys), thread_name_prefix="placement-weather")
    try:
        futures = {k: pool.submit(profiles.site_weather, by_key[k][0].location.lat, by_key[k][0].location.lon, year) for k in keys}
        done, _ = wait(futures.values(), timeout=budget_s)
    finally:
        pool.shutdown(wait=False, cancel_futures=True)  # a slow fetch finishes in the background and fills the cache
    for k in keys:
        names = ", ".join(c.id for c in by_key[k])
        f = futures[k]
        if f not in done:
            notes.append(f"Weather for {names} didn't arrive within {budget_s:g} s, so it isn't used (a later run will have it).")
            continue
        try:
            w = f.result()
        except Exception as exc:  # noqa: BLE001 - one location's weather must not break placement
            notes.append(f"Weather for {names} failed ({type(exc).__name__}), so it isn't used.")
            continue
        if w.source_key == "synthetic":
            notes.append(f"No weather data for {names}, so it isn't used.")
            continue
        if w.note:
            notes.append(f"{names}: {w.note}. The screen and the exact run both use that stand-in profile.")
        for c in by_key[k]:
            out[c.id] = w
    return out, notes


# ---------------------------------------------------------------------------
# Ranking
# ---------------------------------------------------------------------------


def cost_per_mwh(spec: TechSpec, discount_rate: float, cf: np.ndarray, gen_tie_usd: float = 0.0, mw: float = math.inf,
                 overrides: dict[str, float] | None = None) -> float:
    """Annualized $ per MWh at one location (module docstring, step 5); inf when it makes no energy."""
    o = overrides or {}
    life = max(1, int(round(o.get("lifetime_years", spec.lifetime_years))))
    tie_per_mw = gen_tie_usd / mw if gen_tie_usd and math.isfinite(mw) and mw > 0 else 0.0
    annual = _crf(discount_rate, life) * (1000 * o.get("capex_usd_per_kw", spec.capex_usd_per_kw) + tie_per_mw)
    annual += 1000 * o.get("fixed_om_usd_per_kw_yr", spec.fixed_om_usd_per_kw_yr)
    mwh = float(np.clip(cf, 0, 1).sum())
    return annual / mwh + o.get("var_om_usd_per_mwh", spec.var_om_usd_per_mwh) if mwh > 0 else math.inf


def _option(c: SiteCandidate, w: profiles.SiteWeather, campus: LngLat) -> SiteOption:
    kind = c.kind
    cf = w.solar_cf if kind == "solar_pv" else w.wind_cf
    label = f"{c.id}, {c.county} County" if c.county else c.id
    info = {"candidate_id": c.id, "suitability": c.suitability, "candidate_mw": c.mw, "region": c.region, "county": c.county,
            "distance_km": round(_km(campus, c.location), 1), "d_line_hv_km": c.d_line_hv_km, "queue_mw": c.queue_mw,
            "in_nonattainment": c.in_nonattainment, "annual_cf": None, "cost_usd_per_mwh": None,  # set by rank()
            "weather_site": w.source_key, "weather_stand_in": w.source_key != w.key, "reason": c.reason}
    return SiteOption(id=c.id.removeprefix(f"site-{kind}-"), kind=kind, cf=cf, max_mw=float(c.mw), location=c.location,
                      fixed_usd=float(c.gen_tie_usd or 0.0), label=label, info=info)


def rank(kind: str, spec: TechSpec, discount_rate: float, campus: SiteOption, remote: list[SiteOption]) -> tuple[list[SiteOption], list[dict]]:
    """(fill order: options cheaper per MWh than the campus, cheapest first, then the campus; rows for all of them)."""
    campus_cost = cost_per_mwh(spec, discount_rate, campus.cf)
    campus.info = {**campus.info, "annual_cf": float(np.clip(campus.cf, 0, 1).mean()), "cost_usd_per_mwh": campus_cost}
    for o in remote:
        o.info.update(annual_cf=float(np.clip(o.cf, 0, 1).mean()),
                      cost_usd_per_mwh=cost_per_mwh(spec, discount_rate, o.cf, o.fixed_usd, o.max_mw, o.overrides))
    remote = sorted(remote, key=lambda o: (o.info["cost_usd_per_mwh"], o.id))
    used = [o for o in remote if o.info["cost_usd_per_mwh"] < campus_cost - 1e-9]
    used_ids = {id(o) for o in used}  # identity: SiteOption holds arrays, so == isn't meaningful
    rows = []
    for o in [*remote, campus]:
        row = {"kind": kind, "id": o.id, "candidate_id": o.info.get("candidate_id"), "label": o.label,
               "cost_usd_per_mwh": o.info["cost_usd_per_mwh"], "annual_cf": o.info["annual_cf"],
               "max_mw": o.max_mw if math.isfinite(o.max_mw) else None, "gen_tie_usd": o.fixed_usd}
        if o is campus:
            row.update(used=True, why="the campus: unlimited, no gen-tie")
        elif id(o) in used_ids:
            row.update(used=True, why="cheaper per MWh than the campus")
        else:
            row.update(used=False, why="costs more per MWh than the campus, which has room for every MW")
        rows.append(row)
    return [*used, campus], rows


# ---------------------------------------------------------------------------
# The optimizer's hook
# ---------------------------------------------------------------------------


def _campus_only(campus: dict[str, list[SiteOption]], note: str, info: dict | None = None,
                 provenance: list[Provenance] | None = None, notes: list[str] | None = None) -> Placement:
    return Placement("campus_only", campus, [note, *(notes or [])], provenance or [], info or {})


def site_options(req: OptimizeRequest, scenario: Scenario, prep: Prepared, catalog: Catalog,
                 campus: dict[str, list[SiteOption]]) -> Placement:
    """Where each kind's MW can go, in fill order, ending with the (unbounded) campus."""
    from app.sites.service import recommend

    site_req = req.site_request or SiteRequest()
    rec = recommend(site_req)
    info = {"site_request": site_req.model_dump(mode="json"),
            "site_model": {"available": rec.available, "mode": rec.mode, "artifact_id": rec.artifact_id, "scenario": rec.scenario, "year": rec.year}}
    if not rec.available or not rec.sites:
        return _campus_only(campus, "Site recommendations aren't available right now, so every MW is placed at the campus.", info)
    region, rule = campus_region(scenario, rec, site_req)
    info.update(region=region, region_rule=rule)
    kinds = RENEWABLE if req.include_wind else ("solar_pv",)
    cells = {k: pick(rec.sites, k, region, req.min_suitability, scenario.site.location) for k in kinds}
    info["picked"] = {k: [c.id for c in v] for k, v in cells.items()}
    provenance = [Provenance(kind="inferred" if rec.mode == "model" else "assumption",
                             source=f"Remote solar/wind locations: Griddy site model ({rec.mode}, {rec.scenario} {rec.year} forecast)"
                                    + (f", artifact {rec.artifact_id}" if rec.artifact_id else ""),
                             note=f"Top {TOP_PER_KIND} cells per kind in the {region} region with suitability >= {req.min_suitability:g}; "
                                  f"region = {rule}. {CAVEAT}")]
    if not any(cells.values()):
        return _campus_only(campus, f"The site model has no solar or wind cells in the {region} region with suitability >= "
                                    f"{req.min_suitability:g}, so every MW is placed at the campus.", info, provenance)
    weather, notes = load_weather([c for v in cells.values() for c in v], scenario.assumptions.weather_year)

    r = scenario.assumptions.discount_rate
    options: dict[str, list[SiteOption]] = {}
    considered: dict[str, list[dict]] = {}
    for kind in RENEWABLE:
        home = campus[kind][-1]
        home = SiteOption(home.id, kind, home.cf, label="campus", info={"weather_site": prep.weather_site})
        remote = [_option(c, weather[c.id], scenario.site.location) for c in cells.get(kind, []) if c.id in weather]
        options[kind], considered[kind] = rank(kind, catalog.spec(kind), r, home, remote)
    info["considered"] = considered
    used = [o for opts in options.values() for o in opts if o.location is not None]
    for o in used:
        w = weather[o.info["candidate_id"]]
        provenance.append(Provenance(kind="observed", source=f"{KIND_LABEL[o.kind]} at {o.label}: weather at its own location ({w.source_key})",
                                     note=w.note or (w.provenance[0].source if w.provenance else None)))
    if not used:
        dearer = sum(1 for v in considered.values() for row in v if row["candidate_id"] and not row["used"])
        why = (f"none of the {dearer} site-model cells with weather beats the campus per MWh" if dearer
               else "no site-model cell's weather could be loaded")
        return _campus_only(campus, f"Every MW stays at the campus: {why}.", info, provenance, notes)
    summary = "; ".join(f"{KIND_LABEL[k]}: up to {sum(o.max_mw for o in opts if o.location):,.0f} MW at "
                        f"{sum(1 for o in opts if o.location)} cell(s) before the campus" for k, opts in options.items() if len(opts) > 1)
    notes = [f"Solar and wind can go at site-model cells in the {region} region ({rule}). {summary}. A cell's gen-tie is folded into "
             "the CAPEX of what is built there; gas and batteries stay at the campus.", *notes, CAVEAT]
    return Placement("site_model", options, notes, provenance, info)


def delivery_finding(scenario: Scenario) -> Finding | None:
    """The needs_utility_study finding for a design with solar or wind away from the campus (None if it has none)."""
    remote = [a for a in scenario.assets if a.kind in RENEWABLE and a.location is not None and a.capacity_mw > 0]
    if not remote:
        return None
    mw = {k: sum(a.capacity_mw for a in remote if a.kind == k) for k in RENEWABLE}
    far = max(_km(scenario.site.location, a.location) for a in remote)
    what = " and ".join(f"{v:,.0f} MW of {'solar' if k == 'solar_pv' else 'wind'}" for k, v in mw.items() if v > 0)
    return Finding(
        id="remote_generation_delivery", module="site", severity="warn",
        title="Remote solar/wind needs transmission service and a utility study",
        detail=(f"{what} sit at {len(remote)} site-model cell(s) up to {far:,.0f} km from the campus. The dispatch counts their output as "
                "delivered to the campus every hour, which needs transmission service to the campus and an interconnection study at "
                "each cell; each gen-tie is a screening estimate (distance to the nearest 220 kV+ line). Site candidates are screening "
                "candidates, not buildable sites."),
        metric=round(far, 1), needs_utility_study=True)
