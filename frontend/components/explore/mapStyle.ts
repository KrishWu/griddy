// MapLibre sources + layers for the Explore map (render order, paint expressions,
// fallback basemap).  OWNER: workstream A.
// Types only from maplibre-gl here: the runtime is imported dynamically inside MapView.
import type { AddLayerObject, MapOptions } from "maplibre-gl";

import {
  ASSET_FUEL,
  ASSET_STROKE,
  ATTRIBUTION,
  CONTEXT_COLOR,
  FUEL_COLOR,
  FUELS,
  SITE_COLOR,
  UNKNOWN_VOLTAGE,
  UTILITY_TYPE_COLOR,
  VOLTAGE_CLASSES,
} from "./palette";

type CircleLayer = Extract<AddLayerObject, { type: "circle" }>;
type LineLayer = Extract<AddLayerObject, { type: "line" }>;
type FillLayer = Extract<AddLayerObject, { type: "fill" }>;
export type LayerSpec = CircleLayer | LineLayer | FillLayer;
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
export const LOCAL_SOURCES = ["site-context", "assets", "site"] as const;
export type LocalSource = (typeof LOCAL_SOURCES)[number];

/** Toggleable groups (checkboxes) -> their layer ids. */
export type LayerGroup = "plants" | "transmission" | "substations" | "boundaries" | "utilities";
export const GROUP_LABEL: Record<LayerGroup, string> = {
  plants: "Power plants",
  transmission: "Transmission lines",
  substations: "Substations",
  boundaries: "Counties",
  utilities: "Utility territories",
};
export const DEFAULT_VISIBLE: Record<LayerGroup, boolean> = {
  plants: true,
  transmission: true,
  substations: true,
  boundaries: true,
  utilities: false,
};

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

export function groupLayerIds(group: LayerGroup): string[] {
  return LAYERS.filter((l) => l.group === group).map((l) => l.spec.id);
}

export const SOURCE_ATTRIBUTION: Partial<Record<DataKey | LocalSource, string>> = ATTRIBUTION;

/** Loose shape check before handing a fetched style to setStyle. */
export function asStyle(v: unknown): StyleSpec | null {
  const s = v as Partial<StyleSpec> | null;
  return s && typeof s === "object" && s.version === 8 && Array.isArray(s.layers) && s.sources && typeof s.sources === "object" ? (s as StyleSpec) : null;
}
