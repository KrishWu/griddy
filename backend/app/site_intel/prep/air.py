"""Build the committed air-quality data in data/site_intel/.  OWNER: workstream E.

nonattainment_ca.geojson   EPA Green Book nonattainment areas in California (8-hour ozone
                           2015 + 2008, PM2.5 2012 + 2006), with each area's classification.
airnow_snapshot.json       California monitors from AirNow's public hourly file (no key
                           needed): the offline fallback for "current AQI near the site".
                           Rerun shortly before the demo for a fresh daytime snapshot.

From backend/:  .venv/bin/python -m app.site_intel.prep.air [--skip-greenbook]
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import zipfile
from datetime import datetime, timedelta, timezone

import httpx
import shapefile
from shapely.geometry import mapping, shape

from app.site_intel.config import DATA, RAW

GREENBOOK = "https://www3.epa.gov/airquality/greenbook/shapefile/{std}_{kind}.zip"
STANDARDS = {  # Green Book file stem -> (pollutant, NAAQS label)
    "ozone_8hr_2015std": ("Ozone", "2015 8-hour ozone"),
    "ozone_8hr_2008std": ("Ozone", "2008 8-hour ozone"),
    "pm25_2012std": ("PM2.5", "2012 annual PM2.5"),
    "pm25_2006std": ("PM2.5", "2006 24-hour PM2.5"),
}
AIRNOW_FILE = "https://files.airnowtech.org/airnow/{y}/{d}/HourlyAQObs_{ts}.dat"
UA = {"User-Agent": "Griddy-hackathon/0.1"}
SIMPLIFY_DEG = 0.003  # ~300 m: plenty for point-in-polygon at site scale


def _download(url: str) -> bytes:
    path = RAW / "greenbook" / url.rsplit("/", 1)[1]
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        r = httpx.get(url, headers=UA, timeout=180, follow_redirects=True)
        r.raise_for_status()
        path.write_bytes(r.content)
    return path.read_bytes()


def _reader(zip_bytes: bytes, ext: str) -> shapefile.Reader:
    z = zipfile.ZipFile(io.BytesIO(zip_bytes))
    names = {n.lower().rsplit(".", 1)[1]: n for n in z.namelist() if "." in n and not n.lower().endswith(".xml")}
    if ext == "dbf":
        return shapefile.Reader(dbf=io.BytesIO(z.read(names["dbf"])))
    return shapefile.Reader(shp=io.BytesIO(z.read(names["shp"])), shx=io.BytesIO(z.read(names["shx"])), dbf=io.BytesIO(z.read(names["dbf"])))


def build_nonattainment() -> dict:
    features = []
    report_date = None
    for std, (pollutant, naaqs) in STANDARDS.items():
        # Area attributes (class, status) live in the "external files"; geometry in the shapefile. Join on COMPOSID.
        ext = _reader(_download(GREENBOOK.format(std=std, kind="external_files")), "dbf")
        fields = [f[0].upper() for f in ext.fields[1:]]
        attrs = {}
        for rec in ext.iterRecords():
            d = dict(zip(fields, rec))
            attrs[str(d["COMPOSID"]).strip().lower()] = d
            report_date = report_date or d.get("RPTDATE")
        shp = _reader(_download(GREENBOOK.format(std=std, kind="naa_shapefile")), "shp")
        sfields = [f[0].upper() for f in shp.fields[1:]]
        for sr in shp.iterShapeRecords():
            d = dict(zip(sfields, sr.record))
            a = attrs.get(str(d.get("COMPOSID", "")).strip().lower())
            name = str(d.get("AREA_NAME", ""))
            # Current nonattainment only: N (maintenance areas are M), standard not revoked.
            if not name.endswith(", CA") or a is None or a.get("NAASTATUS") != "N" or a.get("REVOKED_ST"):
                continue
            # The 2012 PM2.5 shapefile is NAD83; at this simplification (~300 m) its <2 m datum shift is moot.
            geom = shape(sr.shape.__geo_interface__).buffer(0).simplify(SIMPLIFY_DEG, preserve_topology=True)
            if geom.is_empty:
                continue
            features.append(
                {
                    "type": "Feature",
                    "geometry": json.loads(json.dumps(mapping(geom)), parse_float=lambda s: round(float(s), 4)),
                    "properties": {
                        "pollutant": pollutant,
                        "naaqs": naaqs,
                        "area": str(a.get("AREA_NAME") or name).strip(),
                        "classification": (str(a.get("CLASS") or "").strip() or None),
                        "status": "Nonattainment",
                    },
                }
            )
    return {
        "type": "FeatureCollection",
        "source": "EPA Green Book GIS download (nonattainment areas + external attribute files)",
        "url": "https://www.epa.gov/green-book/green-book-gis-download",
        "report_date": report_date.isoformat() if report_date else None,
        "features": features,
    }


def _num(v: str) -> int | None:
    try:
        return int(round(float(v)))
    except ValueError:
        return None


def build_airnow_snapshot(max_hours_back: int = 6) -> dict:
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    for h in range(max_hours_back):
        t = now - timedelta(hours=h)
        ts = t.strftime("%Y%m%d%H")
        url = AIRNOW_FILE.format(y=t.year, d=ts[:8], ts=ts)
        r = httpx.get(url, headers=UA, timeout=60)
        if r.status_code == 200:
            break
    else:
        raise SystemExit("no AirNow hourly file found in the last few hours")
    monitors = []
    for row in csv.DictReader(io.StringIO(r.text)):
        if row["CountryCode"] != "US" or row["StateName"] != "CA" or row["Status"] != "Active":
            continue
        aqi = {p: v for p, col in (("OZONE", "OZONE_AQI"), ("PM2.5", "PM25_AQI"), ("PM10", "PM10_AQI"), ("NO2", "NO2_AQI")) if (v := _num(row[col])) is not None}
        if not aqi:
            continue
        valid = datetime.strptime(f"{row['ValidDate']} {row['ValidTime']}", "%m/%d/%Y %H:%M")  # UTC in this file
        monitors.append(
            {
                "site_name": row["SiteName"],
                "aqsid": row["AQSID"],
                "lat": round(float(row["Latitude"]), 5),
                "lon": round(float(row["Longitude"]), 5),
                "reporting_area": row["ReportingArea_PipeDelimited"].split("|")[0] or None,
                "valid_utc": valid.strftime("%Y-%m-%dT%H:%MZ"),
                "aqi": aqi,
            }
        )
    return {"captured_utc": t.strftime("%Y-%m-%dT%H:%MZ"), "source": "AirNow hourly observations (public file share)", "url": url, "monitors": monitors}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--skip-greenbook", action="store_true", help="only refresh the AirNow snapshot")
    args = ap.parse_args()
    DATA.mkdir(parents=True, exist_ok=True)
    if not args.skip_greenbook:
        fc = build_nonattainment()
        path = DATA / "nonattainment_ca.geojson"
        path.write_text(json.dumps(fc, separators=(",", ":")), encoding="utf-8")
        areas = sorted({(f["properties"]["naaqs"], f["properties"]["area"], f["properties"]["classification"]) for f in fc["features"]})
        print(f"{path.name}: {len(fc['features'])} features, {path.stat().st_size / 1024:.0f} KB, report date {fc['report_date']}")
        for a in areas:
            print("   ", a)
    snap = build_airnow_snapshot()
    path = DATA / "airnow_snapshot.json"
    path.write_text(json.dumps(snap, separators=(",", ":")), encoding="utf-8")
    print(f"{path.name}: {len(snap['monitors'])} CA monitors at {snap['captured_utc']}, {path.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
