"""Where to build: site recommendations for the website.  OWNER: workstream B (Phase 2).

Combines every slice's data, live, for any what-if:
  - demand growth to cover: workstream A's forecast(), new P90 peak per region (app/forecast);
  - where each technology fits: the site artifact from ml/site_location (per-cell suitability plus grid
    distances, LBNL queue, ERA5 resource, EPA nonattainment), via app/ml_bridge;
  - how much nameplate a MW of peak needs: solar and wind capacity credit measured from B's 2024 hourly
    capacity factors (data/simulate/sites) at CAISO's 100 highest net-load hours (data/simulate/caiso_2024_hourly.csv);
  - cost and land: C's catalog (ATB 2025 CAPEX, land per MW, gen-tie $/km) via app/evaluate/catalog;
  - what's already built: A's EIA-860 operating plants (data/explore/plants_ca.geojson). A cell's room for a
    kind is its cap minus the MW of that kind already operating in it.
Solar and wind are sized to a clean share of the new annual energy, then batteries and gas to the peak growth
left after the renewables' capacity credit. A linear program (HiGHS) places that nameplate on cells anywhere
in California at least weighted cost
(low suitability, long gen-tie, congested county queue, far from demand growth, combustion in a
nonattainment area). Need that no cell can take is reported as unmet. Screening candidates only.
"""

from __future__ import annotations

import json
import logging
from functools import lru_cache

import numpy as np
import pandas as pd
from pyproj import Transformer
from scipy.optimize import linprog
from scipy.spatial import cKDTree

from app import DATA_DIR
from app.contract import LngLat, Provenance, SiteCandidate, SiteRecommendation, SiteRequest
from app.evaluate.catalog import get_catalog
from app.forecast.service import forecast
from app.ml_bridge import latest

log = logging.getLogger(__name__)

# How new demand is covered (assumptions, all editable from the website):
#   clean_energy_share of the NEW ANNUAL ENERGY comes from solar + wind, split solar_pv : onshore_wind;
#   the NEW PEAK left after their capacity credit comes from firm resources, split battery : gas_cc.
DEFAULT_MIX: dict[str, float] = {"clean_energy_share": 0.8, "solar_pv": 0.75, "onshore_wind": 0.25, "battery": 0.7, "gas_cc": 0.3}
RENEWABLE, FIRM = ("solar_pv", "onshore_wind"), ("battery", "gas_cc")
DEFAULT_WEIGHTS = {"suitability": 1.0, "grid": 0.5, "queue": 0.3, "growth": 0.3, "air": 0.5}
FIXED_CREDIT = {"battery": 0.9, "gas_cc": 0.95}  # assumptions: 4 h storage at today's penetration; gas forced-outage rate
BATTERY_HOURS = 4.0
LAND_SHARE = {"solar_pv": 0.2, "onshore_wind": 1.0, "battery": 0.01, "gas_cc": 0.01}  # share of a cell's land one project may use
HARD_CAP_MW = {"solar_pv": 400.0, "onshore_wind": 300.0, "battery": 500.0, "gas_cc": 1000.0}  # one large project per cell
ACRES_PER_KM2 = 247.105
CANDIDATES_PER_KIND = 600
UNMET_PENALTY = 100.0  # per MW: above any cell's cost, so unmet appears only when cells run out
TOP_HOURS = 100
MAX_SITES_RETURNED = 300

KIND_LABEL = {"solar_pv": "solar", "onshore_wind": "wind", "battery": "battery", "gas_cc": "gas"}
PLANT_FUEL = {"solar_pv": "solar", "onshore_wind": "wind", "battery": "battery", "gas_cc": "gas"}  # fuel_mix keys in A's plants layer
TO_ALBERS = Transformer.from_crs(4326, 3310, always_xy=True).transform  # the site grid's CRS (ml/site_location)
CAVEATS = [
    "Screening candidates, not buildable sites: land ownership, zoning, habitat and interconnection capacity need site studies and a utility study.",
    "Suitability means a cell looks like places where plants of that kind were built (grid access, resource, people, air quality).",
    "The technology mix and ranking weights are assumptions you can change.",
]


@lru_cache(maxsize=4)
def _load_site_artifact(path: str, mtime: float):
    from ml.contract.site_artifact import read_site_artifact

    return read_site_artifact(path)


