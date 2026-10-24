"""Build data/explore/plants_ca.geojson from EIA-860 2024 (Plant + Generator files).  OWNER: workstream A.

One point per California plant with operating (Status "OP") generators totalling >= 1 MW:
nameplate MW, a dominant fuel category, the per-fuel MW mix and grid context (BA, voltage,
CAISO LMP node). Features are sorted largest first so small plants draw on top.

Run from backend/:  .venv/Scripts/python -m app.explore.prepare_plants
"""

from __future__ import annotations

import io
import zipfile
from collections import Counter
from pathlib import Path
from typing import Any

import pandas as pd

from app.explore._prep_utils import CA_ALBERS, OUT_DIR, RAW_DIR, WGS84, download, write_geojson

EIA860_URL = "https://www.eia.gov/electricity/data/eia860/archive/xls/eia8602024.zip"
ZIP_PATH = RAW_DIR / "eia8602024.zip"
OUT_PATH = OUT_DIR / "plants_ca.geojson"
SOURCE = "EIA-860 2024"

MIN_MW = 1.0
LON_RANGE = (-124.6, -114.0)
LAT_RANGE = (32.4, 42.1)
DEMO_SITES = {
    "Kern placeholder": (-119.47, 35.40),
    "Tracy/Tesla": (-121.55, 37.71),
    "Los Banos": (-120.85, 37.06),
}

_TECH_FUEL = {
    "Solar Photovoltaic": "solar",
    "Solar Thermal with Energy Storage": "solar",
    "Solar Thermal without Energy Storage": "solar",
    "Onshore Wind Turbine": "wind",
    "Offshore Wind Turbine": "wind",
    "Conventional Hydroelectric": "hydro",
    "Hydroelectric Pumped Storage": "hydro",
    "Geothermal": "geothermal",
    "Batteries": "battery",
    "Nuclear": "nuclear",
}
_ENERGY_SOURCE_FUEL = {"SUN": "solar", "WND": "wind", "NG": "gas", "WAT": "hydro", "GEO": "geothermal", "MWH": "battery", "NUC": "nuclear"}
FUELS = ("solar", "wind", "gas", "hydro", "geothermal", "battery", "nuclear", "other")
# "Grid Voltage (kV)" is self-reported: small plants sometimes enter their service voltage in
# volts (480 = 480 V, not 480 kV). None of these is a US transmission voltage, so divide by 1000.
_VOLTS_IN_KV_FIELD = {208.0, 240.0, 277.0, 416.0, 480.0, 481.0, 600.0}
# The LMP node field is self-reported free text; these entries name no node.
_LMP_PLACEHOLDERS = {"none", "n/a", "na", "null", "unknown", "tbd", "rto/iso lmp", "node", "gen", "caiso", "pg&e", "sce"}


def _text(value: Any) -> str | None:
    """Stripped string, or None for NaN/blank cells."""
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    s = str(value).strip()
    return s or None


def _num(series: pd.Series) -> pd.Series:
    """EIA numeric column -> float (blank ' ' cells and junk become NaN)."""
    return pd.to_numeric(series.map(lambda v: v.strip() if isinstance(v, str) else v), errors="coerce")


def fuel_category(technology: Any, energy_source: Any) -> str:
    """Map an EIA Technology string (fallback: Energy Source 1 code) to one of FUELS."""
    tech = _text(technology)
    if tech:
        if tech.startswith("Natural Gas") or tech == "Other Natural Gas":
            return "gas"
        return _TECH_FUEL.get(tech, "other")
    return _ENERGY_SOURCE_FUEL.get((_text(energy_source) or "").upper(), "other")


def _read_sheet(zf: zipfile.ZipFile, member: str, sheet: str | int = 0) -> pd.DataFrame:
    """Read one EIA sheet (header on row 2) and drop footnote rows (non-numeric Plant Code)."""
    df = pd.read_excel(io.BytesIO(zf.read(member)), sheet_name=sheet, header=1)
    code = _num(df["Plant Code"])
    df = df[code.notna()].copy()
    df["Plant Code"] = code[code.notna()].astype(int)
    return df


