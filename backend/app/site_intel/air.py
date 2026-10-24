"""Air quality near the site: AirNow AQI, EPA nonattainment status, AIR_PERMIT_RISK.  OWNER: workstream E.

air_context(loc): the current AQI from the AirNow API when AIRNOW_API_KEY is set (cached
1 h per site: the key allows ~500 requests/hour), else the nearest monitor in the
committed AirNow snapshot; plus every EPA Green Book nonattainment area containing the
site. Never raises. Both data files are built by prep/air.py.

air_permit_risk(...) runs on every /api/run from committed data only (no network).
"""

from __future__ import annotations

import json
import logging
import math
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

import httpx
from pydantic import BaseModel, Field

from app.contract import EvaluationResult, Finding, LngLat, Provenance, Scenario, SimulationResult
from app.site_intel.config import CACHE, DATA, env, site_key
from app.site_intel.geo import haversine_km, point_in_geometry

log = logging.getLogger(__name__)

NONATTAINMENT = DATA / "nonattainment_ca.geojson"
SNAPSHOT = DATA / "airnow_snapshot.json"
AIRNOW_CACHE = CACHE / "airnow"
AIRNOW_URL = "https://www.airnowapi.org/aq/observation/latLong/current/"
LIVE_TIMEOUT_S = 6.0
LIVE_TTL_S = 3600
SEARCH_KM = 75  # AirNow's own lat/lon search uses a miles radius; ~75 km covers one air basin's monitors

# EPA AQI categories (upper bound of each band).
AQI_CATEGORIES = [(50, "Good"), (100, "Moderate"), (150, "Unhealthy for Sensitive Groups"), (200, "Unhealthy"), (300, "Very Unhealthy")]
# Clean Air Act major-source thresholds for NOx, in short tons/yr: ozone areas by class
# (CAA 182(c)-(e), applied to NOx by 182(f); Marginal/Moderate use the general 100 tpy),
# PM2.5 areas (precursors incl. NOx: 100 tpy Moderate, 70 tpy Serious under CAA 189(b)(3)).
OZONE_NOX_TPY = {"Marginal": 100, "Moderate": 100, "Serious": 50, "Severe": 25, "Extreme": 10}
PM25_NOX_TPY = {"Moderate": 100, "Serious": 70}
SHORT_TON_T = 0.90718474
GAS_KINDS = ("gas_cc", "gas_ct")

AIRNOW_PROV_URL = "https://www.airnow.gov/"
GREENBOOK_URL = "https://www.epa.gov/green-book"


class AirContext(BaseModel):
    aqi: int | None = None
    pollutant: str | None = None
    category: str | None = None
    reporting_area: str | None = None
    monitor: str | None = None
    observed_at: str | None = Field(default=None, description="ISO timestamp of the observation")
    distance_km: float | None = None
    source: Literal["airnow_live", "airnow_snapshot"] | None = None
    nonattainment: list[dict[str, Any]] = Field(default_factory=list, description="[{pollutant, naaqs, area, classification}]")
    provenance: list[Provenance] = Field(default_factory=list)


def aqi_category(aqi: int) -> str:
    return next((name for top, name in AQI_CATEGORIES if aqi <= top), "Hazardous")


# ---------------------------------------------------------------------------
# Committed data (re-read when the file changes)
# ---------------------------------------------------------------------------

_files_lock = threading.Lock()
_files: dict[Path, tuple[int, Any]] = {}


def _load(path: Path) -> Any | None:
    try:
        stamp = path.stat().st_mtime_ns
    except OSError:
        return None
    with _files_lock:
        if path in _files and _files[path][0] == stamp:
            return _files[path][1]
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            log.warning("unreadable %s: %s", path.name, exc)
            data = None
        _files[path] = (stamp, data)
        return data


def nonattainment_at(loc: LngLat) -> list[dict[str, Any]]:
    """Every current ozone / PM2.5 nonattainment area containing the point (EPA Green Book)."""
    fc = _load(NONATTAINMENT) or {}
    out = []
    for f in fc.get("features", []):
        try:
            if point_in_geometry(loc, f["geometry"]):
                p = f["properties"]
                out.append({k: p.get(k) for k in ("pollutant", "naaqs", "area", "classification")})
        except (KeyError, TypeError, IndexError):
            continue
    return out


def _greenbook_prov() -> Provenance:
    date = (_load(NONATTAINMENT) or {}).get("report_date")
    return Provenance(kind="observed", source="EPA Green Book nonattainment areas", url=GREENBOOK_URL, note=f"EPA report date {date}" if date else None)


# ---------------------------------------------------------------------------
# AQI: live AirNow API, else the committed snapshot
# ---------------------------------------------------------------------------

_TZ = {"PST": -8, "PDT": -7, "MST": -7, "MDT": -6, "CST": -6, "CDT": -5, "EST": -5, "EDT": -4}


