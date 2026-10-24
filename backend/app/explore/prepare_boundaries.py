"""Boundary / lookup layers for the Explore map and site summary.  OWNER: workstream A.

Writes three processed GeoJSON files to data/explore/ (raw downloads cached in data/explore/raw/):
  counties_ca.geojson               58 CA counties, Census cartographic boundaries 1:500k
  utilities_ca.geojson              electric retail service territories, CEC "Electric Load Serving
                                    Entities (IOU & POU)"; IOU and POU polygons overlap, so a lookup
                                    should pick the smallest containing polygon
  balancing_authorities_ca.geojson  balancing authority areas (CEC), keyed by EIA BA code

Run from backend/:  .venv/Scripts/python -m app.explore.prepare_boundaries
Idempotent: reuses cached raw downloads; delete data/explore/raw/<file> to refetch.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import geopandas as gpd
import httpx
import shapely
from shapely.geometry import MultiPolygon, Point, Polygon
from shapely.geometry.base import BaseGeometry

from app.explore._prep_utils import (
    CA_ALBERS,
    OUT_DIR,
    RAW_DIR,
    WGS84,
    download,
    fetch_arcgis_geojson,
    gdf_to_features,
    simplify_m,
    write_geojson,
)

COUNTY_URLS = {
    2024: "https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_500k.zip",
    2023: "https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_500k.zip",
}
LSE_URL = "https://services3.arcgis.com/bWPjFyq029ChCGur/arcgis/rest/services/ElectricLoadServingEntities_IOU_POU/FeatureServer/0"
BA_URL = "https://services3.arcgis.com/bWPjFyq029ChCGur/arcgis/rest/services/Balancing_Authority/FeatureServer/0"

LSE_SOURCE = "CEC Electric Load Serving Entities (IOU & POU)"
BA_SOURCE = "CEC Balancing Authority areas"

# CEC NAME -> (EIA BA code, display name)
BA_CODES: dict[str, tuple[str, str]] = {
    "CALISO": ("CAISO", "California ISO"),
    "BANC": ("BANC", "Balancing Authority of Northern California"),
    "IID": ("IID", "Imperial Irrigation District"),
    "LADWP": ("LADWP", "Los Angeles Department of Water and Power"),
    "NV Energy": ("NEVP", "NV Energy"),
    "TID": ("TIDC", "Turlock Irrigation District"),
    "WALC": ("WALC", "WAPA Desert Southwest"),
    "PacificCorp West": ("PACW", "PacifiCorp West"),
}

# LSE polygons that cover member water/irrigation agencies' pumping loads rather than general retail
# customers. They sit on top of PG&E/SCE/SDG&E, so "smallest containing polygon" lookups should skip them.
SPECIAL_PURPOSE_NOTE = "Supplies member water-agency pumping loads, not general retail; the overlapping utility serves other customers"
SPECIAL_PURPOSE = {
    "Power and Water Resource Pooling Authority",
    "Eastside Power Authority",
    "Metropolitan Water District of So. Cal",
}
# Known errors in the CEC attribute table: utility -> URL to drop (null is better than a wrong link).
BAD_URLS = {"City of Healdsburg Electric Department": "gridley.ca.us"}

COUNTY_SIMPLIFY_M = 100
UTILITY_SIMPLIFY_M = 100
BA_SIMPLIFY_M = 200
OUTPUT_GRID_DEG = 1e-5  # matches write_geojson(precision=5)
BUDGET_BYTES = {"counties_ca.geojson": 1.5e6, "utilities_ca.geojson": 3e6, "balancing_authorities_ca.geojson": 1.5e6}

DEMO_SITES: dict[str, tuple[float, float]] = {
    "Kern placeholder": (-119.47, 35.40),
    "Tracy/Tesla substation": (-121.55, 37.71),
    "Los Banos": (-120.85, 37.06),
}


# ---------------------------------------------------------------- helpers


def _polygonal(geom: BaseGeometry | None) -> Polygon | MultiPolygon | None:
    """make_valid, then keep only the polygonal parts (drops stray lines/points)."""
    if geom is None or geom.is_empty:
        return None
    if not geom.is_valid:
        geom = shapely.make_valid(geom)
    if isinstance(geom, (Polygon, MultiPolygon)):
        return geom
    polys: list[Polygon] = []
    for part in getattr(geom, "geoms", []):
        if isinstance(part, Polygon):
            polys.append(part)
        elif isinstance(part, MultiPolygon):
            polys.extend(part.geoms)
    if not polys:
        return None
    return polys[0] if len(polys) == 1 else MultiPolygon(polys)


def _clean_geometries(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    gdf = gdf.copy()
    gdf["geometry"] = [_polygonal(g) for g in gdf.geometry]
    return gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty]


def _simplify(gdf: gpd.GeoDataFrame, tolerance_m: float) -> gpd.GeoDataFrame:
    """simplify_m, then snap to the 5-decimal output grid so write_geojson's rounding can't
    collapse rings or create self-intersections (set_precision returns valid geometry)."""
    out = simplify_m(gdf, tolerance_m)
    out["geometry"] = shapely.set_precision(out.geometry.values, OUTPUT_GRID_DEG)
    return _clean_geometries(out)


def _area_km2(gdf: gpd.GeoDataFrame) -> list[float]:
    return [round(a / 1e6, 1) for a in gdf.to_crs(CA_ALBERS).geometry.area]


def _str_or_none(value: Any) -> str | None:
    if value is None or (isinstance(value, float) and value != value):  # NaN
        return None
    text = str(value).strip()
    return text or None


def _cached_arcgis(layer_url: str, name: str) -> tuple[dict[str, Any], str | None]:
    """Fetch an ArcGIS layer once into RAW_DIR. Returns (FeatureCollection, data-last-edit date YYYY-MM-DD)."""
    data_path = RAW_DIR / f"{name}.geojson"
    meta_path = RAW_DIR / f"{name}.meta.json"
    if not (data_path.exists() and meta_path.exists()):
        RAW_DIR.mkdir(parents=True, exist_ok=True)
        meta = httpx.get(layer_url, params={"f": "json"}, timeout=60).json()
        fc = fetch_arcgis_geojson(layer_url)
        data_path.write_text(json.dumps(fc), encoding="utf-8")
        meta_path.write_text(json.dumps(meta), encoding="utf-8")
    fc = json.loads(data_path.read_text(encoding="utf-8"))
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    edited_ms = (meta.get("editingInfo") or {}).get("dataLastEditDate")
    date = datetime.fromtimestamp(edited_ms / 1000, UTC).date().isoformat() if edited_ms else None
    return fc, date


def _write(gdf: gpd.GeoDataFrame, filename: str) -> Path:
    path = write_geojson(gdf_to_features(gdf), OUT_DIR / filename)
    size = path.stat().st_size
    status = "OK" if size <= BUDGET_BYTES[filename] else "OVER BUDGET"
    print(f"  wrote {path.relative_to(OUT_DIR.parent.parent)}  {len(gdf)} features  {size / 1e6:.2f} MB  [{status}]")
    return path


def _containing(gdf: gpd.GeoDataFrame, lon: float, lat: float) -> gpd.GeoDataFrame:
    return gdf[gdf.geometry.contains(Point(lon, lat))]


# ---------------------------------------------------------------- layers


def build_counties() -> gpd.GeoDataFrame:
    year, zip_path = None, None
    for y, url in COUNTY_URLS.items():
        try:
            zip_path = download(url, RAW_DIR / Path(url).name)
            year = y
            break
        except httpx.HTTPError as exc:
            print(f"  counties {y} unavailable ({exc}); trying older vintage")
    if zip_path is None:
        raise SystemExit("No Census cartographic boundary county file could be downloaded")

    us = gpd.read_file(zip_path)
    ca = us[us["STATEFP"] == "06"].to_crs(WGS84)
    ca = _simplify(ca, COUNTY_SIMPLIFY_M).sort_values("NAME")
    out = gpd.GeoDataFrame(
        {
            "id": "county-" + ca["GEOID"],
            "name": ca["NAME"],
            "geoid": ca["GEOID"],
            "full_name": ca["NAMELSAD"],
            "source": f"US Census Bureau cartographic boundaries {year} (1:500k)",
            "source_url": COUNTY_URLS[year],
        },
        geometry=ca.geometry.values,
        crs=WGS84,
    )
    _write(out, "counties_ca.geojson")
    return out


def build_utilities() -> gpd.GeoDataFrame:
    fc, date = _cached_arcgis(LSE_URL, "cec_lse_iou_pou")
    raw = gpd.GeoDataFrame.from_features(fc["features"], crs=WGS84)
    print(f"  {len(raw)} raw LSE polygons (data last edited {date})")
    gdf = _clean_geometries(raw).sort_values("OBJECTID").reset_index(drop=True)
    if len(gdf) < len(raw):
        print(f"  dropped {len(raw) - len(gdf)} features with no polygonal geometry")

    # Drop exact duplicates (same utility, same geometry), keeping the lowest OBJECTID.
    keep: list[int] = []
    for i, row in gdf.iterrows():
        dup_of = next((j for j in keep if gdf.at[j, "Utility"] == row["Utility"] and gdf.at[j, "geometry"].equals(row.geometry)), None)
        if dup_of is None:
            keep.append(i)
        else:
            print(f"  dropped duplicate OBJECTID {row['OBJECTID']} ({row['Utility']}) = OBJECTID {gdf.at[dup_of, 'OBJECTID']}")
    gdf = gdf.loc[keep]

    gdf = gdf.assign(area_km2=_area_km2(gdf))  # from the unsimplified, valid geometry
    gdf = _simplify(gdf, UTILITY_SIMPLIFY_M)
    acronyms = [_str_or_none(a) for a in gdf["Acronym"]]
    names = [str(u).strip() for u in gdf["Utility"]]
    urls = [_str_or_none(u) for u in gdf["URL"]]
    urls = [None if u and n in BAD_URLS and BAD_URLS[n] in u else u for n, u in zip(names, urls, strict=True)]
    special = [n in SPECIAL_PURPOSE for n in names]
    missing = SPECIAL_PURPOSE - set(names)
    if missing:
        print(f"  WARNING special-purpose utilities not found: {missing}")
    out = gpd.GeoDataFrame(
        {
            "id": [f"util-{int(o)}" for o in gdf["OBJECTID"]],
            "name": names,
            "acronym": acronyms,
            "short_name": [a or n for a, n in zip(acronyms, names, strict=True)],
            "utility_type": [str(t).strip().upper() for t in gdf["Type"]],
            "url": urls,
            "area_km2": gdf["area_km2"].values,
            "special_purpose": special,
            "note": [SPECIAL_PURPOSE_NOTE if s else None for s in special],
            "source": LSE_SOURCE,
            "source_date": date,
            "source_url": LSE_URL,
        },
        geometry=gdf.geometry.values,
        crs=WGS84,
    )
    bad_types = set(out["utility_type"]) - {"IOU", "POU"}
    if bad_types:
        print(f"  WARNING unexpected utility_type values: {bad_types}")
    _write(out, "utilities_ca.geojson")
    return out


def build_balancing_authorities() -> gpd.GeoDataFrame:
    fc, date = _cached_arcgis(BA_URL, "cec_balancing_authority")
    raw = _clean_geometries(gpd.GeoDataFrame.from_features(fc["features"], crs=WGS84))
    raw["NAME"] = raw["NAME"].str.strip()
    unknown = set(raw["NAME"]) - set(BA_CODES)
    if unknown:
        raise SystemExit(f"Unmapped balancing authority names: {unknown}")
    print(f"  {len(raw)} raw BA polygons (data last edited {date})")

    merged = _clean_geometries(raw.dissolve(by="NAME", as_index=False))  # CALISO comes as 2 features
    merged = _simplify(merged.assign(area_km2=_area_km2(merged)), BA_SIMPLIFY_M)
    codes = [BA_CODES[n] for n in merged["NAME"]]
    out = gpd.GeoDataFrame(
        {
            "id": [f"ba-{c}" for c, _ in codes],
            "name": [d for _, d in codes],
            "short_name": [c for c, _ in codes],
            "cec_name": merged["NAME"].values,
            "area_km2": merged["area_km2"].values,
            "source": BA_SOURCE,
            "source_date": date,
            "source_url": BA_URL,
        },
        geometry=merged.geometry.values,
        crs=WGS84,
    ).sort_values("area_km2", ascending=False)
    _write(out, "balancing_authorities_ca.geojson")
    return out


# ---------------------------------------------------------------- validation


def _report_overlaps(utils: gpd.GeoDataFrame, min_km2: float = 1.0) -> None:
    proj = utils.to_crs(CA_ALBERS).reset_index(drop=True)
    pairs = []
    for i, j in zip(*proj.sindex.query(proj.geometry, predicate="intersects"), strict=True):
        if i >= j:
            continue
        a, b = proj.iloc[i], proj.iloc[j]
        inter = a.geometry.intersection(b.geometry).area / 1e6
        if inter >= min_km2:
            pairs.append((inter, a, b))
    iou_pou = [p for p in pairs if {p[1]["utility_type"], p[2]["utility_type"]} == {"IOU", "POU"}]
    print(f"  overlapping pairs >= {min_km2} km2: {len(pairs)} total, {len(iou_pou)} IOU/POU")
    for inter, a, b in sorted(pairs, key=lambda p: -p[0])[:12]:
        smaller = min(a["area_km2"], b["area_km2"])
        print(
            f"    {a['short_name']} ({a['utility_type']}) x {b['short_name']} ({b['utility_type']}): "
            f"{inter:,.0f} km2 ({100 * inter / smaller:.0f}% of the smaller)"
        )


def main() -> None:
    print("Counties:")
    counties = build_counties()
    print("Utilities:")
    utils = build_utilities()
    print("Balancing authorities:")
    bas = build_balancing_authorities()

    print("Validation:")
    assert len(counties) == 58, f"expected 58 CA counties, got {len(counties)}"
    for filename in BUDGET_BYTES:  # validate what was actually written (after coordinate rounding)
        gdf = gpd.read_file(OUT_DIR / filename)
        assert gdf["id"].is_unique, f"{filename}: duplicate ids"
        assert gdf["name"].map(lambda s: isinstance(s, str) and bool(s.strip())).all(), f"{filename}: empty name"
        assert gdf["source"].notna().all(), f"{filename}: missing source"
        invalid = gdf.loc[~gdf.geometry.is_valid, "id"].tolist()
        assert not invalid, f"{filename}: invalid geometry {invalid}"
    print(f"  counties={len(counties)}  utilities={len(utils)} (IOU {sum(utils['utility_type'] == 'IOU')}, "
          f"POU {sum(utils['utility_type'] == 'POU')})  balancing_authorities={len(bas)}")
    _report_overlaps(utils)

    for site, (lon, lat) in DEMO_SITES.items():
        county = _containing(counties, lon, lat)["name"].tolist()
        inside = _containing(utils, lon, lat).sort_values("area_km2")
        util_desc = [f"{r.short_name} ({r.utility_type}, {r.area_km2:,.0f} km2{', special' if r.special_purpose else ''})" for r in inside.itertuples()]
        retail = inside[~inside["special_purpose"]]
        pick = retail.iloc[0]["short_name"] if len(retail) else None
        ba = _containing(bas, lon, lat)["short_name"].tolist()
        print(f"  {site} ({lon}, {lat}): county={county or 'NONE'}  BA={ba or 'NONE'}  utility pick={pick}  "
              f"containing (smallest first)={util_desc or 'NONE'}")
    assert _containing(counties, -119.47, 35.40)["name"].tolist() == ["Kern"], "Kern must contain the placeholder site"


if __name__ == "__main__":
    main()
