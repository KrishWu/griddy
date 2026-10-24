"""Site features: grid access, people, and nearby demand from A's demand artifact.  OWNER: workstream B.

Every candidate point (a 5 km grid cell over California, or a plant location for training)
gets the same features: grid access (A's layers), people (Census), solar and wind resource (ERA5),
air-quality nonattainment (E's EPA layer), and nearby demand. "Nearby demand" is where the demand forecast feeds in: county annual
energy from the artifact, spread to 2020 Census block groups by population, summed within
50 km and 150 km. Training uses the artifact's base year (demand when plants were sited);
recommendations use a forecast year.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree
from shapely import STRtree, contains_xy, points, prepare

from ml.contract.demand_artifact import DemandArtifact
from ml.site_location.config import DEMAND_RADII_KM, GRID_SPACING_KM, HV_KV
from ml.site_location.fetch_resource import interpolate, load_resource
from ml.site_location.geodata import GeoData, county_of, to_lonlat

FEATURES = [
    "d_sub_hv_km",  # nearest network substation >= 220 kV
    "d_sub_any_km",  # nearest network substation >= 60 kV
    "d_line_hv_km",  # nearest operational AC line >= 220 kV
    "d_line_any_km",  # nearest operational AC line >= 69 kV
    "sub_kv_max_10km",  # highest substation voltage within 10 km (0 if none)
    "log_pop_10km",
    "log_pop_50km",
    "log_demand_50km_gwh",
    "log_demand_150km_gwh",
    "ghi_kwh_m2_day",  # solar resource, ERA5 annual mean (fetch_resource.py)
    "wind100_ms",  # wind resource at hub height, ERA5 annual mean
    "in_nonattainment",  # inside an EPA ozone/PM nonattainment area (air permits for combustion)
]


def candidate_grid(geo: GeoData, spacing_km: float = GRID_SPACING_KM) -> pd.DataFrame:
    """Cell centres on a regular grid inside California: x, y (m), lon, lat, geoid."""
    minx, miny, maxx, maxy = geo.land.bounds
    step = spacing_km * 1000.0
    xs, ys = np.meshgrid(np.arange(minx + step / 2, maxx, step), np.arange(miny + step / 2, maxy, step))
    xs, ys = xs.ravel(), ys.ravel()
    prepare(geo.land)
    inside = contains_xy(geo.land, xs, ys)
    grid = pd.DataFrame({"x": xs[inside], "y": ys[inside]})
    grid["lon"], grid["lat"] = to_lonlat(grid["x"], grid["y"])
    grid["geoid"] = county_of(grid["x"].to_numpy(), grid["y"].to_numpy(), geo.counties)
    return grid.reset_index(drop=True)


def demand_points(geo: GeoData, artifact: DemandArtifact, scenario: str, year: int) -> pd.DataFrame:
    """Block-group points carrying county annual demand (GWh) split by population within the county."""
    county = artifact.county_year(scenario, year).set_index("geoid")["annual_energy_mwh"]
    pop = geo.population
    county_pop = pop.groupby("geoid")["population"].transform("sum")
    gwh = pop["geoid"].map(county).fillna(0.0).to_numpy() * (pop["population"] / county_pop).to_numpy() / 1000.0
    return pd.DataFrame({"x": pop["x"], "y": pop["y"], "gwh": gwh})


def radius_sum(px: np.ndarray, py: np.ndarray, wx: np.ndarray, wy: np.ndarray, w: np.ndarray, radius_km: float) -> np.ndarray:
    """Sum of weights within radius of each point. Weights are first binned to radius/10 so big radii stay cheap."""
    b = radius_km * 100.0  # bin size in metres = radius / 10
    keys = np.stack([np.floor(wx / b), np.floor(wy / b)], axis=1)
    uniq, inv = np.unique(keys, axis=0, return_inverse=True)
    bw = np.bincount(inv.ravel(), weights=w, minlength=len(uniq))
    bx = np.bincount(inv.ravel(), weights=w * wx, minlength=len(uniq)) / np.where(bw > 0, bw, 1)
    by = np.bincount(inv.ravel(), weights=w * wy, minlength=len(uniq)) / np.where(bw > 0, bw, 1)
    tree = cKDTree(np.column_stack([bx, by]))
    hits = tree.query_ball_point(np.column_stack([px, py]), r=radius_km * 1000.0)
    return np.array([bw[h].sum() if h else 0.0 for h in hits])


def _nearest_line_km(lines: list, pts) -> np.ndarray:
    if not lines:
        return np.full(len(pts), 1000.0)
    (src, _), dist = STRtree(lines).query_nearest(pts, return_distance=True, all_matches=False)
    out = np.empty(len(pts))
    out[src] = dist / 1000.0
    return out


def compute_features(x: np.ndarray, y: np.ndarray, geo: GeoData, demand: pd.DataFrame) -> pd.DataFrame:
    """FEATURES for projected points (metres). `demand` comes from demand_points()."""
    x, y = np.asarray(x, dtype=float), np.asarray(y, dtype=float)
    pts = points(x, y)
    xy = np.column_stack([x, y])
    subs = geo.substations
    kv = subs["voltage_kv"].fillna(0.0).to_numpy()
    out = pd.DataFrame(index=range(len(x)))

    for col, mask in (("d_sub_hv_km", kv >= HV_KV), ("d_sub_any_km", kv >= 60.0)):
        tree = cKDTree(subs.loc[mask, ["x", "y"]].to_numpy())
        out[col] = tree.query(xy)[0] / 1000.0
    out["d_line_hv_km"] = _nearest_line_km(geo.lines_hv, pts)
    out["d_line_any_km"] = _nearest_line_km(geo.lines_any, pts)

    tree = cKDTree(subs[["x", "y"]].to_numpy())
    out["sub_kv_max_10km"] = [kv[h].max() if h else 0.0 for h in tree.query_ball_point(xy, r=10_000.0)]

    pop = geo.population
    out["log_pop_10km"] = np.log1p(radius_sum(x, y, pop["x"].to_numpy(), pop["y"].to_numpy(), pop["population"].to_numpy(float), 10.0))
    out["log_pop_50km"] = np.log1p(radius_sum(x, y, pop["x"].to_numpy(), pop["y"].to_numpy(), pop["population"].to_numpy(float), 50.0))
    for r in DEMAND_RADII_KM:
        s = radius_sum(x, y, demand["x"].to_numpy(), demand["y"].to_numpy(), demand["gwh"].to_numpy(), r)
        out[f"log_demand_{int(r)}km_gwh"] = np.log1p(s)
    res = interpolate(load_resource(), x, y)
    out["ghi_kwh_m2_day"] = res["ghi_kwh_m2_day"].to_numpy()
    out["wind100_ms"] = res["wind100_ms"].to_numpy()
    if geo.nonattainment is not None:
        prepare(geo.nonattainment)
        out["in_nonattainment"] = contains_xy(geo.nonattainment, x, y).astype(float)
    else:
        out["in_nonattainment"] = 0.0
    return out[FEATURES]
