"""Build data/explore/substations_ca.geojson from OpenStreetMap power=substation.  OWNER: workstream A.

HIFLD substations are restricted and EIA publishes no substation locations, so OSM (via
Overpass) is the open source. Coverage is volunteer-mapped: large transmission substations
are well covered, but voltage tags are often missing and small distribution substations are
patchy. Service code should surface that gap in a Provenance.

Run from backend/:  .venv/Scripts/python -m app.explore.prepare_substations
Reuses data/explore/raw/osm_substations_ca_bbox.json if present; delete it to refresh.
"""

from __future__ import annotations

import json
import re
import time
from collections import Counter
from pathlib import Path
from typing import Any

import geopandas as gpd
import httpx
import numpy as np
from pyproj import Transformer

from app.explore._prep_utils import CA_ALBERS, OUT_DIR, RAW_DIR, USER_AGENT, WGS84, download, gdf_to_features, write_geojson

OVERPASS_MIRRORS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)
# An area query for California times out on the public servers; a bounding box does not.
CA_BBOX = (32.5, -124.5, 42.05, -114.1)  # south, west, north, east
QUERY = '[out:json][timeout:250];nwr["power"="substation"]({},{},{},{});out center tags;'.format(*CA_BBOX)
RAW_OSM = RAW_DIR / "osm_substations_ca_bbox.json"

STATES_URL = "https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_state_500k.zip"
CA_BUFFER_M = 2000  # keep border substations (e.g. on the Colorado River) that sit just outside the line
NEIGHBOR_STATEFP = ("04", "32", "41")  # AZ, NV, OR
# The buffer must not reach into Mexico (CFE substations in Tijuana and Mexicali): south of this
# latitude, just north of the CA-Mexico line's highest point at the Colorado River, a buffered
# point that is in no US state is dropped.
MEXICO_MAX_LAT = 32.72

OUT_PATH = OUT_DIR / "substations_ca.geojson"
SOURCE = "OpenStreetMap (ODbL)"
OSM_TYPES = {"node": "n", "way": "w", "relation": "r"}
EXCLUDED_TYPES = ("traction", "minor_distribution")  # rail feeders and pole-top/neighbourhood transformers
NON_ELECTRIC_TYPES = ("gas", "compression")  # gas pipeline stations mis-tagged power=substation
MIN_KV, MAX_KV = 1.0, 1200.0

DEMO_SITES = {
    "Kern placeholder": (-119.47, 35.40),
    "Tracy / Tesla": (-121.55, 37.71),
    "Los Banos": (-120.85, 37.06),
}

_VOLT_RE = re.compile(r"^(\d+(?:\.\d+)?)\s*(kv|v)?$")


def parse_voltage_kv(raw: str | None) -> list[float]:
    """OSM `voltage` (volts, ';'- or '/'-separated, often messy) -> unique kV values, highest first.

    "115000;12000" -> [115.0, 12.0]; "230 kV" -> [230.0]; "60000 V" -> [60.0]; "12.47 kV" -> [12.47].
    Plain numbers <= 1000 are ambiguous (volts or kV?) and dropped, as is junk like "medium".
    """
    if not raw:
        return []
    out: set[float] = set()
    for part in re.split(r"[;/]", str(raw)):
        m = _VOLT_RE.match(part.strip().lower().replace(",", ""))
        if not m:
            continue
        value, unit = float(m.group(1)), m.group(2)
        if unit == "kv":
            kv = value
        elif unit == "v" or value > 1000:
            kv = value / 1000
        else:
            continue
        if MIN_KV <= kv <= MAX_KV:
            out.add(round(kv, 3))
    return sorted(out, reverse=True)


def fetch_overpass(dest: Path = RAW_OSM, *, rounds: int = 2) -> dict[str, Any]:
    """POST the bbox query to Overpass (mirrors in turn) and cache the raw JSON at dest."""
    if dest.exists() and dest.stat().st_size > 0:
        return json.loads(dest.read_text(encoding="utf-8"))
    errors: list[str] = []
    for attempt in range(rounds):
        for url in OVERPASS_MIRRORS:
            try:
                r = httpx.post(url, data={"data": QUERY}, headers={"User-Agent": USER_AGENT}, timeout=300)
                r.raise_for_status()
                payload = r.json()
                remark = str(payload.get("remark") or "")
                if "error" in remark.lower():  # Overpass reports timeouts as 200 + partial result + remark
                    raise RuntimeError(remark)
                if not payload.get("elements"):
                    raise RuntimeError("empty result")
            except (httpx.HTTPError, ValueError, RuntimeError) as exc:
                errors.append(f"{url}: {type(exc).__name__}: {exc}"[:300])
                print(f"  Overpass failed: {errors[-1]}")
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_suffix(".json.part")
            tmp.write_bytes(r.content)
            tmp.replace(dest)
            return payload
        if attempt < rounds - 1:
            time.sleep(30)
    raise RuntimeError("All Overpass mirrors failed:\n" + "\n".join(errors))


