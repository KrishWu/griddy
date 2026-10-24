// MapLibre sources + layers for the Explore map (render order, paint expressions,
// fallback basemap).  OWNER: workstream A.
// Types only from maplibre-gl here: the runtime is imported dynamically inside MapView.
import { STAR_ICON_PREFIX } from "./recommendationStars";
import type { AddLayerObject, MapOptions } from "maplibre-gl";

import {
  ASSET_FUEL,
  ASSET_STROKE,
  ATTRIBUTION,
  CONTEXT_COLOR,
  DEMAND_FILL_OPACITY,
  DEMAND_RAMP,
  FUEL_COLOR,
  FUELS,
  QUEUE_FILL_OPACITY,
  QUEUE_RAMP,
  SITE_COLOR,
  UNKNOWN_VOLTAGE,
  UTILITY_TYPE_COLOR,
  VOLTAGE_CLASSES,
} from "./palette";

type CircleLayer = Extract<AddLayerObject, { type: "circle" }>;
type LineLayer = Extract<AddLayerObject, { type: "line" }>;
type FillLayer = Extract<AddLayerObject, { type: "fill" }>;
type SymbolLayer = Extract<AddLayerObject, { type: "symbol" }>;
type FillExtrusionLayer = Extract<AddLayerObject, { type: "fill-extrusion" }>;
export type LayerSpec = CircleLayer | LineLayer | FillLayer | SymbolLayer | FillExtrusionLayer;
/** MapLibre's ExpressionSpecification (not re-exported by maplibre-gl). */
export type Expr = Extract<NonNullable<NonNullable<CircleLayer["paint"]>["circle-radius"]>, unknown[]>;
export type StyleSpec = Exclude<MapOptions["style"], string | undefined>;

export const BASEMAP = "https://tiles.openfreemap.org/styles/positron";

/** Same content as data/explore/basemap_fallback.json; used if that endpoint is unreachable too. */
export const INLINE_FALLBACK_STYLE: StyleSpec = {
  version: 8,
  name: "GridForge fallback",
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#F2F3F0" } }],
};

/** GeoJSON layers fetched from /api/layers/{key}; each key is also its MapLibre source id. */
export const DATA_KEYS = ["plants", "transmission", "substations", "boundaries", "utilities"] as const;
export type DataKey = (typeof DATA_KEYS)[number];

/** Sources we compute client-side. */
export const LOCAL_SOURCES = ["site-context", "assets", "site", "footprints", "rec-sites"] as const;
export type LocalSource = (typeof LOCAL_SOURCES)[number];

/** Toggleable groups (checkboxes) -> their layer ids. */
export type LayerGroup = "plants" | "transmission" | "substations" | "boundaries" | "utilities" | "queue" | "demand" | "sites" | "footprints";
export const GROUP_LABEL: Record<LayerGroup, string> = {
  plants: "Power plants",
  transmission: "Transmission lines",
  substations: "Substations",
  boundaries: "Counties",
  utilities: "Utility territories",
  queue: "Interconnection queue",
  demand: "Demand growth (forecast)",
  sites: "Recommended sites",
  footprints: "Asset footprints (2.5D)",
};
export const DEFAULT_VISIBLE: Record<LayerGroup, boolean> = {
  plants: true,
  transmission: true,
  substations: true,
  boundaries: true,
  utilities: false,
  queue: false,
  demand: false,
  sites: true,
  footprints: false,
};
/** County choropleths that would hide each other: turning one on turns the other off. */
export const EXCLUSIVE_GROUPS: Partial<Record<LayerGroup, LayerGroup>> = { queue: "demand", demand: "queue" };

const KV: Expr = ["to-number", ["get", "voltage_kv"], 0];
const CAP: Expr = ["max", ["to-number", ["get", "capacity_mw"], 0], 0];

/** Voltage-class color; unknown/zero voltage is gray. Thresholds match palette.VOLTAGE_CLASSES. */
const VOLTAGE_COLOR: Expr = [
  "case",
  [">", KV, 0],
  ["step", KV, color("69"), 100, color("115"), 200, color("230"), 300, color("345"), 400, color("500")],
  UNKNOWN_VOLTAGE.color,
];

function color(id: string): string {
  return VOLTAGE_CLASSES.find((c) => c.id === id)?.color ?? UNKNOWN_VOLTAGE.color;
}

/** ["match", ["get", prop], k1, v1, k2, v2, ..., fallback] built from a lookup table. */
function matchColor(prop: string, table: [string, string][], fallback: string): Expr {
  // A spread can't satisfy MapLibre's tuple type; the shape is correct by construction.
  return ["match", ["get", prop], ...table.flat(), fallback] as unknown as Expr;
}

