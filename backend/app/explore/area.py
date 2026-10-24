"""Selected-area demographics using the bundled 2020 Census block-group centroids."""
from __future__ import annotations

from functools import lru_cache

import numpy as np
from pydantic import Field
from pyproj import Geod
from shapely import covers, points
from shapely.geometry import shape
from shapely.geometry.polygon import orient
from shapely.errors import ShapelyError

from app import DATA_DIR
from app.contract import Model, Provenance


class AreaRequest(Model):
    footprint: dict
    persons_per_household: float = Field(default=2.9, ge=1, le=10)
    household_kwh_per_year: float = Field(default=6500, gt=0, le=100000)
    load_factor: float = Field(default=0.55, gt=0, le=1)


def area_geometry(footprint: dict):
    try:
        geom = shape(footprint)
        if geom.geom_type not in ("Polygon", "MultiPolygon") or geom.is_empty or not geom.is_valid:
            raise ValueError("Use a valid Polygon or MultiPolygon.")
        if geom.has_z:
            raise ValueError("Use longitude/latitude coordinates without altitude.")
        x1, y1, x2, y2 = geom.bounds
        if not (-180 <= x1 <= x2 <= 180 and -85 <= y1 <= y2 <= 85) or x2 - x1 > 10 or y2 - y1 > 10:
            raise ValueError("Select an area within 10 degrees in longitude and latitude.")
        polygons = [geom] if geom.geom_type == "Polygon" else geom.geoms
        area = sum(abs(Geod(ellps="WGS84").geometry_area_perimeter(orient(g, sign=1))[0]) for g in polygons) / 1e6
        if not 0 < area <= 50000:
            raise ValueError("Select an area larger than zero and no larger than 50,000 km².")
        return geom, area
    except (TypeError, KeyError, AttributeError, IndexError, ShapelyError) as exc:
        raise ValueError("Invalid GeoJSON area.") from exc


@lru_cache(maxsize=1)
def population_points():
    path = DATA_DIR / "explore" / "population_bg_ca.csv"
    try:
        rows = np.loadtxt(path, delimiter=",", skiprows=1, ndmin=2)
        if rows.shape[1] != 3 or not np.isfinite(rows).all() or (rows[:, 2] < 0).any():
            return None
        return rows
    except (OSError, ValueError):
        return None


def summarize_area(req: AreaRequest) -> dict:
    geom, area = area_geometry(req.footprint)
    rows = population_points()
    population = int(rows[covers(geom, points(rows[:, :2])), 2].sum()) if rows is not None else None
    households = population / req.persons_per_household if population is not None else None
    annual = households * req.household_kwh_per_year / 1000 if households is not None else None
    return {"area_km2": area, "population": population, "estimated_households": households,
        "residential_demand_mwh_per_year": annual,
        "average_residential_demand_mw": annual / 8760 if annual is not None else None,
        "estimated_residential_peak_mw": annual / 8760 / req.load_factor if annual is not None else None,
        "assumptions": req.model_dump(exclude={"footprint"}),
        "coverage": "2020 Census California block groups" if rows is not None else "Population data unavailable",
        "caveat": "Centroid approximation: a block group counts in full when its population-weighted centroid is inside the area. Small selections can show zero despite residents. Households and residential demand are estimates, exclude commercial/industrial demand, and do not identify actual utility customers or prove the project serves them.",
        "provenance": [Provenance(kind="inferred", source="2020 Census California population-weighted block-group centroids",
            url="https://www2.census.gov/geo/docs/reference/cenpop2020/blkgrp/CenPop2020_Mean_BG06.txt").model_dump(),
            Provenance(kind="assumption", source="Editable household size, household electricity use and load factor",
                note="Illustrative defaults: 2.9 people/household, 6,500 kWh/household/year, 0.55 load factor. Not a measured utility load.").model_dump()]}
