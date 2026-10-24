"""California grid + people layers, projected once to California Albers (metres).  OWNER: workstream B.

Reads committed layers only, so a training machine needs nothing but a repo checkout: data/explore/
(EIA-860 plants, CEC transmission lines, OSM substations, Census counties + block-group population,
LBNL queue by county, from workstream A) and data/site_intel/ (EPA nonattainment areas, from E).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd
from pyproj import Transformer
from shapely import STRtree, make_valid, points, transform, union_all
from shapely.geometry import shape

from ml.site_location.config import CA_ALBERS, EXPLORE_DIR, HV_KV, SITE_INTEL_DIR

_FWD = Transformer.from_crs("EPSG:4326", CA_ALBERS, always_xy=True)
_INV = Transformer.from_crs(CA_ALBERS, "EPSG:4326", always_xy=True)


def to_xy(lon, lat) -> tuple[np.ndarray, np.ndarray]:
    return _FWD.transform(np.asarray(lon, dtype=float), np.asarray(lat, dtype=float))


def to_lonlat(x, y) -> tuple[np.ndarray, np.ndarray]:
    return _INV.transform(np.asarray(x, dtype=float), np.asarray(y, dtype=float))


def project(geom):
    return transform(geom, lambda c: np.column_stack(_FWD.transform(c[:, 0], c[:, 1])))


@dataclass
class GeoData:
    plants: pd.DataFrame  # id, name, fuel, capacity_mw, first_year, x, y
    substations: pd.DataFrame  # id, name, voltage_kv, x, y
    lines_hv: list  # operational AC lines >= HV_KV, projected
    lines_any: list  # operational AC lines >= 69 kV, projected
    population: pd.DataFrame  # x, y, population, geoid
    counties: pd.DataFrame  # geoid, name, geometry (projected polygon)
    land: object  # union of counties, projected
    queue_mw: dict[str, float]  # county geoid -> active interconnection requests, MW
    nonattainment: object | None  # union of EPA nonattainment areas (ozone, PM), projected (workstream E's layer)


def _features(directory: Path, name: str) -> list[dict]:
    return json.loads((directory / name).read_text(encoding="utf-8"))["features"]


def _points_frame(features: list[dict], props: list[str]) -> pd.DataFrame:
    df = pd.DataFrame([{k: f["properties"].get(k) for k in props} for f in features])
    lon = [f["geometry"]["coordinates"][0] for f in features]
    lat = [f["geometry"]["coordinates"][1] for f in features]
    df["x"], df["y"] = to_xy(lon, lat)
    return df


def load_geodata(directory: Path = EXPLORE_DIR) -> GeoData:
    plants = _points_frame(_features(directory, "plants_ca.geojson"), ["id", "name", "fuel", "capacity_mw", "first_year"])
    subs = _points_frame(_features(directory, "substations_ca.geojson"), ["id", "name", "voltage_kv", "substation_type"])
    # A plant's own switchyard (OSM substation=generation) sits on the plant: as a feature it would just
    # say "a plant is here" (label leakage), so only network substations count.
    subs = subs[subs["substation_type"].fillna("") != "generation"].reset_index(drop=True)

    hv, anyv = [], []
    for f in _features(directory, "transmission_ca.geojson"):
        p = f["properties"]
        if not p.get("operational", True) or "DC" in str(p.get("voltage_label") or "").upper():
            continue  # proposed/closed lines and HVDC interties can't be tapped
        g = project(shape(f["geometry"]))
        anyv.append(g)
        if (p.get("voltage_kv") or 0) >= HV_KV:
            hv.append(g)

    cf = _features(directory, "counties_ca.geojson")
    counties = pd.DataFrame({"geoid": [f["properties"]["geoid"] for f in cf], "name": [f["properties"]["name"] for f in cf]})
    counties["geometry"] = [project(shape(f["geometry"])) for f in cf]
    land = union_all(counties["geometry"].to_list())

    pop = pd.read_csv(directory / "population_bg_ca.csv")
    pop["x"], pop["y"] = to_xy(pop["lon"], pop["lat"])
    pop["geoid"] = county_of(pop["x"].to_numpy(), pop["y"].to_numpy(), counties)

    queue_mw: dict[str, float] = {}
    qpath = directory / "queue_ca_by_county.json"
    if qpath.is_file():
        q = json.loads(qpath.read_text(encoding="utf-8"))["counties"]
        by_name = dict(zip(counties["name"], counties["geoid"]))
        queue_mw = {by_name[n]: float(v.get("active_mw", 0.0)) for n, v in q.items() if n in by_name}

    nonattainment = None
    npath = SITE_INTEL_DIR / "nonattainment_ca.geojson"
    if npath.is_file():
        polys = [make_valid(project(shape(f["geometry"]))) for f in _features(SITE_INTEL_DIR, "nonattainment_ca.geojson") if f.get("geometry")]
        nonattainment = union_all(polys) if polys else None

    return GeoData(plants, subs, hv, anyv, pop, counties, land, queue_mw, nonattainment)


def county_of(x: np.ndarray, y: np.ndarray, counties: pd.DataFrame) -> np.ndarray:
    """County geoid for each projected point; the nearest county for points just off the outline."""
    polys = counties["geometry"].to_list()
    tree = STRtree(polys)
    pts = points(x, y)
    out = np.full(len(pts), "", dtype=object)
    pi, ci = tree.query(pts, predicate="within")
    out[pi] = counties["geoid"].to_numpy()[ci]
    miss = out == ""
    if miss.any():
        out[miss] = counties["geoid"].to_numpy()[tree.nearest(pts[miss])]
    return out


@lru_cache(maxsize=1)
def geodata() -> GeoData:
    return load_geodata()
