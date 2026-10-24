"""Prepare the transmission-line layer from the CEC dataset.  OWNER: workstream A.

Source: California Energy Commission, "California Electric Transmission Lines" (CC BY 4.0),
https://cecgis-caenergy.opendata.arcgis.com/datasets/CAEnergy::california-electric-transmission-lines-1
Keeps lines >= 69 kV (CEC kV_Sort), one feature per CEC record (no merging), simplified in
California Albers so the file stays small. Writes data/explore/transmission_ca.geojson.

Run from backend/:  .venv/bin/python -m app.explore.prepare_transmission
"""

from __future__ import annotations

import json
import math
from collections import Counter
from datetime import UTC, datetime
from typing import Any

import geopandas as gpd
import httpx
from shapely.geometry import Point

from app.explore._prep_utils import CA_ALBERS, OUT_DIR, RAW_DIR, WGS84, fetch_arcgis_geojson, simplify_m, write_geojson

LAYER_URL = "https://services3.arcgis.com/bWPjFyq029ChCGur/arcgis/rest/services/Transmission_Line/FeatureServer/2"
WHERE = "kV_Sort >= 69"
RAW_PATH = RAW_DIR / "cec_transmission_lines.geojson"
OUT_PATH = OUT_DIR / "transmission_ca.geojson"
SOURCE = "CEC California Electric Transmission Lines"
TOLERANCE_M = 10.0  # sub-pixel at z10 (~60 m/px in CA), ~3 px at z14; 25 m would save only 0.2 MB
MAX_BYTES = 6_000_000
PRECISION = 5

DEMO_SITES = {
    "Kern placeholder": (-119.47, 35.40),
    "Tracy/Tesla": (-121.55, 37.71),
    "Los Banos": (-120.85, 37.06),
}


def _str_or_none(v: Any) -> str | None:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    s = str(v).strip()
    return s or None


def _float_or_none(v: Any) -> float | None:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _iso_date(epoch_ms: Any) -> str | None:
    f = _float_or_none(epoch_ms)
    return datetime.fromtimestamp(f / 1000, tz=UTC).date().isoformat() if f else None


def load_raw() -> dict[str, Any]:
    """Fetch (or reuse) the raw CEC lines; the layer's lastEditDate is cached alongside."""
    if RAW_PATH.exists() and RAW_PATH.stat().st_size > 0:
        return json.loads(RAW_PATH.read_text(encoding="utf-8"))
    print(f"Fetching {LAYER_URL} where {WHERE} ...")
    fc = fetch_arcgis_geojson(LAYER_URL, where=WHERE)
    meta = httpx.get(LAYER_URL, params={"f": "json"}, timeout=60).json()
    fc["layer_meta"] = {
        "url": LAYER_URL,
        "where": WHERE,
        "last_edit_date_ms": (meta.get("editingInfo") or {}).get("lastEditDate"),
        "fetched_utc": datetime.now(tz=UTC).isoformat(timespec="seconds"),
    }
    RAW_PATH.parent.mkdir(parents=True, exist_ok=True)
    RAW_PATH.write_text(json.dumps(fc), encoding="utf-8")
    return fc


def _has_geometry(f: dict[str, Any]) -> bool:
    g = f.get("geometry") or {}
    return bool(g.get("coordinates"))


def _name(p: dict[str, Any], owner: str | None, kv: float) -> str:
    # CEC "Name" is always the generic "<Owner> <kV>kV" label, so prefer the real circuit
    # name (TLine_Name, e.g. "Tracy - Lawrence Livermore Lab") where the CEC has one.
    name = _str_or_none(p.get("TLine_Name")) or _str_or_none(p.get("Name"))
    if name:
        return name
    return f"{owner} {kv:g} kV line" if owner else f"{kv:g} kV line"


def _is_operational(status: str | None) -> bool:
    # CEC values (>= 69 kV): Operational / Proposed / Closed. Only "Operational" is energized.
    return (status or "").strip().lower() == "operational"


def _round_line(coords: list[Any]) -> list[list[float]]:
    """Round to PRECISION and drop consecutive duplicate vertices created by rounding."""
    out: list[list[float]] = []
    for x, y, *_ in coords:
        pt = [round(x, PRECISION), round(y, PRECISION)]
        if not out or pt != out[-1]:
            out.append(pt)
    return out


def _clean_geometry(geom: dict[str, Any]) -> dict[str, Any] | None:
    """Rounded geometry, or None if it collapses to a point (the CEC has a few sub-meter stubs)."""
    if geom["type"] == "LineString":
        line = _round_line(geom["coordinates"])
        return {"type": "LineString", "coordinates": line} if len(line) >= 2 else None
    if geom["type"] == "MultiLineString":
        parts = [p for p in (_round_line(c) for c in geom["coordinates"]) if len(p) >= 2]
        if not parts:
            return None
        return {"type": "LineString", "coordinates": parts[0]} if len(parts) == 1 else {"type": "MultiLineString", "coordinates": parts}
    raise ValueError(f"unexpected geometry type {geom['type']}")