def _site_artifact():
    path = latest("site_location", "LATEST")
    if path is None:
        return None
    try:
        return _load_site_artifact(str(path), (path / "manifest.json").stat().st_mtime)
    except Exception:  # noqa: BLE001 - a broken artifact must not take the page down
        log.exception("site artifact %s is unreadable", path)
        return None


START_SITE_KEYS = {"37.43_-122.17"}  # baked for the website's start (Stanford), not a representative build site


def _build_sites() -> list[dict]:
    """B's baked site profiles that stand for where generation gets built (the start site excluded)."""
    index = json.loads((DATA_DIR / "simulate" / "sites" / "index.json").read_text(encoding="utf-8"))
    return [s for s in index if s.get("key") not in START_SITE_KEYS]


@lru_cache(maxsize=1)
def capacity_credit() -> dict[str, float]:
    """Share of nameplate available at the system peak, per kind. Solar and wind are measured from B's 2024
    capacity factors at CAISO's 100 highest net-load hours (load minus solar and wind, when the system is
    tightest); battery and gas are stated assumptions."""
    credit = dict(FIXED_CREDIT)
    try:
        caiso = pd.read_csv(DATA_DIR / "simulate" / "caiso_2024_hourly.csv")
        supply = caiso[[c for c in caiso.columns if c.endswith("_mw")]].clip(lower=0).sum(axis=1)  # served-load proxy
        net = supply - caiso["solar_mw"].clip(lower=0) - caiso["wind_mw"].clip(lower=0)  # what firm capacity must cover
        top = np.argsort(-net.to_numpy())[:TOP_HOURS]
        solar, wind = [], []
        for site in _build_sites():
            prof = pd.read_csv(DATA_DIR / "simulate" / "sites" / site["file"])
            solar.append(prof["solar_cf"].to_numpy()[top].mean())
            wind.append(prof["wind_cf"].to_numpy()[top].mean())
        credit["solar_pv"] = float(np.clip(np.mean(solar), 0.02, 1.0))
        credit["onshore_wind"] = float(np.clip(np.mean(wind), 0.02, 1.0))
    except (OSError, KeyError, ValueError, json.JSONDecodeError):
        log.exception("capacity credit from data/simulate failed; using defaults")
        credit.setdefault("solar_pv", 0.1)
        credit.setdefault("onshore_wind", 0.15)
    return credit


@lru_cache(maxsize=1)
def annual_cf() -> dict[str, float]:
    """Annual capacity factors from B's 2024 site profiles: mean solar (AC) over the sites, and the best
    wind site's (wind gets built where it blows)."""
    try:
        index = _build_sites()
        return {"solar_pv": float(np.mean([x["solar_cf"] for x in index])), "onshore_wind": float(max(x["wind_cf"] for x in index))}
    except (OSError, KeyError, ValueError, json.JSONDecodeError):
        log.exception("capacity factors from data/simulate failed; using catalog values")
        specs = _specs()
        return {k: float(specs[k].typical_capacity_factor or 0.25) for k in RENEWABLE if k in specs}


def nameplate_need(fc, mix: dict[str, float], credit: dict[str, float], cf: dict[str, float]) -> tuple[dict[str, float], dict[str, dict[str, float]]]:
    """Statewide nameplate MW per kind to cover the forecast growth, plus the per-region breakdown."""
    clean = float(np.clip(mix.get("clean_energy_share", DEFAULT_MIX["clean_energy_share"]), 0, 1))
    ren = {k: mix[k] for k in RENEWABLE if mix.get(k, 0) > 0}
    firm = {k: mix[k] for k in FIRM if mix.get(k, 0) > 0}
    hours = 8784 if fc.year % 4 == 0 else 8760
    by_region: dict[str, dict[str, float]] = {}
    for r in fc.regions:
        e_new = max(r.energy_mwh - r.base_energy_mwh, 0.0)
        p_new = max(r.growth_peak_mw_p90, 0.0)
        mw = {k: e_new * clean * share / sum(ren.values()) / (hours * cf[k]) for k, share in ren.items()}
        firm_left = max(p_new - sum(mw[k] * credit.get(k, 0.0) for k in mw), 0.0)
        mw.update({k: firm_left * share / sum(firm.values()) / credit.get(k, 1.0) for k, share in firm.items()})
        by_region[r.region] = mw
    total = {k: sum(m.get(k, 0.0) for m in by_region.values()) for k in (*ren, *firm)}
    return total, by_region


