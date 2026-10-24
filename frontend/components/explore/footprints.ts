// 2.5D asset footprints: each scenario asset drawn as a square of its land area,
// MW x acres/MW (x duration/4 h for batteries) from C's technology catalog (an asset's overrides.land_acres_per_mw wins).
// Assets without a location are laid out schematically east of the site.  OWNER: workstream A.
import { api } from "@/lib/api";
import type { Asset, AssetKind, Catalog, LngLat, TechSpec } from "@/lib/contract";

import { lngLat, num, offsetKm, str } from "./geo";

type FC = GeoJSON.FeatureCollection;

export const KM2_PER_ACRE = 0.00404686;
const MIN_SIDE_KM = 0.12; // smallest displayed square, so a tiny gas or battery pad stays visible (flagged min_display)
const START_EAST_KM = 1.5; // auto layout starts this far east of the site, clear of its marker
const GAP_KM = 0.4;
const ROW_SLACK = 1.2; // row width = 1.2 x sqrt(total area): a roughly square block that keeps small pads beside big ones
export const BATTERY_REF_HOURS = 4; // the catalog's battery land rate is for a 4 h system; Evaluate's BOM scales by duration_h / 4

/** Extrusion heights (m) before the zoom-dependent exaggeration in mapStyle; schematic, for legibility only. */
export const FOOTPRINT_HEIGHT_M: Record<AssetKind, number> = { solar_pv: 20, battery: 40, gas_cc: 60, gas_ct: 60, onshore_wind: 8 };

// One catalog request per page load, shared across remounts; a failure lets the next mount retry.
let catalogPromise: Promise<Catalog> | null = null;
export function loadCatalog(): Promise<Catalog> {
  if (!catalogPromise) {
    const p = api.catalog().then((c) => {
      if (!c || !Array.isArray(c.techs)) throw new Error("/catalog has no techs");
      return c;
    });
    catalogPromise = p;
    p.catch(() => {
      if (catalogPromise === p) catalogPromise = null;
    });
  }
  return catalogPromise;
}

/** The land-use study behind a tech's acres/MW. C's catalog cites it in provenance.note as
 *  "Land <value> <units>: <source> (<url>)."; provenance.source is the ATB cost case, not the land figure. */
export function landCitation(tech: TechSpec | undefined): { source: string; url: string | null } | null {
  const m = /Land\s+[\d.]+\s[^:]*:\s*(.+?)\s*\((https?:\/\/[^\s)]+)\)/.exec(tech?.provenance?.note ?? "");
  return m ? { source: m[1], url: m[2] } : null;
}

interface Item {
  asset: Asset;
  tech: TechSpec | undefined;
  lapm: number;
  fromOverride: boolean;
  hours: number | null; // battery duration (h); null for other kinds
  acres: number;
  areaKm2: number;
  sideKm: number;
  displayKm: number;
}

function sizeOf(a: Asset, techs: Map<AssetKind, TechSpec>): Item | null {
  const cap = num(a.capacity_mw);
  if (cap === null || cap <= 0) return null;
  const tech = techs.get(a.kind);
  const override = num(a.overrides?.land_acres_per_mw);
  const fromOverride = override !== null && override > 0;
  const lapm = fromOverride ? override : num(tech?.land_acres_per_mw);
  if (lapm === null || lapm <= 0) return null;
  // Battery land scales with duration like Evaluate's BOM (bom.py fleet()), so both show the same acres.
  const hours = a.kind === "battery" ? (num(a.duration_h) ?? BATTERY_REF_HOURS) : null;
  const acres = cap * lapm * (hours !== null ? hours / BATTERY_REF_HOURS : 1);
  const areaKm2 = acres * KM2_PER_ACRE;
  const sideKm = Math.sqrt(areaKm2);
  return { asset: a, tech, lapm, fromOverride, hours, acres, areaKm2, sideKm, displayKm: Math.max(sideKm, MIN_SIDE_KM) };
}

/** Square ring of side `sideKm` centred `cx`, `cy` km east/north of `origin`. */
function square(origin: LngLat, cx: number, cy: number, sideKm: number): [number, number][] {
  const h = sideKm / 2;
  return [
    offsetKm(origin, cx - h, cy - h),
    offsetKm(origin, cx + h, cy - h),
    offsetKm(origin, cx + h, cy + h),
    offsetKm(origin, cx - h, cy + h),
    offsetKm(origin, cx - h, cy - h),
  ];
}

