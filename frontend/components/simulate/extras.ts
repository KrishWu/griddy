// Safe readers for SimulationResult.extras (Record<string, unknown>).
// OWNER: workstream B (Simulate + Stress Test).
// Every field is optional: the engine adds them as they land, so a missing or malformed
// value reads as undefined and the panel falls back or hides it. Never throws.
import type { AssetKind } from "@/lib/contract";

export interface WorstDay {
  /** 0-based day of the year (index into days of the hourly arrays). */
  index: number;
  reason: string;
}

export interface SimExtras {
  capacityFactor: Partial<Record<AssetKind, number>>;
  /** Curtailed MWh / renewable generation MWh (0-1). */
  curtailmentShare?: number;
  worstDay?: WorstDay;
  temperatureC?: number[];
  /** Hourly carbon-free share of the CAISO grid mix (0-1). */
  gridCfeShare?: number[];
  /** Total battery energy capacity the engine dispatched (MWh). */
  batteryEnergyMwh?: number;
  /** Annual battery charging energy drawn from grid imports (MWh), dispatch rule 6. */
  batteryGridChargeMwh?: number;
  /** Hourly part of battery_charge_mw drawn from grid imports (MW). */
  batteryGridChargeMw?: number[];
  /** Data-quality notes from the engine (e.g. a stand-in weather site). */
  notes: string[];
}

const KINDS: AssetKind[] = ["solar_pv", "onshore_wind", "gas_cc", "gas_ct", "battery"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** A number[] of exactly n finite values, else undefined. */
function numArray(v: unknown, n: number): number[] | undefined {
  if (!Array.isArray(v) || v.length !== n) return undefined;
  return v.every((x): x is number => typeof x === "number" && Number.isFinite(x)) ? v : undefined;
}

export function readExtras(extras: Record<string, unknown> | undefined, n: number, days: number): SimExtras {
  const x = isRecord(extras) ? extras : {};
  const capacityFactor: Partial<Record<AssetKind, number>> = {};
  if (isRecord(x.capacity_factor)) {
    for (const k of KINDS) {
      const cf = finite(x.capacity_factor[k]);
      if (cf !== undefined) capacityFactor[k] = cf;
    }
  }
  let worstDay: WorstDay | undefined;
  if (isRecord(x.worst_day)) {
    const idx = finite(x.worst_day.index);
    if (idx !== undefined && Number.isInteger(idx) && idx >= 0 && idx < days) {
      worstDay = { index: idx, reason: typeof x.worst_day.reason === "string" ? x.worst_day.reason : "" };
    }
  }
  return {
    capacityFactor,
    curtailmentShare: finite(x.curtailment_share),
    worstDay,
    temperatureC: numArray(x.temperature_c, n),
    gridCfeShare: numArray(x.grid_cfe_share, n),
    batteryEnergyMwh: finite(x.battery_energy_mwh),
    batteryGridChargeMwh: finite(x.battery_grid_charge_mwh),
    batteryGridChargeMw: numArray(x.battery_grid_charge_mw, n),
    notes: Array.isArray(x.notes) ? x.notes.filter((v): v is string => typeof v === "string") : [],
  };
}