def _specs() -> dict:
    return {t.kind: t for t in get_catalog().techs}


def cell_cap_mw(kind: str, spacing_km: float) -> float:
    """Most MW of a kind one cell can hold: land per MW from C's catalog, capped at one large project."""
    spec = _specs().get(kind)
    acres = spacing_km**2 * ACRES_PER_KM2 * LAND_SHARE[kind]
    area_cap = acres / spec.land_acres_per_mw if spec and spec.land_acres_per_mw > 0 else HARD_CAP_MW[kind]
    return float(min(area_cap, HARD_CAP_MW[kind]))


@lru_cache(maxsize=1)
def _operating_plants() -> pd.DataFrame:
    """A's EIA-860 operating plants: Albers x, y (m) and MW per kind. MW come from each plant's fuel mix, so a
    solar + storage hybrid counts its battery too."""
    rows = []
    try:
        for f in json.loads((DATA_DIR / "explore" / "plants_ca.geojson").read_text(encoding="utf-8"))["features"]:
            p = f["properties"]
            if not f.get("geometry") or p.get("status", "operating") != "operating":
                continue
            mix = p.get("fuel_mix") or {p["fuel"]: p["capacity_mw"]}
            rows.append([*f["geometry"]["coordinates"][:2], *(float(mix.get(fuel, 0.0)) for fuel in PLANT_FUEL.values())])
    except (OSError, KeyError, ValueError, json.JSONDecodeError):
        log.exception("operating plants from data/explore failed; cells keep their full room")
        rows = []
    plants = pd.DataFrame(rows, columns=["lon", "lat", *PLANT_FUEL], dtype=float)
    plants["x"], plants["y"] = TO_ALBERS(plants["lon"].to_numpy(), plants["lat"].to_numpy())
    return plants


def existing_mw(cand: pd.DataFrame, spacing_km: float) -> pd.DataFrame:
    """MW of each kind already operating in each candidate cell (the spacing_km square around its centre on the
    Albers grid), one column per kind, aligned with cand's rows."""
    plants = _operating_plants()
    out = pd.DataFrame(0.0, index=cand.index, columns=list(PLANT_FUEL))
    if plants.empty or cand.empty:
        return out
    cx, cy = TO_ALBERS(cand["lon"].to_numpy(), cand["lat"].to_numpy())
    # Chebyshev distance within half a spacing = inside that cell's square (+1 m for the rounded centres);
    # a plant in a cell the artifact doesn't list matches nothing.
    d, i = cKDTree(np.c_[cx, cy]).query(plants[["x", "y"]].to_numpy(), p=np.inf, distance_upper_bound=spacing_km * 500.0 + 1.0)
    hit = np.isfinite(d)
    for kind in PLANT_FUEL:
        out[kind] = np.bincount(i[hit], weights=plants[kind].to_numpy()[hit], minlength=len(cand))
    return out


def capex_usd(kind: str, mw: float) -> float | None:
    spec = _specs().get(kind)
    if spec is None:
        return None
    usd = spec.capex_usd_per_kw * mw * 1000.0
    if kind == "battery" and spec.capex_usd_per_kwh:
        usd += spec.capex_usd_per_kwh * mw * BATTERY_HOURS * 1000.0
    return round(float(usd), 0)


def _norm(v: np.ndarray) -> np.ndarray:
    hi = float(np.nanmax(v)) if len(v) else 0.0
    return v / hi if hi > 0 else np.zeros_like(v, dtype=float)