const FUEL_MATCH = matchColor(
  "fuel",
  FUELS.filter((f) => f !== "other").map((f) => [f, FUEL_COLOR[f]]),
  FUEL_COLOR.other,
);

/** Radius per voltage class (unknown = smallest), scaled by `k`. */
function subRadius(k: number): Expr {
  return ["step", KV, 1.6 * k, 100, 2.1 * k, 200, 2.8 * k, 300, 3.2 * k, 400, 3.6 * k];
}

/** Line width grows with voltage (continuous) and with zoom. */
function lineWidth(lo: number, mid: number, hi: number): Expr {
  return ["interpolate", ["linear"], KV, 60, lo, 230, mid, 500, hi];
}

const lineWidthByZoom: Expr = ["interpolate", ["linear"], ["zoom"], 4, lineWidth(0.3, 0.8, 1.5), 8, lineWidth(0.6, 1.6, 2.8), 12, lineWidth(1.2, 3, 5)];

const ASSET_COLOR = matchColor(
  "kind",
  Object.entries(ASSET_FUEL).map(([kind, fuel]) => [kind, FUEL_COLOR[fuel]]),
  FUEL_COLOR.other,
);

/** Active requested MW per county (properties added by the backend from LBNL Queued Up; absent -> 0). */
const QUEUE_MW: Expr = ["to-number", ["get", "queue_active_mw"], 0];
const QUEUE_COLOR = ["interpolate", ["linear"], QUEUE_MW, ...QUEUE_RAMP.flat()] as unknown as Expr;

/** Footprint heights are schematic: height_m (solar 20, battery 40, gas 60, wind 8) times an
 *  exaggeration that doubles per zoom level out, so blocks keep a legible on-screen height
 *  (solar about 12 px) at the zoom that frames a whole portfolio; close to true heights from zoom 16. */
const FOOTPRINT_EXAGGERATION_Z10 = 75;
const FOOTPRINT_H: Expr = ["to-number", ["get", "height_m"], 20];
const FOOTPRINT_HEIGHT = [
  "interpolate",
  ["linear"],
  ["zoom"],
  ...[4, 6, 8, 10, 12, 14, 16].flatMap((z) => [z, ["*", FOOTPRINT_H, Math.max(1, FOOTPRINT_EXAGGERATION_Z10 * 2 ** (10 - z))]]),
] as unknown as Expr;
export const FOOTPRINT_OPACITY = 0.75;

/** Recommended-site markers: area ~ MW, growing with zoom. */
const REC_MW: Expr = ["max", ["to-number", ["get", "mw"], 0], 0];
/** ["zoom"] must stay the input of the top-level interpolate, so capacity scaling stays inside each stop. */
function recStarSize(): Expr {
  return ["interpolate", ["linear"], ["zoom"], 4, ["/", ["+", 3, ["*", 0.12, ["sqrt", REC_MW]]], 12], 10, ["/", ["+", 5, ["*", 0.25, ["sqrt", REC_MW]]], 12]] as unknown as Expr;
}
export const FOOTPRINT_WIND_OPACITY = 0.35; // wind "land" is turbine spacing; most of it stays usable

/** Our layers, bottom -> top. Overlays from other modules are inserted below the first of these. */
export interface MapLayer {
  spec: LayerSpec;
  group?: LayerGroup;
  clickable?: boolean;
}

