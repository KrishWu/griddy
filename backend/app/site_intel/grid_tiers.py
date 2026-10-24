"""Nearest qualifying grid assets at each voltage threshold, for the power plant GriddyGrade.  OWNER: E.

The GriddyGrade searches for interconnection assets by project size (frontend/components/site_intel/
feasibilityPolicy.ts): from 69 kV up to 20 MW, from 115 kV up to 100 MW, and from 220 kV above
that (Griddy's 220 kV+ class, which includes SCE's 220 kV system). A's site summary reports the
nearest 220 kV+ substation and line; grid_tiers(location) runs the same search at every threshold
on A's own layers and indexes (read-only), so the browser picks the tier for the configured
capacity without another request and a capacity change never refetches.

Qualifying, so nothing is assumed:
  - substation: an OpenStreetMap power=substation that A keeps (disused / abandoned ones are
    dropped when A builds the layer, so a mapped one is taken as existing), not a transition
    point, with a voltage tag >= the threshold. Untagged substations never qualify, however close:
    their voltage can't be established. The nearest untagged one is reported when it is closer.
  - line: an operational AC line with a voltage >= the threshold (A's _tappable: CEC status
    Operational, HVDC excluded).
Distances are straight-line km in EPSG:3310 to the substation point and to the line geometry
(nearest point on the segment, not the nearest stored vertex), as in A's summary.

The result goes in SiteIntel.extras["grid_tiers"]; feasibilityInput.ts reads it. No network.
"""

from __future__ import annotations

import logging
import math
from functools import lru_cache
from typing import Any

import numpy as np

from app.contract import LngLat

log = logging.getLogger(__name__)

THRESHOLDS_KV = (69, 115, 220)
TRANSITION = "transition"  # overhead-to-underground transition points, not substations (A drops them too)


@lru_cache(maxsize=1)
def _substation_kv() -> tuple[np.ndarray, np.ndarray]:
    """(voltage kV per substation, NaN when untagged; True where it may count: not a transition point)."""
    from app.explore import service as ex

    props = ex._substations().pts.props
    kv = np.array([ex._num(p.get("voltage_kv")) or np.nan for p in props], dtype=float)
    usable = np.array([p.get("substation_type") != TRANSITION for p in props], dtype=bool)
    return kv, usable


@lru_cache(maxsize=1)
def _lines_by_threshold() -> dict[int, Any]:
    """Operational AC lines at or above each threshold, reusing A's 69 kV and 220 kV indexes."""
    from app.explore import service as ex

    hv, any_line = ex._line_sets()
    out: dict[int, Any] = {}
    for kv in THRESHOLDS_KV:
        if kv == 69:
            out[kv] = any_line
        elif kv == int(ex.HV_KV):
            out[kv] = hv
        else:
            out[kv] = ex._lines(ex._collection("transmission")["features"], float(kv))
    return out


def _substation(x: float, y: float, threshold: int) -> tuple[str, dict[str, Any] | None]:
    from app.explore import service as ex

    subs = ex._substations()
    if not len(subs.pts.props):
        return "unavailable", None
    kv, usable = _substation_kv()
    d = subs.pts.distances_m(x, y)
    with np.errstate(invalid="ignore"):
        ok = np.flatnonzero(usable & (kv >= threshold))
    if not len(ok):
        return "confirmed_absent", None
    i = int(ok[np.argmin(d[ok])])
    entry = ex._substation_entry(subs, i, d[i])
    untagged = np.flatnonzero(subs.candidate & np.isnan(kv) & usable)
    if len(untagged):
        j = int(untagged[np.argmin(d[untagged])])
        if d[j] < d[i]:
            entry["closer_untagged_km"] = round(float(d[j]) / 1000.0, 2)
    return "available", entry


def _line(x: float, y: float, threshold: int) -> tuple[str, dict[str, Any] | None]:
    from app.explore import service as ex

    if not ex._count("transmission"):
        return "unavailable", None
    hit = ex._nearest_line(_lines_by_threshold()[threshold], x, y)
    return ("available", hit) if hit else ("confirmed_absent", None)


def grid_tiers(loc: LngLat) -> dict[str, Any]:
    """extras["grid_tiers"]: per threshold, the nearest qualifying substation and line and each one's state.

    State per asset: "available" (found), "confirmed_absent" (the layer loaded and holds no qualifying
    asset anywhere in California), "unavailable" (the layer didn't load). Whether the site is inside
    the layers' California coverage is the caller's call (A's summary knows).
    """
    from app.explore import service as ex

    x, y = ex._to_albers().transform(loc.lon, loc.lat)
    if not (math.isfinite(x) and math.isfinite(y)):
        return {"available": False, "reason": "location could not be projected"}
    tiers: dict[str, Any] = {}
    for kv in THRESHOLDS_KV:
        sub_state, sub = _substation(x, y, kv)
        line_state, line = _line(x, y, kv)
        tiers[str(kv)] = {"substation_state": sub_state, "substation": sub, "line_state": line_state, "line": line}
    return {
        "available": True,
        "thresholds_kv": list(THRESHOLDS_KV),
        "distance_method": ex.DISTANCE_METHOD,
        "substations_as_of": ex._updated("substations"),
        "transmission_as_of": ex._updated("transmission"),
        "tiers": tiers,
    }


def clear_caches() -> None:
    _substation_kv.cache_clear()
    _lines_by_threshold.cache_clear()