def build_features(raw: dict[str, Any], tolerance_m: float) -> tuple[list[dict[str, Any]], dict[str, int]]:
    stats: Counter[str] = Counter()
    feats = [f for f in raw["features"] if _has_geometry(f)]
    stats["dropped_empty_raw"] = len(raw["features"]) - len(feats)

    gdf = gpd.GeoDataFrame.from_features(feats, crs=WGS84)
    gdf = gdf[~gdf.geometry.is_empty & gdf.geometry.notna()].copy()
    # CEC Length_Mile is whole miles (0 for 37% of lines), so measure the unsimplified geometry.
    gdf["length_mi"] = gdf.to_crs(CA_ALBERS).geometry.length / 1609.344
    gdf = simplify_m(gdf, tolerance_m)

    meta = raw.get("layer_meta") or {}
    updated = _iso_date(meta.get("last_edit_date_ms")) or _iso_date(gdf["Last_Editor_Date"].max())

    out: list[dict[str, Any]] = []
    for row in gdf.to_dict("records"):
        geom = _clean_geometry(row["geometry"].__geo_interface__)
        if geom is None:
            stats["dropped_degenerate"] += 1
            continue
        kv = _float_or_none(row.get("kV_Sort"))
        if kv is None:
            stats["dropped_no_kv"] += 1
            continue
        owner = _str_or_none(row.get("Owner"))
        status = _str_or_none(row.get("Status"))
        out.append(
            {
                "type": "Feature",
                "geometry": geom,
                "properties": {
                    "id": f"cec-{int(row['OBJECTID'])}",
                    "name": _name(row, owner, kv),
                    "voltage_kv": kv,
                    "voltage_label": _str_or_none(row.get("kV")),
                    "owner": owner,
                    "status": status,
                    "operational": _is_operational(status),
                    "circuit": _str_or_none(row.get("Circuit")),
                    "line_type": line_type.upper() if (line_type := _str_or_none(row.get("Type"))) else None,
                    "length_mi": round(float(row["length_mi"]), 1),
                    "source": SOURCE,
                    "source_updated": updated,
                },
            }
        )
    # Low voltage first so higher-voltage lines draw on top; OBJECTID keeps the order stable.
    out.sort(key=lambda f: (f["properties"]["voltage_kv"], int(f["properties"]["id"][4:])))
    return out, dict(stats)


def _voltage_class(kv: float) -> str:
    if kv < 100:
        return "69-99 kV"
    if kv < 200:
        return "100-199 kV"
    if kv < 300:
        return "200-299 kV"
    return ">=300 kV"


def validate(features: list[dict[str, Any]]) -> None:
    ids = [f["properties"]["id"] for f in features]
    assert len(ids) == len(set(ids)), "duplicate ids"
    assert all(f["properties"]["name"] for f in features), "empty name"
    assert all(f["properties"]["voltage_kv"] >= 69 for f in features), "line below 69 kV"

    print(f"Features: {len(features)}")
    vc = Counter(_voltage_class(f["properties"]["voltage_kv"]) for f in features)
    print("By voltage class:", {k: vc[k] for k in ("69-99 kV", "100-199 kV", "200-299 kV", ">=300 kV")})
    print("By status:", dict(Counter(f["properties"]["status"] for f in features).most_common()))
    print("By kV label:", dict(Counter(f["properties"]["voltage_label"] for f in features).most_common()))
    print("By line type:", dict(Counter(f["properties"]["line_type"] for f in features).most_common()))
    print(f"Source updated: {features[0]['properties']['source_updated']}")

    gdf = gpd.GeoDataFrame.from_features(features, crs=WGS84)
    hv = gdf[gdf["operational"] & (gdf["voltage_kv"] >= 230)].to_crs(CA_ALBERS)
    print(f"Nearest operational line >= 230 kV ({len(hv)} candidates):")
    for label, (lon, lat) in DEMO_SITES.items():
        pt = gpd.GeoSeries([Point(lon, lat)], crs=WGS84).to_crs(CA_ALBERS).iloc[0]
        d = hv.geometry.distance(pt)
        best = hv.loc[d.idxmin()]
        print(f"  {label} ({lon}, {lat}): {best['name']} | {best['voltage_label']} kV | {best['owner']} | {d.min() / 1000:.2f} km")


def main() -> None:
    raw = load_raw()
    print(f"Raw features: {len(raw['features'])} ({RAW_PATH.stat().st_size / 1e6:.1f} MB at {RAW_PATH})")
    features, stats = build_features(raw, TOLERANCE_M)
    write_geojson(features, OUT_PATH, precision=PRECISION)
    size = OUT_PATH.stat().st_size
    print(f"Wrote {OUT_PATH} ({size / 1e6:.2f} MB, simplify tolerance {TOLERANCE_M:g} m) {stats}")
    if size > MAX_BYTES:
        print(f"WARNING: output exceeds {MAX_BYTES / 1e6:.1f} MB; raise TOLERANCE_M")
    validate(features)


if __name__ == "__main__":
    main()
