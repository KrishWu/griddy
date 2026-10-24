// Labels, colors and slider ranges for each technology in the builder.  OWNER: workstream D.
// Colors match B's dispatch chart so a technology looks the same everywhere.
import type { AssetKind } from "@/lib/contract";

export const ASSET_META: Record<AssetKind, { label: string; color: string; maxPerPeak: number }> = {
  solar_pv: { label: "Solar PV", color: "#f59e0b", maxPerPeak: 4 },
  onshore_wind: { label: "Wind", color: "#0ea5e9", maxPerPeak: 2 },
  battery: { label: "Battery", color: "#8b5cf6", maxPerPeak: 1.5 },
  gas_cc: { label: "Gas CC", color: "#6b7280", maxPerPeak: 1.5 },
  gas_ct: { label: "Gas CT", color: "#9ca3af", maxPerPeak: 1.5 },
};

export const ASSET_ORDER: AssetKind[] = ["solar_pv", "onshore_wind", "battery", "gas_cc", "gas_ct"];
