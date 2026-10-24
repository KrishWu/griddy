// Shared colors + classes for the Explore map, legend and Site panel.  OWNER: workstream A.
// Fuel hues follow energy-map convention (solar amber, wind sky, hydro blue, gas slate) and
// were checked with a CVD/contrast validator; 8 categories cannot all separate under every
// colorblindness type, so popups and the legend carry the label (never color alone).
// Voltage is an ordinal single-hue ramp (light = low kV, dark = high kV) that also drives
// line width / ring size, so voltage stays readable without color.
import type { AssetKind } from "@/lib/contract";

export const FUELS = ["solar", "wind", "battery", "gas", "hydro", "geothermal", "nuclear", "other"] as const;
export type Fuel = (typeof FUELS)[number];

export const FUEL_COLOR: Record<Fuel, string> = {
  solar: "#E69F00",
  wind: "#56B4E9",
  battery: "#E377C2",
  gas: "#4B5563",
  hydro: "#1D4ED8",
  geothermal: "#C0392B",
  nuclear: "#009E73",
  other: "#B8B1A8",
};

export const FUEL_LABEL: Record<Fuel, string> = {
  solar: "Solar",
  wind: "Wind",
  battery: "Battery",
  gas: "Gas",
  hydro: "Hydro",
  geothermal: "Geothermal",
  nuclear: "Nuclear",
  other: "Other",
};

export function asFuel(v: unknown): Fuel {
  return typeof v === "string" && (FUELS as readonly string[]).includes(v) ? (v as Fuel) : "other";
}

export interface VoltageClass {
  id: string;
  label: string;
  /** Lower bound in kV (inclusive). */
  min: number;
  color: string;
}

/** Highest first. 220-287 kV share a class (SCE 220, PG&E 230, LADWP 287). */
export const VOLTAGE_CLASSES: VoltageClass[] = [
  { id: "500", label: "500 kV", min: 400, color: "#3B0F70" },
  { id: "345", label: "345 kV", min: 300, color: "#5A2D91" },
  { id: "230", label: "220–287 kV", min: 200, color: "#6D4BB5" },
  { id: "115", label: "115–161 kV", min: 100, color: "#8B74C7" },
  { id: "69", label: "≤ 92 kV", min: 0, color: "#A99BD6" },
];
export const UNKNOWN_VOLTAGE: VoltageClass = { id: "unknown", label: "kV unknown", min: 0, color: "#9CA3AF" };

export function voltageClass(kv: unknown): VoltageClass {
  if (typeof kv !== "number" || !Number.isFinite(kv) || kv <= 0) return UNKNOWN_VOLTAGE;
  return VOLTAGE_CLASSES.find((c) => kv >= c.min) ?? UNKNOWN_VOLTAGE;
}

export const UTILITY_TYPE_COLOR: Record<"IOU" | "POU", string> = { IOU: "#6366F1", POU: "#14B8A6" };
export const UTILITY_TYPE_LABEL: Record<"IOU" | "POU", string> = { IOU: "Investor-owned utility", POU: "Publicly owned utility" };

export const SITE_COLOR = "#10B981";
export const CONTEXT_COLOR = "#334155";
export const ASSET_STROKE = "#111827";

export const ASSET_FUEL: Record<AssetKind, Fuel> = {
  solar_pv: "solar",
  onshore_wind: "wind",
  gas_cc: "gas",
  gas_ct: "gas",
  battery: "battery",
};

export const ASSET_LABEL: Record<AssetKind, string> = {
  solar_pv: "Solar PV",
  onshore_wind: "Onshore wind",
  gas_cc: "Gas combined cycle",
  gas_ct: "Gas combustion turbine",
  battery: "Battery storage",
};

/** Attribution strings for our GeoJSON sources (MapLibre's attribution control shows them). */
export const ATTRIBUTION = {
  plants: "EIA-860 2024",
  transmission: "CEC (CC BY 4.0)",
  substations: "© OpenStreetMap contributors (ODbL)",
  boundaries: "US Census",
  utilities: "CEC (CC BY 4.0)",
} as const;
