"""Download the offline satellite tiles for a demo site into data/site_intel/tiles/.  OWNER: workstream E.

Renders the live layer (imagery._live_map_id: the same composite, box and stretch) once
through Earth Engine and saves its XYZ tiles, so the cached overlay looks exactly like
the live one. Sentinel-2 is Copernicus open data, fine to commit (Planet never is).
Tiles are palette-quantized PNGs to stay inside the repo's ~10 MB budget.

From backend/:  .venv/bin/python -m app.site_intel.prep.imagery --site kern [--zmin 12 --zmax 16]
"""

from __future__ import annotations

import argparse
import io
import json
import shutil
from concurrent.futures import ThreadPoolExecutor
from datetime import date

import httpx
from PIL import Image

from app.site_intel import earthengine
from app.site_intel.config import DEMO_SITES, TILES
from app.site_intel.geo import lonlat_to_tile
from app.site_intel.imagery import ATTRIBUTION_CACHED, EE_URL, HALF_KM, S2_COLLECTION, SEASON, STYLE, _live_map_id, site_box


def tiles_in_box(box: tuple[float, float, float, float], zmin: int, zmax: int) -> list[tuple[int, int, int]]:
    w, s, e, n = box
    out = []
    for z in range(zmin, zmax + 1):
        x0, y0 = lonlat_to_tile(w, n, z)
        x1, y1 = lonlat_to_tile(e, s, z)
        out += [(z, x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    return out


def shrink(png: bytes) -> bytes | None:
    """Palette-quantize (keeping transparency); None for a fully transparent tile."""
    img = Image.open(io.BytesIO(png)).convert("RGBA")
    if img.getchannel("A").getextrema()[1] == 0:
        return None
    buf = io.BytesIO()
    img.quantize(colors=256, method=Image.Quantize.FASTOCTREE).save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site", default="kern", choices=list(DEMO_SITES))
    ap.add_argument("--zmin", type=int, default=12)
    ap.add_argument("--zmax", type=int, default=16)
    args = ap.parse_args()
    ee = earthengine.get_ee()
    if ee is None:
        raise SystemExit("Earth Engine unavailable: set EE_PROJECT and run `python -m app.site_intel.earthengine`")

    box = site_box(DEMO_SITES[args.site]["location"], HALF_KM)
    url = _live_map_id(ee, box)["tile_fetcher"].url_format
    tiles = tiles_in_box(box, args.zmin, args.zmax)
    shutil.rmtree(TILES, ignore_errors=True)  # stale tiles from another site would be served otherwise

    def fetch(t: tuple[int, int, int]) -> int:
        z, x, y = t
        r = httpx.get(url.format(z=z, x=x, y=y), timeout=60)
        r.raise_for_status()
        png = shrink(r.content)
        if png is None:
            return 0
        path = TILES / str(z) / str(x) / f"{y}.png"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(png)
        return len(png)

    with ThreadPoolExecutor(8) as pool:
        sizes = list(pool.map(fetch, tiles))
    meta = {
        "site": args.site,
        "bounds": list(box),
        "minzoom": args.zmin,
        "maxzoom": args.zmax,
        "source": f"Copernicus Sentinel-2 L2A {SEASON[0][:4]} median composite (Google Earth Engine {S2_COLLECTION})",
        "url": EE_URL,
        "style": STYLE,
        "season": list(SEASON),
        "attribution": ATTRIBUTION_CACHED,
        "license": "Copernicus Sentinel data terms (free and open)",
        "captured": date.today().isoformat(),
    }
    (TILES / "meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    kept = [s for s in sizes if s]
    print(f"{args.site}: {len(kept)}/{len(tiles)} tiles (z{args.zmin}-{args.zmax}), {sum(kept) / 1e6:.1f} MB -> {TILES}")


if __name__ == "__main__":
    main()