def candidates(cand: pd.DataFrame, kinds: list[str], w: dict[str, float], caps: dict[str, float], built: pd.DataFrame) -> pd.DataFrame:
    """One row per (cell, kind) with its weighted cost and room (cap_mw: caps[kind] minus the kind's MW already
    operating in the cell, from built); the cheapest CANDIDATES_PER_KIND per kind that still have room, anywhere in
    California (small regions like LADWP have little land of their own; the growth term keeps sites near load)."""
    grid = np.minimum(cand["d_line_hv_km"].to_numpy(), 100.0) / 100.0
    queue = _norm(cand["queue_mw"].to_numpy())
    growth = 1.0 - _norm(cand["growth_150km_gwh"].to_numpy())
    rows = []
    for kind in kinds:
        p = cand[f"p_{kind}"].to_numpy()
        air = cand["in_nonattainment"].to_numpy() if kind == "gas_cc" else 0.0
        cost = w["suitability"] * (1 - p) + w["grid"] * grid + w["queue"] * queue + w["growth"] * growth + w["air"] * air
        have = built[kind].to_numpy()
        room = np.maximum(caps[kind] - have, 0.0)
        rows.append(cand.assign(kind=kind, suitability=p, cost=cost, existing_mw=have, cap_mw=room)[room > 0.5])
    out = pd.concat(rows, ignore_index=True)
    return out.sort_values("cost").groupby("kind", group_keys=False).head(CANDIDATES_PER_KIND).reset_index(drop=True)


def solve(cand: pd.DataFrame, need: dict[str, float]) -> tuple[pd.DataFrame, dict[str, float]]:
    """Place need[kind] MW on candidate cells (each up to its cap_mw) at least total cost; returns (allocations,
    unmet MW per kind)."""
    keys = [k for k, v in need.items() if v > 0.5]
    n, m = len(cand), len(keys)
    if m == 0:
        return cand.iloc[0:0].assign(mw=pd.Series(dtype=float)), {}
    c = np.r_[cand["cost"].to_numpy(), np.full(m, UNMET_PENALTY)]
    A = np.zeros((m, n + m))
    kind = cand["kind"].to_numpy()
    for j, k in enumerate(keys):
        A[j, :n] = -(kind == k).astype(float)
        A[j, n + j] = -1.0
    b = -np.array([need[k] for k in keys])
    bounds = [(0.0, cap) for cap in cand["cap_mw"].to_numpy()] + [(0.0, None)] * m
    res = linprog(c, A_ub=A, b_ub=b, bounds=bounds, method="highs")
    if res.status != 0:
        raise RuntimeError(f"site selection failed: {res.message}")
    alloc = cand.assign(mw=res.x[:n])
    return alloc[alloc["mw"] > 0.5].reset_index(drop=True), {k: float(res.x[n + j]) for j, k in enumerate(keys)}


def _reason(r, label: str, learned: bool) -> str:
    score = f"{r.suitability:.0%} match with where {label} plants are built" if learned else f"screening score {r.suitability:.0%} for {label}"
    parts = [score, f"{r.d_line_hv_km:.1f} km to a 220 kV+ line"]
    if label == "solar":
        parts.append(f"{r.ghi_kwh_m2_day:.1f} kWh/m²/day of sun")
    if label == "wind":
        parts.append(f"{r.wind100_ms:.1f} m/s wind at 100 m")
    if r.queue_mw > 0:
        parts.append(f"{r.queue_mw / 1000:.1f} GW already queued in {r.county} County")
    if r.growth_150km_gwh > 0:
        parts.append(f"{r.growth_150km_gwh:,.0f} GWh/yr of new demand within 150 km")
    if label == "gas" and r.in_nonattainment:
        parts.append("inside an air-quality nonattainment area (permit risk)")
    if r.existing_mw > 0.5:
        parts.append(f"{r.existing_mw:,.0f} MW of {label} already operating in this cell, so it has room for {r.cap_mw:,.0f} MW more")
    return "; ".join(parts)