def california_mask(buffer_m: float = CA_BUFFER_M) -> tuple[Any, Any]:
    """(California buffered by buffer_m, California + AZ/NV/OR unbuffered), Census cartographic
    boundaries 2023, in EPSG:3310."""
    states = gpd.read_file(download(STATES_URL, RAW_DIR / "cb_2023_us_state_500k.zip")).to_crs(CA_ALBERS)
    ca = states[states["STATEFP"] == "06"]
    if ca.empty:
        raise RuntimeError("STATEFP 06 not found in the Census states file")
    us = states[states["STATEFP"].isin(("06", *NEIGHBOR_STATEFP))]
    return ca.geometry.union_all().buffer(buffer_m), us.geometry.union_all()


def _exclusion_reason(tags: dict[str, str]) -> str | None:
    kind = tags.get("substation")
    if kind in EXCLUDED_TYPES:
        return f"substation={kind}"
    if tags.get("disused") == "yes" or tags.get("abandoned") == "yes":
        return "disused/abandoned"
    # Pad-mount transformers: their "voltage" is usually the kVA rating (500000 = 500 kVA), which
    # would otherwise show up as fake 500 kV substations.
    if tags.get("man_made") == "street_cabinet":
        return "street_cabinet"
    if kind in NON_ELECTRIC_TYPES or tags.get("pipeline") == "substation":
        return "gas station"
    return None


def _display_name(tags: dict[str, str]) -> str:
    name = (tags.get("name") or "").strip()
    if name:
        return name
    base = (tags.get("ref") or "").strip() or "Unnamed substation"
    operator = (tags.get("operator") or "").strip()
    return f"{base} ({operator})" if operator else base


def build_rows(raw: dict[str, Any]) -> tuple[list[dict[str, Any]], Counter[str]]:
    """Overpass elements -> property rows with lon/lat, plus counts of what was dropped and why."""
    timestamp = (raw.get("osm3s") or {}).get("timestamp_osm_base")
    rows: list[dict[str, Any]] = []
    dropped: Counter[str] = Counter()
    for el in raw.get("elements", []):
        tags = el.get("tags") or {}
        reason = _exclusion_reason(tags)
        if reason:
            dropped[reason] += 1
            continue
        where = el if el["type"] == "node" else (el.get("center") or {})
        lon, lat = where.get("lon"), where.get("lat")
        if lon is None or lat is None:
            dropped["no coordinates"] += 1
            continue
        voltages = parse_voltage_kv(tags.get("voltage"))
        # A bare node (no name, ref, operator or substation type) with a voltage is most likely a
        # transformer whose kVA rating went into `voltage`, like the street cabinets above (a lone
        # "500000" node in downtown Redding). Keep the point but not the voltage.
        if el["type"] == "node" and not any((tags.get(k) or "").strip() for k in ("name", "ref", "operator", "substation")):
            if voltages:
                dropped["voltage of bare node (kept, voltage nulled)"] += 1
            voltages = []
        rows.append(
            {
                "id": f"osm-{OSM_TYPES[el['type']]}{el['id']}",
                "name": _display_name(tags),
                "named": bool((tags.get("name") or "").strip()),
                "voltage_kv": voltages[0] if voltages else None,
                "voltages_kv": voltages,
                "operator": (tags.get("operator") or "").strip() or None,
                "substation_type": tags.get("substation") or None,
                "osm_url": f"https://www.openstreetmap.org/{el['type']}/{el['id']}",
                "source": SOURCE,
                "osm_timestamp": timestamp,
                "_sort": ("nwr".index(OSM_TYPES[el["type"]]), int(el["id"])),
                "_raw_voltage": tags.get("voltage"),
                "lon": float(lon),
                "lat": float(lat),
            }
        )
    rows.sort(key=lambda r: r["_sort"])
    return rows, dropped


def _voltage_class(kv: float | None) -> str:
    if kv is None:
        return "unknown"
    if kv < 60:
        return "<60 kV"
    if kv < 200:
        return "60-199 kV"
    if kv < 300:
        return "200-299 kV"
    return ">=300 kV"