export const LAYERS: MapLayer[] = [
  {
    group: "utilities",
    clickable: true,
    spec: {
      id: "utilities-fill",
      type: "fill",
      source: "utilities",
      paint: {
        "fill-color": ["match", ["get", "utility_type"], "IOU", UTILITY_TYPE_COLOR.IOU, "POU", UTILITY_TYPE_COLOR.POU, "#94A3B8"],
        "fill-opacity": 0.08,
      },
    },
  },
  {
    // Above the utility fill, below every grid line / point layer; county outlines stay on top.
    group: "queue",
    clickable: true,
    spec: {
      id: "queue-fill",
      type: "fill",
      source: "boundaries",
      paint: {
        "fill-color": QUEUE_COLOR,
        "fill-opacity": ["case", [">", QUEUE_MW, 0], QUEUE_FILL_OPACITY, 0],
      },
    },
  },
  {
    // Forecast demand growth per county; MapView sets the color per geoid (demandPaint) as the forecast changes.
    group: "demand",
    clickable: true,
    spec: {
      id: "demand-fill",
      type: "fill",
      source: "boundaries",
      paint: { "fill-color": DEMAND_RAMP[0][1], "fill-opacity": 0 },
    },
  },
  {
    group: "utilities",
    spec: {
      id: "utilities-line",
      type: "line",
      source: "utilities",
      paint: {
        "line-color": ["match", ["get", "utility_type"], "IOU", UTILITY_TYPE_COLOR.IOU, "POU", UTILITY_TYPE_COLOR.POU, "#94A3B8"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.6, 10, 1.4],
        "line-opacity": 0.55,
      },
    },
  },
  {
    group: "boundaries",
    spec: {
      id: "counties",
      type: "line",
      source: "boundaries",
      paint: {
        "line-color": "#94A3B8",
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.4, 10, 1.2],
        "line-opacity": 0.75,
      },
    },
  },
  {
    group: "transmission",
    clickable: true,
    spec: {
      id: "transmission-planned",
      type: "line",
      source: "transmission",
      filter: ["==", ["get", "operational"], false],
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: {
        "line-color": VOLTAGE_COLOR,
        "line-width": lineWidthByZoom,
        "line-opacity": 0.55,
        "line-dasharray": [2, 2],
      },
    },
  },
  {
    group: "transmission",
    clickable: true,
    spec: {
      id: "transmission",
      type: "line",
      source: "transmission",
      filter: ["!=", ["get", "operational"], false],
      layout: { "line-cap": "round", "line-join": "round", "line-sort-key": KV },
      paint: {
        "line-color": VOLTAGE_COLOR,
        "line-width": lineWidthByZoom,
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 4, ["step", KV, 0.5, 200, 0.9], 8, ["step", KV, 0.85, 200, 0.95]],
      },
    },
  },
  {
    group: "substations",
    clickable: true,
    spec: {
      // < 115 kV and unknown voltage: only from zoom 8 (1,800 of ~3,500 OSM substations lack a voltage tag).
      id: "substations-minor",
      type: "circle",
      source: "substations",
      minzoom: 8,
      filter: ["<", KV, 115],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, subRadius(1.1), 13, subRadius(2)],
        "circle-color": "#FFFFFF",
        "circle-stroke-color": VOLTAGE_COLOR,
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 8, 1.2, 13, 2],
      },
    },
  },
  {
    group: "substations",
    clickable: true,
    spec: {
      id: "substations-major",
      type: "circle",
      source: "substations",
      filter: [">=", KV, 115],
      layout: { "circle-sort-key": KV },
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, subRadius(0.8), 8, subRadius(1.1), 13, subRadius(2)],
        "circle-color": "#FFFFFF",
        "circle-stroke-color": VOLTAGE_COLOR,
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 4, 1, 8, 1.5, 13, 2.2],
      },
    },
  },
  {
    group: "plants",
    clickable: true,
    spec: {
      id: "plants-major",
      type: "circle",
      source: "plants",
      filter: [">=", CAP, 20],
      layout: { "circle-sort-key": ["-", 0, CAP] }, // small on top of large, so both stay clickable
      paint: plantPaint(),
    },
  },
  {
    group: "plants",
    clickable: true,
    spec: {
      // Plants under 20 MW (about 60% of the count, a few % of the MW): only from zoom 7.
      id: "plants-minor",
      type: "circle",
      source: "plants",
      minzoom: 7,
      filter: ["<", CAP, 20],
      paint: plantPaint(),
    },
  },
  {
    spec: {
      id: "site-ring",
      type: "line",
      source: "site-context",
      filter: ["==", ["get", "kind"], "ring"],
      paint: { "line-color": CONTEXT_COLOR, "line-width": 1.2, "line-opacity": 0.6, "line-dasharray": [3, 2] },
    },
  },
  {
    spec: {
      id: "site-links",
      type: "line",
      source: "site-context",
      filter: ["==", ["get", "kind"], "link"],
      layout: { "line-cap": "butt" },
      paint: { "line-color": CONTEXT_COLOR, "line-width": 1.8, "line-opacity": 0.9, "line-dasharray": [1.5, 1.5] },
    },
  },
  {
    group: "footprints",
    clickable: true,
    spec: {
      id: "footprints-wind",
      type: "fill-extrusion",
      source: "footprints",
      filter: ["==", ["get", "kind"], "onshore_wind"],
      paint: { "fill-extrusion-color": ASSET_COLOR, "fill-extrusion-height": FOOTPRINT_HEIGHT, "fill-extrusion-opacity": FOOTPRINT_WIND_OPACITY },
    },
  },
  {
    group: "footprints",
    clickable: true,
    spec: {
      id: "footprints",
      type: "fill-extrusion",
      source: "footprints",
      filter: ["!=", ["get", "kind"], "onshore_wind"],
      paint: { "fill-extrusion-color": ASSET_COLOR, "fill-extrusion-height": FOOTPRINT_HEIGHT, "fill-extrusion-opacity": FOOTPRINT_OPACITY },
    },
  },
  {
    group: "sites",
    clickable: true,
    spec: {
      id: "rec-sites",
      type: "symbol",
      source: "rec-sites",
      layout: {
        "icon-image": matchColor("kind", Object.keys(ASSET_FUEL).map((kind) => [kind, STAR_ICON_PREFIX + kind]), STAR_ICON_PREFIX + "other"),
        "icon-size": recStarSize(),
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "icon-padding": 0,
        "icon-pitch-alignment": "viewport",
        "icon-rotation-alignment": "viewport",
        "symbol-sort-key": ["-", 0, REC_MW],
      },
      paint: { "icon-opacity": 0.95 },
    },
  },
  {
    clickable: true,
    spec: {
      id: "assets",
      type: "circle",
      source: "assets",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 4, 10, 8],
        "circle-color": ASSET_COLOR,
        "circle-stroke-color": ASSET_STROKE,
        "circle-stroke-width": 2,
      },
    },
  },
  {
    spec: {
      id: "site-halo",
      type: "circle",
      source: "site",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 11, 10, 17],
        "circle-color": SITE_COLOR,
        "circle-opacity": 0.18,
        "circle-stroke-color": SITE_COLOR,
        "circle-stroke-width": 1.5,
        "circle-stroke-opacity": 0.7,
      },
    },
  },
  {
    clickable: true,
    spec: {
      id: "site",
      type: "circle",
      source: "site",
      paint: { "circle-radius": 6, "circle-color": SITE_COLOR, "circle-stroke-width": 2.5, "circle-stroke-color": "#FFFFFF" },
    },
  },
];