def _live_aqi(loc: LngLat, key: str) -> dict[str, Any] | None:
    cache = AIRNOW_CACHE / f"{site_key(loc).replace(',', '_')}.json"
    try:
        if time.time() - cache.stat().st_mtime < LIVE_TTL_S:
            return json.loads(cache.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    params = {"format": "application/json", "latitude": f"{loc.lat:.4f}", "longitude": f"{loc.lon:.4f}", "distance": int(SEARCH_KM / 1.609), "API_KEY": key}  # miles
    r = httpx.get(AIRNOW_URL, params=params, timeout=LIVE_TIMEOUT_S)
    r.raise_for_status()
    obs = [o for o in r.json() if isinstance(o.get("AQI"), (int, float)) and o["AQI"] >= 0]
    if not obs:
        return None
    o = max(obs, key=lambda o: o["AQI"])
    offset = timezone(timedelta(hours=_TZ.get(str(o.get("LocalTimeZone")), -8)))
    observed = datetime.strptime(f"{o['DateObserved'].strip()} {int(o['HourObserved']):02d}", "%Y-%m-%d %H").replace(tzinfo=offset)
    out = {
        "aqi": int(o["AQI"]),
        "pollutant": o.get("ParameterName"),
        "category": (o.get("Category") or {}).get("Name") or aqi_category(int(o["AQI"])),
        "reporting_area": o.get("ReportingArea"),
        "observed_at": observed.isoformat(timespec="minutes"),
        "distance_km": round(haversine_km(loc, LngLat(lon=o["Longitude"], lat=o["Latitude"])), 1),
    }
    try:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(out), encoding="utf-8")  # the response only, never the key
    except OSError:
        pass
    return out


def _snapshot_aqi(loc: LngLat) -> dict[str, Any] | None:
    """Like AirNow's reporting-area AQI: nearest monitor per pollutant within SEARCH_KM, then the worst pollutant."""
    snap = _load(SNAPSHOT) or {}
    best: dict[str, tuple[float, dict[str, Any]]] = {}
    for m in snap.get("monitors", []):
        try:
            d = haversine_km(loc, LngLat(lon=m["lon"], lat=m["lat"]))
        except (KeyError, TypeError, ValueError):
            continue
        if d > SEARCH_KM:
            continue
        for pol, v in (m.get("aqi") or {}).items():
            if isinstance(v, (int, float)) and v >= 0 and (pol not in best or d < best[pol][0]):
                best[pol] = (d, m)
    if not best:
        return None
    pol, (d, m) = max(best.items(), key=lambda kv: kv[1][1]["aqi"][kv[0]])
    aqi = int(m["aqi"][pol])
    return {
        "aqi": aqi,
        "pollutant": pol,
        "category": aqi_category(aqi),
        "reporting_area": m.get("reporting_area"),
        "monitor": m.get("site_name"),
        "observed_at": m.get("valid_utc"),
        "distance_km": round(d, 1),
        "captured_utc": snap.get("captured_utc"),
    }


def _pst(iso: str | None) -> str:
    """'2026-10-24T05:00Z' -> 'Oct 23 21:00 PST' (the app's fixed UTC-8 clock)."""
    try:
        return datetime.fromisoformat(str(iso)).astimezone(timezone(timedelta(hours=-8))).strftime("%b %d %H:%M PST")
    except ValueError:
        return str(iso)


def air_context(loc: LngLat) -> AirContext:
    """AQI + nonattainment for the site. Never raises."""
    ctx = AirContext()
    try:
        ctx.nonattainment = nonattainment_at(loc)
        ctx.provenance.append(_greenbook_prov())
    except Exception:  # noqa: BLE001
        log.exception("nonattainment lookup failed")
    obs, source = None, None
    if key := env("AIRNOW_API_KEY"):
        try:
            obs, source = _live_aqi(loc, key), "airnow_live"
        except Exception as exc:  # noqa: BLE001 - network, quota, malformed JSON: fall back to the snapshot
            log.warning("AirNow API unavailable, using the snapshot: %s", type(exc).__name__)
    if obs is None:
        try:
            obs, source = _snapshot_aqi(loc), "airnow_snapshot"
        except Exception:  # noqa: BLE001
            log.exception("AirNow snapshot unreadable")
    if obs is not None:
        for k in ("aqi", "pollutant", "category", "reporting_area", "monitor", "observed_at", "distance_km"):
            setattr(ctx, k, obs.get(k))
        ctx.source = source  # type: ignore[assignment]
        where = f"{obs.get('monitor') or obs.get('reporting_area') or 'nearest monitor'}, {obs.get('distance_km')} km away"
        note = f"live current observation ({where})" if source == "airnow_live" else f"snapshot of {_pst(obs.get('observed_at'))} ({where})"
        ctx.provenance.append(Provenance(kind="observed", source="AirNow (U.S. EPA and partners), preliminary data", url=AIRNOW_PROV_URL, note=note))
    return ctx


def air_quality_dict(ctx: AirContext) -> dict[str, Any] | None:
    """The SiteIntel.air_quality payload."""
    if ctx.aqi is None:
        return None
    return ctx.model_dump(include={"aqi", "pollutant", "category", "reporting_area", "monitor", "observed_at", "distance_km", "source"})