def _nearest(gdf: gpd.GeoDataFrame, lon: float, lat: float, *, min_kv: float, k: int) -> list[tuple[str, float, float]]:
    """k nearest substations with voltage_kv >= min_kv: (name, kV, km), distances in EPSG:3310."""
    x, y = Transformer.from_crs(WGS84, CA_ALBERS, always_xy=True).transform(lon, lat)
    sub = gdf[gdf["voltage_kv"].fillna(0) >= min_kv]
    d_km = np.hypot(sub.geometry.x - x, sub.geometry.y - y) / 1000
    idx = np.argsort(d_km.to_numpy())[:k]
    return [(sub.iloc[i]["name"], float(sub.iloc[i]["voltage_kv"]), float(d_km.iloc[i])) for i in idx]


def main() -> None:
    raw = fetch_overpass()
    elements = raw.get("elements", [])
    timestamp = (raw.get("osm3s") or {}).get("timestamp_osm_base")
    print(f"Overpass: {len(elements)} elements in bbox, OSM data as of {timestamp}")

    rows, dropped = build_rows(raw)
    gdf = gpd.GeoDataFrame(rows, geometry=gpd.points_from_xy([r["lon"] for r in rows], [r["lat"] for r in rows]), crs=WGS84)
    projected = gdf.to_crs(CA_ALBERS)
    ca_buffered, ca_and_neighbors = california_mask()
    inside = projected.within(ca_buffered).to_numpy()
    mexico = ~projected.within(ca_and_neighbors).to_numpy() & (gdf["lat"].to_numpy() < MEXICO_MAX_LAT)
    dropped["outside CA (+2 km)"] = int((~inside).sum())
    dropped["Mexico (within 2 km of CA)"] = int((inside & mexico).sum())
    for r in gdf[inside & mexico].itertuples():
        print(f"  dropped (Mexico): {r.id} {r.name!r} {r.voltage_kv} kV at ({r.lon:.4f}, {r.lat:.4f})")
    inside &= ~mexico
    projected = projected[inside].reset_index(drop=True)
    kept = gdf[inside].reset_index(drop=True)

    unparsed = Counter(r["_raw_voltage"] for r in kept.to_dict("records") if r["_raw_voltage"] and not r["voltages_kv"])
    out = kept.drop(columns=["_sort", "_raw_voltage", "lon", "lat"])
    features = gdf_to_features(out)
    assert len({f["properties"]["id"] for f in features}) == len(features), "duplicate ids"
    assert all(f["properties"]["name"] for f in features), "empty name"
    write_geojson(features, OUT_PATH)

    n = len(out)
    size_mb = OUT_PATH.stat().st_size / 1e6
    print(f"Wrote {OUT_PATH} ({n} substations, {size_mb:.2f} MB)")
    print("Dropped: " + ", ".join(f"{k}={v}" for k, v in sorted(dropped.items())))
    classes = Counter(_voltage_class(None if np.isnan(v) else v) for v in out["voltage_kv"].astype(float))
    order = ("unknown", "<60 kV", "60-199 kV", "200-299 kV", ">=300 kV")
    print("By voltage class: " + ", ".join(f"{c}={classes.get(c, 0)}" for c in order))
    print(f"Named: {out['named'].mean():.1%}   with voltage: {out['voltage_kv'].notna().mean():.1%}")
    if unparsed:
        print("Voltage tags not parsed (top 10): " + ", ".join(f"{v!r} x{c}" for v, c in unparsed.most_common(10)))

    big = projected[projected["voltage_kv"].fillna(0) >= 500].sort_values(["voltage_kv", "name"], ascending=[False, True])
    print(f">=500 kV substations ({len(big)}):")
    for _, r in big.iterrows():
        print(f"  {r['voltage_kv']:g} kV  {r['name']}  [{r['id']}]")

    for label, (lon, lat) in DEMO_SITES.items():
        (name, kv, km), = _nearest(projected, lon, lat, min_kv=230, k=1)
        print(f"{label} ({lon}, {lat}): nearest >=230 kV = {name} ({kv:g} kV, {km:.1f} km)")
        for name, kv, km in _nearest(projected, lon, lat, min_kv=60, k=3):
            print(f"    >=60 kV: {name} ({kv:g} kV, {km:.1f} km)")

    assert size_mb <= 3, f"output too large: {size_mb:.2f} MB"


if __name__ == "__main__":
    main()