def recommend(req: SiteRequest) -> SiteRecommendation:
    fc = forecast(req.forecast)
    art = _site_artifact()
    if not fc.available or art is None:
        return SiteRecommendation(
            available=False, mode="unavailable", scenario=req.forecast.scenario, year=req.forecast.year, caveats=["Site recommendations aren't available right now."]
        )

    mix = {**DEFAULT_MIX, **(req.mix or {})}
    mix = {k: float(v) for k, v in mix.items() if (k in art.manifest.kinds and v > 0) or k == "clean_energy_share"}
    weights = {**DEFAULT_WEIGHTS, **(req.weights or {})}
    credit, cf = capacity_credit(), annual_cf()
    need, need_by_region = nameplate_need(fc, mix, credit, cf)
    kinds = [k for k in need if need[k] > 0.5]
    caps = {k: cell_cap_mw(k, art.manifest.grid_spacing_km) for k in kinds}
    if kinds:
        built = existing_mw(art.candidates, art.manifest.grid_spacing_km)
        alloc, unmet = solve(candidates(art.candidates, kinds, weights, caps, built), {k: need[k] for k in kinds})
    else:
        alloc, unmet = art.candidates.iloc[0:0].assign(mw=pd.Series(dtype=float), kind=pd.Series(dtype=str), suitability=pd.Series(dtype=float)), {}

    cat = get_catalog()
    alloc = alloc.sort_values("mw", ascending=False)
    sites = [
        SiteCandidate(
            id=f"site-{r.kind}-{r.cell}",
            kind=r.kind,
            mw=round(float(r.mw), 1),
            location=LngLat(lon=float(r.lon), lat=float(r.lat)),
            county=r.county,
            region=r.region,
            suitability=round(float(r.suitability), 3),
            d_line_hv_km=round(float(r.d_line_hv_km), 2),
            d_sub_hv_km=round(float(r.d_sub_hv_km), 2),
            queue_mw=round(float(r.queue_mw), 1),
            growth_150km_gwh=round(float(r.growth_150km_gwh), 1),
            in_nonattainment=bool(r.in_nonattainment),
            capex_usd=capex_usd(r.kind, float(r.mw)),
            gen_tie_usd=round(float(r.d_line_hv_km) * cat.transmission.line_usd_per_km, 0),
            reason=_reason(r, KIND_LABEL[r.kind], art.manifest.mode == "model"),
        )
        for r in alloc.head(MAX_SITES_RETURNED).itertuples(index=False)
    ]

    provenance = [Provenance(kind="simulated", source=f"Demand growth: Griddy demand forecast ({fc.scenario}, {fc.year})", note="New P90 peak per region")]
    for item in art.manifest.provenance:
        try:
            provenance.append(Provenance.model_validate(item))
        except Exception:  # noqa: BLE001 - skip anything that doesn't fit the contract
            continue
    learned = art.manifest.mode == "model"
    provenance.append(
        Provenance(
            kind="inferred" if learned else "assumption",
            source="Site suitability learned from where EIA-860 plants were built" if learned else "Site suitability: screening score (grid access, resource, people, air quality, demand)",
        )
    )
    provenance.append(Provenance(kind="observed", source="Solar/wind capacity credit: 2024 hourly capacity factors at CAISO's 100 highest net-load hours"))
    provenance += [spec.provenance for spec in cat.techs if spec.kind in mix] + [cat.transmission.provenance]

    alloc_mw = alloc.groupby(["region", "kind"])["mw"].sum()
    return SiteRecommendation(
        available=True,
        mode=art.manifest.mode,
        artifact_id=art.manifest.artifact_id,
        scenario=fc.scenario,
        year=fc.year,
        need_mw_by_region={r.region: round(max(r.growth_peak_mw_p90, 0.0), 1) for r in fc.regions},
        nameplate_need_mw={**{k: round(v, 1) for k, v in need.items() if v > 0.5}, **{f"{r}/{k}": round(v, 1) for r, m in need_by_region.items() for k, v in m.items() if v > 0.5}},
        allocated_mw={**{k: round(float(v), 1) for k, v in alloc.groupby("kind")["mw"].sum().items()}, **{f"{r}/{k}": round(float(v), 1) for (r, k), v in alloc_mw.items()}},
        unmet_mw={k: round(v, 1) for k, v in unmet.items() if v > 0.5},
        capacity_credit={k: round(v, 3) for k, v in credit.items() if k in mix},
        sites=sites,
        total_capex_usd=round(sum((s.capex_usd or 0.0) + (s.gen_tie_usd or 0.0) for s in sites), 0),
        model_metrics=art.manifest.model_metrics,
        provenance=provenance,
        caveats=CAVEATS,
        extras={"mix": mix, "weights": weights, "annual_capacity_factor": {k: round(v, 3) for k, v in cf.items()}, "sites_total": int(len(alloc)), "cell_cap_mw": caps},
    )


def clear_caches() -> None:
    _load_site_artifact.cache_clear()
    capacity_credit.cache_clear()
    annual_cf.cache_clear()
    _operating_plants.cache_clear()