/** Shelf layout in km relative to the site: rows left to right, wrapping at a compact width, the
 *  block centred on the site's latitude and starting START_EAST_KM east of it. Scenario order is
 *  kept, so dragging a capacity slider resizes squares instead of reshuffling them. */
function layout(items: Item[]): { cx: number; cy: number }[] {
  if (!items.length) return [];
  const sides = items.map((i) => i.displayKm);
  const total = sides.reduce((s, d) => s + (d + GAP_KM) ** 2, 0);
  const width = Math.max(Math.max(...sides), ROW_SLACK * Math.sqrt(total));
  const rows: number[][] = [[]];
  let x = 0;
  sides.forEach((d, i) => {
    const row = rows[rows.length - 1];
    if (row.length && x + d > width) {
      rows.push([i]);
      x = d + GAP_KM;
    } else {
      row.push(i);
      x += d + GAP_KM;
    }
  });
  const heights = rows.map((r) => Math.max(...r.map((i) => sides[i])));
  const blockH = heights.reduce((s, h) => s + h, 0) + GAP_KM * (rows.length - 1);
  const out: { cx: number; cy: number }[] = new Array(items.length);
  let top = blockH / 2; // y grows north; first row at the top
  rows.forEach((r, ri) => {
    const mid = top - heights[ri] / 2; // squares centred vertically within their row
    let left = START_EAST_KM;
    for (const i of r) {
      out[i] = { cx: left + sides[i] / 2, cy: mid };
      left += sides[i] + GAP_KM;
    }
    top -= heights[ri] + GAP_KM;
  });
  return out;
}

/** One square polygon per sized asset: at asset.location if set, else auto-laid out around the site. */
export function footprintsFC(assets: Asset[] | undefined, site: LngLat | undefined, catalog: Catalog): FC {
  const techs = new Map(catalog.techs.map((t) => [t.kind, t] as const));
  const located: { item: Item; at: LngLat }[] = [];
  const auto: Item[] = [];
  for (const a of assets ?? []) {
    const item = sizeOf(a, techs);
    if (!item) continue;
    const at = lngLat(a.location);
    if (at) located.push({ item, at });
    else if (site) auto.push(item);
  }
  const features: GeoJSON.Feature[] = [];
  const push = (item: Item, ring: [number, number][], placed: "auto" | "located") => {
    const { asset: a, tech } = item;
    const land = item.fromOverride ? null : landCitation(tech);
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [ring] },
      properties: {
        id: `fp-${a.id}`,
        asset_id: a.id,
        name: str(a.name),
        kind: a.kind,
        tech_label: tech?.label ?? null,
        capacity_mw: a.capacity_mw,
        duration_h: item.hours,
        land_acres_per_mw: item.lapm,
        lapm_source: item.fromOverride ? "scenario override" : "Evaluate catalog",
        acres: item.acres,
        area_km2: item.areaKm2,
        side_km: item.sideKm,
        min_display: item.sideKm < MIN_SIDE_KM,
        height_m: FOOTPRINT_HEIGHT_M[a.kind] ?? 20,
        placed,
        source: item.fromOverride ? "Scenario override" : (land?.source ?? "Evaluate catalog land-use assumption"),
        source_url: land?.url ?? null,
      },
    });
  };
  for (const { item, at } of located) push(item, square(at, 0, 0, item.displayKm), "located");
  if (site) {
    layout(auto).forEach((pos, i) => push(auto[i], square(site, pos.cx, pos.cy, auto[i].displayKm), "auto"));
  }
  return { type: "FeatureCollection", features };
}

/** [[west, south], [east, north]] around every footprint plus the site, or null if there is nothing to frame. */
export function footprintBounds(fc: FC, site: LngLat | undefined): [[number, number], [number, number]] | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  const add = (lon: number, lat: number) => {
    w = Math.min(w, lon);
    e = Math.max(e, lon);
    s = Math.min(s, lat);
    n = Math.max(n, lat);
  };
  for (const f of fc.features) {
    if (f.geometry.type !== "Polygon") continue;
    for (const [lon, lat] of f.geometry.coordinates[0]) add(lon, lat);
  }
  if (!Number.isFinite(w)) return null;
  if (site) add(site.lon, site.lat);
  return [
    [w, s],
    [e, n],
  ];
}