# ---------------------------------------------------------------------------
# Findings
# ---------------------------------------------------------------------------


def _describe(areas: list[dict[str, Any]]) -> str:
    """'San Joaquin Valley: 2015 8-hour ozone (Extreme), 2012 annual PM2.5 (Serious)'."""
    by_area: dict[str, list[str]] = {}
    for a in areas:
        label = a.get("naaqs") or a.get("pollutant") or "?"
        by_area.setdefault(str(a.get("area") or "?").removesuffix(", CA"), []).append(f"{label} ({a['classification']})" if a.get("classification") else label)
    return "; ".join(f"{area}: {', '.join(stds)}" for area, stds in by_area.items())


def air_findings(ctx: AirContext) -> list[Finding]:
    out: list[Finding] = []
    if ctx.aqi is not None:
        sev = "pass" if ctx.aqi <= 50 else "info" if ctx.aqi <= 100 else "warn"
        when = "now" if ctx.source == "airnow_live" else f"on {_pst(ctx.observed_at)} (snapshot)"
        out.append(
            Finding(
                id="air_quality",
                module="site",
                severity=sev,  # type: ignore[arg-type]
                title=f"Air quality: {ctx.category}",
                detail=f"AQI {ctx.aqi} ({ctx.pollutant}) {when} at {ctx.monitor or ctx.reporting_area}, {ctx.distance_km} km away. "
                "Current conditions only; permitting depends on attainment status.",
                metric=float(ctx.aqi),
                threshold=100.0,
            )
        )
    else:
        out.append(Finding(id="air_quality", module="site", severity="info", title="No nearby AQI", detail=f"No AirNow monitor within {SEARCH_KM} km."))
    if ctx.nonattainment:
        out.append(
            Finding(
                id="air_nonattainment",
                module="site",
                severity="warn",
                title="Federal nonattainment area",
                detail=f"{_describe(ctx.nonattainment)}. New on-site combustion (gas turbines, backup diesel generators) "
                "faces nonattainment New Source Review: lowest-achievable emission controls (LAER) and emission offsets.",
            )
        )
    else:
        out.append(Finding(id="air_nonattainment", module="site", severity="pass", title="Attainment area", detail="Not in an ozone or PM2.5 nonattainment area (EPA Green Book)."))
    return out


def _num(v: Any) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None


def nox_threshold_t(areas: list[dict[str, Any]]) -> float | None:
    """Lowest applicable major-source NOx threshold, metric t/yr."""
    tpy = []
    for a in areas:
        cls = str(a.get("classification") or "").split()[0] if a.get("classification") else ""
        table = OZONE_NOX_TPY if a.get("pollutant") == "Ozone" else PM25_NOX_TPY
        if cls in table:
            tpy.append(table[cls])
    return round(min(tpy) * SHORT_TON_T, 1) if tpy else None


def air_permit_risk(scenario: Scenario, sim: SimulationResult, evaluation: EvaluationResult) -> Finding | None:
    """AIR_PERMIT_RISK: on-site gas adds NOx in an ozone / PM2.5 nonattainment area. Committed data only."""
    areas = nonattainment_at(scenario.site.location)
    if not areas:
        return None
    extras = evaluation.extras or {}
    nox, pm25 = _num(extras.get("nox_t_per_yr")), _num(extras.get("pm25_t_per_yr"))
    gas_mwh = sum(sum(sim.hourly.generation_mw.get(k, [])) for k in GAS_KINDS)
    if (nox is None and gas_mwh <= 0) or (nox is not None and nox <= 0):
        return None
    threshold = nox_threshold_t(areas)
    if nox is None:
        emits = f"On-site gas burns fuel for {gas_mwh / 1e6:.2f} TWh/yr (NOx not yet quantified by Evaluate)"
    else:
        scr = _num(extras.get("nox_t_per_yr_scr"))  # C: the same burn with SCR controls
        emits = f"On-site gas emits ~{nox:,.0f} t NOx/yr" + (f" (~{scr:,.0f} t with SCR)" if scr is not None else "")
        emits += f" and ~{pm25:,.0f} t PM2.5/yr" if pm25 else ""
    major = nox is None or threshold is None or nox >= threshold
    if threshold is not None and nox is not None:
        emits += f", {'above' if major else 'below'} the {threshold:g} t/yr major-source NOx threshold that applies here"
    district = "the San Joaquin Valley APCD" if any("San Joaquin" in str(a.get("area")) for a in areas) else "the local air district"
    if major:
        permit = f"Expect nonattainment New Source Review with {district}: LAER-level controls and NOx emission offsets."
    else:
        permit = f"The turbines still need a permit to construct from {district}."
    return Finding(
        id="AIR_PERMIT_RISK",
        module="site",
        severity="warn",
        title="Air permit risk: gas NOx in a nonattainment area",
        detail=f"Site is in {_describe(areas)}. {emits}. {permit} NOx forms ozone and PM2.5, so on-site gas has a local air "
        "cost, not just a carbon one.",
        metric=round(nox, 1) if nox is not None else None,
        threshold=threshold,
    )