function plantPaint(): CircleLayer["paint"] {
  return {
    // Area ~ capacity: radius ~ sqrt(MW), growing with zoom.
    "circle-radius": [
      "interpolate",
      ["linear"],
      ["zoom"],
      4,
      ["+", 1.2, ["*", 0.11, ["sqrt", CAP]]],
      8,
      ["+", 2, ["*", 0.24, ["sqrt", CAP]]],
      12,
      ["+", 3.5, ["*", 0.45, ["sqrt", CAP]]],
    ],
    "circle-color": FUEL_MATCH,
    "circle-opacity": 0.9,
    "circle-stroke-color": "#FFFFFF",
    "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 4, 0.5, 8, 1, 12, 1.5],
  };
}

export const LAYER_IDS = LAYERS.map((l) => l.spec.id);
export const CLICKABLE_LAYER_IDS = LAYERS.filter((l) => l.clickable).map((l) => l.spec.id);
/** Clickable area fills: a click on them still selects a site, then shows the area's popup. */
export const AREA_LAYER_IDS: readonly string[] = ["demand-fill", "queue-fill", "utilities-fill"];

/** Demand-growth choropleth paint for the current forecast: each county's new P90 peak MW, by geoid, on
 *  DEMAND_RAMP; counties without an estimate stay unfilled. A match on geoid keeps the geometry untouched,
 *  so a what-if slider only swaps two paint properties. */
export function demandPaint(counties: readonly { geoid: string; growth_peak_mw_p90: number }[]): { color: Expr | string; opacity: Expr | number } {
  const pairs = counties.filter((c) => typeof c.geoid === "string" && Number.isFinite(c.growth_peak_mw_p90));
  const unique = [...new Map(pairs.map((c) => [c.geoid, c.growth_peak_mw_p90])).entries()];
  if (!unique.length) return { color: DEMAND_RAMP[0][1], opacity: 0 };
  const NONE = -1e9;
  const growth = ["match", ["get", "geoid"], ...unique.flat(), NONE] as unknown as Expr;
  return {
    color: ["interpolate", ["linear"], growth, ...DEMAND_RAMP.flat()] as unknown as Expr,
    opacity: ["case", [">", growth, NONE / 2], DEMAND_FILL_OPACITY, 0] as unknown as Expr,
  };
}

export function groupLayerIds(group: LayerGroup): string[] {
  return LAYERS.filter((l) => l.group === group).map((l) => l.spec.id);
}

export const SOURCE_ATTRIBUTION: Partial<Record<DataKey | LocalSource, string>> = ATTRIBUTION;

/** Loose shape check before handing a fetched style to setStyle. */
export function asStyle(v: unknown): StyleSpec | null {
  const s = v as Partial<StyleSpec> | null;
  return s && typeof s === "object" && s.version === 8 && Array.isArray(s.layers) && s.sources && typeof s.sources === "object" ? (s as StyleSpec) : null;
}
