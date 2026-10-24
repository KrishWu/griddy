"""Build the small offline California city/town search index from Census Gazetteer."""
import csv
import io
import json

from app.explore._prep_utils import OUT_DIR, RAW_DIR, download

SOURCE_URL = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_gaz_place_06.txt"


def convert(text: str) -> dict:
    rows = csv.DictReader(io.StringIO(text), delimiter="\t")
    places = []
    for raw in rows:
        row = {k.strip(): v.strip() for k, v in raw.items()}
        lon, lat = float(row["INTPTLONG"]), float(row["INTPTLAT"])
        if row["USPS"] != "CA" or not (-125 < lon < -113 and 32 < lat < 43):
            continue
        places.append({"id": row["GEOID"], "name": row["NAME"], "lon": lon, "lat": lat})
    return {"source": "US Census 2024 Gazetteer, California places", "url": SOURCE_URL, "places": places}


def main():
    raw = download(SOURCE_URL, RAW_DIR / "2024_gaz_place_06.txt")
    data = convert(raw.read_text())
    (OUT_DIR / "places_ca.json").write_text(json.dumps(data, separators=(",", ":")) + "\n")
    print(f"Prepared {len(data['places'])} California places")


if __name__ == "__main__":
    main()