def load_eia(zip_path: Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    with zipfile.ZipFile(zip_path) as zf:
        plants = _read_sheet(zf, "2___Plant_Y2024.xlsx")
        gens = _read_sheet(zf, "3_1_Generator_Y2024.xlsx", "Operable")
    return plants, gens


def _mode(values: pd.Series, weights: pd.Series) -> str | None:
    """Most common non-blank value; ties broken by MW, then alphabetically."""
    counts: Counter[str] = Counter()
    mw: Counter[str] = Counter()
    for v, w in zip(values, weights):
        s = _text(v)
        if s:
            counts[s] += 1
            mw[s] += float(w)
    if not counts:
        return None
    return min(counts, key=lambda s: (-counts[s], -mw[s], s))


def _lmp_node(value: Any) -> str | None:
    s = _text(value)
    return None if s is None or s.lower() in _LMP_PLACEHOLDERS else s


def _int_or_none(value: float) -> int | None:
    return None if pd.isna(value) else int(value)


def build_features(plants: pd.DataFrame, gens: pd.DataFrame) -> tuple[list[dict[str, Any]], list[str]]:
    """Aggregate operating CA generators per plant. Returns (features, dropped-plant notes)."""
    ca = plants[plants["State"].map(_text) == "CA"].set_index("Plant Code")
    if not ca.index.is_unique:
        raise ValueError("duplicate Plant Code in EIA-860 plant file")

    op = gens[(gens["Status"].map(_text) == "OP") & gens["Plant Code"].isin(ca.index)].copy()
    op["mw"] = _num(op["Nameplate Capacity (MW)"]).fillna(0.0)
    op["year"] = _num(op["Operating Year"])
    op["fuel"] = [fuel_category(t, e) for t, e in zip(op["Technology"], op["Energy Source 1"])]
    op["tech"] = op["Technology"].map(_text).fillna("Unknown")

    features: list[dict[str, Any]] = []
    dropped: list[str] = []
    lat_all, lon_all = _num(ca["Latitude"]), _num(ca["Longitude"])
    for code, g in op.groupby("Plant Code", sort=True):
        capacity = round(float(g["mw"].sum()), 1)
        if capacity < MIN_MW:
            continue
        row = ca.loc[code]
        name = _text(row["Plant Name"]) or f"EIA plant {code}"
        lon, lat = lon_all.loc[code], lat_all.loc[code]
        if pd.isna(lon) or pd.isna(lat) or not (LON_RANGE[0] <= lon <= LON_RANGE[1] and LAT_RANGE[0] <= lat <= LAT_RANGE[1]):
            dropped.append(f"eia-{code} {name!r} {capacity} MW at ({row['Longitude']!r}, {row['Latitude']!r})")
            continue

        by_fuel = g.groupby("fuel")["mw"].sum()
        # Dominant fuel by MW (ties -> FUELS order); technology = largest Technology within that fuel.
        fuel = max(by_fuel.index, key=lambda f: (by_fuel[f], -FUELS.index(f)))
        by_tech = g[g["fuel"] == fuel].groupby("tech")["mw"].sum()
        technology = min(by_tech.index, key=lambda t: (-by_tech[t], t))
        fuel_mix = {f: round(float(by_fuel[f]), 1) for f in FUELS if f in by_fuel.index and round(float(by_fuel[f]), 1) > 0}
        voltage = _num(pd.Series([row["Grid Voltage (kV)"]])).iloc[0]
        if voltage in _VOLTS_IN_KV_FIELD:
            voltage = voltage / 1000

        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [float(lon), float(lat)]},
                "properties": {
                    "id": f"eia-{code}",
                    "name": name,
                    "fuel": fuel,
                    "capacity_mw": capacity,
                    "fuel_mix": fuel_mix,
                    "technology": technology,
                    "operator": _text(row["Utility Name"]),
                    "plant_code": int(code),
                    "county": _text(row["County"]),
                    "balancing_authority": _text(row["Balancing Authority Code"]),
                    "grid_voltage_kv": float(voltage) if pd.notna(voltage) and voltage > 0 else None,
                    "lmp_node": _mode(g["RTO/ISO LMP Node Designation"].map(_lmp_node), g["mw"]),
                    "n_generators": int(len(g)),
                    "first_year": _int_or_none(g["year"].min()),
                    "last_year": _int_or_none(g["year"].max()),
                    "status": "operating",
                    "source": SOURCE,
                },
            }
        )
    features.sort(key=lambda f: (-f["properties"]["capacity_mw"], f["properties"]["plant_code"]))
    return features, dropped


def _plants_near(features: list[dict[str, Any]], radius_km: float = 25.0) -> dict[str, tuple[int, float]]:
    """(count, MW) of plants within radius_km of each demo site, measured in California Albers."""
    import geopandas as gpd
    from shapely.geometry import Point

    pts = gpd.GeoSeries([Point(f["geometry"]["coordinates"]) for f in features], crs=WGS84).to_crs(CA_ALBERS)
    mw = pd.Series([f["properties"]["capacity_mw"] for f in features])
    out = {}
    for label, (lon, lat) in DEMO_SITES.items():
        site = gpd.GeoSeries([Point(lon, lat)], crs=WGS84).to_crs(CA_ALBERS).iloc[0]
        near = pts.distance(site) <= radius_km * 1000
        out[label] = (int(near.sum()), float(mw[near.values].sum()))
    return out


def main() -> None:
    download(EIA860_URL, ZIP_PATH)
    plants, gens = load_eia(ZIP_PATH)
    features, dropped = build_features(plants, gens)
    write_geojson(features, OUT_PATH)

    props = [f["properties"] for f in features]
    mix_total = Counter[str]()
    dominant = Counter[str]()
    for p in props:
        mix_total.update(p["fuel_mix"])
        dominant[p["fuel"]] += 1
    total = sum(p["capacity_mw"] for p in props)
    print(f"{SOURCE}: {len(features)} CA operating plants >= {MIN_MW} MW, {total / 1000:,.1f} GW nameplate")
    print(f"dropped for bad/out-of-range coords: {len(dropped)}")
    for d in dropped:
        print(f"  {d}")
    print("MW by fuel (generator-level mix) | plants by dominant fuel:")
    for fuel in FUELS:
        print(f"  {fuel:<10} {mix_total.get(fuel, 0.0):>9,.1f} MW | {dominant.get(fuel, 0):>4} plants")
    print("top 10 plants:")
    for p in props[:10]:
        print(f"  {p['capacity_mw']:>8,.1f} MW  {p['fuel']:<8} {p['name']} ({p['county']}, {p['id']})")
    print("plants within 25 km:")
    for label, (n, mw) in _plants_near(features).items():
        print(f"  {label:<17} {n:>3} plants, {mw:,.0f} MW")
    print(
        f"null fields: county {sum(p['county'] is None for p in props)}, BA {sum(p['balancing_authority'] is None for p in props)}, "
        f"grid_voltage_kv {sum(p['grid_voltage_kv'] is None for p in props)}, lmp_node {sum(p['lmp_node'] is None for p in props)}"
    )
    print(f"wrote {OUT_PATH} ({OUT_PATH.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
