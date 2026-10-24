"""Offline California place, county, plant, substation and coordinate search."""
from functools import lru_cache
import json
import math
import re
import unicodedata

from shapely.geometry import shape

from app import DATA_DIR
from app.explore.service import get_layer


def normalize(text: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()).split())


@lru_cache(maxsize=1)
def search_index() -> tuple:
    entries = []
    try:
        data = json.loads((DATA_DIR / "explore" / "places_ca.json").read_text())
        for p in data["places"]:
            name = re.sub(r" (city|town|CDP)$", "", p["name"])
            entries.append({"id": f"place-{p['id']}", "name": name, "kind": "Place", "location": {"lon": p["lon"], "lat": p["lat"]}, "source": data["source"]})
    except (OSError, ValueError, KeyError):
        pass
    for layer, kind in (("boundaries", "County"), ("plants", "Power plant"), ("substations", "Substation")):
        for i, f in enumerate(get_layer(layer)["features"]):
            p = f.get("properties") or {}
            name = p.get("name") or p.get("NAME")
            if not name or "unnamed" in str(name).lower():
                continue
            geom = shape(f["geometry"])
            point = geom.representative_point()
            row = {"id": f"{layer}-{i}", "name": str(name) + (" County" if kind == "County" and "county" not in str(name).lower() else ""),
                "kind": kind, "location": {"lon": point.x, "lat": point.y}, "source": p.get("source", "Bundled California grid layers")}
            if kind == "County":
                row["bounds"] = list(geom.bounds)
            entries.append(row)
    return tuple((normalize(e["name"]), e) for e in entries)


def search_places(query: str) -> dict:
    query = query.strip()
    if not 2 <= len(query) <= 120:
        raise ValueError("Enter 2–120 characters.")
    coords = re.fullmatch(r"\s*([-+]?\d+(?:\.\d+)?)\s*,\s*([-+]?\d+(?:\.\d+)?)\s*", query)
    if coords:
        lat, lon = map(float, coords.groups())
        if not (math.isfinite(lat) and math.isfinite(lon) and 32 <= lat <= 43 and -125 <= lon <= -113):
            raise ValueError("Use California coordinates in latitude, longitude order.")
        return {"results": [{"id": "coordinates", "name": f"{lat:.5f}, {lon:.5f}", "kind": "Coordinates", "location": {"lat": lat, "lon": lon}, "source": "Entered coordinates"}]}
    needle = normalize(query)
    if not needle:
        return {"results": []}
    matches = [(0 if name == needle else 1 if name.startswith(needle) else 2, 0 if e["kind"] in ("Place", "County") else 1, len(name), e)
        for name, e in search_index() if all(word in name for word in needle.split())]
    matches.sort(key=lambda row: row[:3])
    return {"results": [r[3] for r in matches[:8]], "attribution": "US Census Gazetteer 2024; bundled EIA/CEC/OSM grid layers. California only; no street-address lookup."}
