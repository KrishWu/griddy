"""Region geography: which people (and so which load) belong to which forecast region.  OWNER: workstream A.

EIA-930 reports load per region, not per county. We place every 2020 Census block group
in a region and use population as the downscaling weight:
  - balancing authority polygon first (LADWP, BANC, IID, TIDC are whole regions);
  - inside CAISO, the PG&E / SCE / SDG&E territory that contains it (or the nearest one,
    for municipal utilities in gaps between IOU polygons);
  - block groups in PACW / NEVP / WALC or outside every BA are not in any forecast region.
County demand is therefore an *estimate* (population-weighted), not a metered value.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

import numpy as np
import pandas as pd
from pyproj import Transformer
from shapely import STRtree, points, transform
from shapely.geometry import shape

from ml.contract.regions import REGIONS
from ml.demand_forecast.config import CA_ALBERS, CACHE_DIR, EXPLORE_DIR, WEATHER_POINTS_PER_REGION

GEO_CACHE = CACHE_DIR / "region_geo.json"
_BA_TO_REGION = {r.balancing_authority: r.id for r in REGIONS.values() if r.eia_subregion is None}
_CAISO_IOU_TO_REGION = {u: r.id for r in REGIONS.values() if r.eia_subregion for u in r.utilities}


@dataclass
class RegionGeo:
    county_shares: pd.DataFrame  # region, geoid, county, population, population_share
    weather_points: dict[str, list[dict[str, float]]]  # region -> [{lat, lon, weight}]

    def to_json(self) -> dict:
        return {"county_shares": self.county_shares.to_dict(orient="records"), "weather_points": self.weather_points}

    @classmethod
    def from_json(cls, d: dict) -> RegionGeo:
        shares = pd.DataFrame(d["county_shares"]).astype({"geoid": "string", "county": "string", "region": "string"})
        return cls(county_shares=shares, weather_points=d["weather_points"])


def _features(name: str) -> list[dict]:
    return json.loads((EXPLORE_DIR / name).read_text(encoding="utf-8"))["features"]


def _lookup(polys: list, labels: list, pts) -> np.ndarray:
    """Label of the polygon containing each point ('' where none does)."""
    tree = STRtree(polys)
    pt_idx, poly_idx = tree.query(pts, predicate="within")
    out = np.full(len(pts), "", dtype=object)
    out[pt_idx] = np.asarray(labels, dtype=object)[poly_idx]
    return out


def assign_block_groups() -> pd.DataFrame:
    """Every CA block group with its county and forecast region ('' = not in a region)."""
    bg = pd.read_csv(EXPLORE_DIR / "population_bg_ca.csv")
    pts = points(bg["lon"].to_numpy(), bg["lat"].to_numpy())

    counties = _features("counties_ca.geojson")
    county_polys = [shape(f["geometry"]) for f in counties]
    bg["geoid"] = _lookup(county_polys, [f["properties"]["geoid"] for f in counties], pts)
    bg["county"] = bg["geoid"].map({f["properties"]["geoid"]: f["properties"]["name"] for f in counties})
    # Coastal centroids can fall a few metres outside the cartographic county outline: use the nearest county.
    miss = bg["geoid"] == ""
    if miss.any():
        tree = STRtree(county_polys)
        nearest = tree.nearest(pts[miss.to_numpy()])
        bg.loc[miss, "geoid"] = [counties[i]["properties"]["geoid"] for i in nearest]
        bg.loc[miss, "county"] = [counties[i]["properties"]["name"] for i in nearest]

    bas = _features("balancing_authorities_ca.geojson")
    ba = _lookup([shape(f["geometry"]) for f in bas], [f["properties"]["short_name"] for f in bas], pts)

    ious = [f for f in _features("utilities_ca.geojson") if f["properties"]["short_name"] in _CAISO_IOU_TO_REGION]
    iou_polys = [shape(f["geometry"]) for f in ious]
    iou_labels = [_CAISO_IOU_TO_REGION[f["properties"]["short_name"]] for f in ious]
    caiso_region = _lookup(iou_polys, iou_labels, pts)
    gap = (ba == "CAISO") & (caiso_region == "")
    if gap.any():
        # Municipal utilities inside CAISO sit in their host IOU's load area: take the nearest IOU, in metres.
        fwd = Transformer.from_crs("EPSG:4326", CA_ALBERS, always_xy=True)
        tree = STRtree([transform(p, lambda c: np.column_stack(fwd.transform(c[:, 0], c[:, 1]))) for p in iou_polys])
        x, y = fwd.transform(bg.loc[gap, "lon"].to_numpy(), bg.loc[gap, "lat"].to_numpy())
        caiso_region[gap] = np.asarray(iou_labels, dtype=object)[tree.nearest(points(x, y))]

    bg["region"] = np.where(ba == "CAISO", caiso_region, pd.Series(ba).map(_BA_TO_REGION).fillna("").to_numpy())
    return bg


def build_region_geo() -> RegionGeo:
    bg = assign_block_groups()
    inr = bg[bg["region"] != ""]
    shares = inr.groupby(["region", "geoid", "county"], as_index=False)["population"].sum()
    shares["population_share"] = shares["population"] / shares.groupby("region")["population"].transform("sum")

    weather: dict[str, list[dict[str, float]]] = {}
    for region, g in inr.groupby("region"):
        by_county = g.groupby("geoid")["population"].sum()
        top = by_county.nlargest(WEATHER_POINTS_PER_REGION)
        top = top[top >= 0.04 * by_county.sum()].index  # a county with a sliver of the region isn't its weather
        pts = []
        for geoid in top:
            c = g[g["geoid"] == geoid]
            w = c["population"].to_numpy(dtype=float)
            pts.append({"lat": float(np.average(c["lat"], weights=w)), "lon": float(np.average(c["lon"], weights=w)), "weight": float(w.sum())})
        total = sum(p["weight"] for p in pts)
        for p in pts:
            p["weight"] = round(p["weight"] / total, 6)
            p["lat"], p["lon"] = round(p["lat"], 4), round(p["lon"], 4)
        weather[str(region)] = pts

    missing = set(REGIONS) - set(weather)
    if missing:
        raise RuntimeError(f"no population assigned to regions {sorted(missing)}: check data/explore layers")
    return RegionGeo(county_shares=shares.astype({"geoid": "string", "county": "string", "region": "string"}), weather_points=weather)


def region_geo(refresh: bool = False) -> RegionGeo:
    """Cached RegionGeo (cache/region_geo.json); rebuilt from data/explore when missing or refresh=True."""
    if GEO_CACHE.is_file() and not refresh:
        return RegionGeo.from_json(json.loads(GEO_CACHE.read_text(encoding="utf-8")))
    geo = build_region_geo()
    GEO_CACHE.parent.mkdir(parents=True, exist_ok=True)
    GEO_CACHE.write_text(json.dumps(geo.to_json(), indent=1), encoding="utf-8")
    return geo


if __name__ == "__main__":
    g = region_geo(refresh=True)
    summary = g.county_shares.groupby("region").agg(population=("population", "sum"), counties=("geoid", "nunique"))
    print(summary.to_string())
    print(json.dumps(g.weather_points, indent=1))
