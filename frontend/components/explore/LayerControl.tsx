"use client";
// Layer toggles + a foldable legend with data attribution, in the sidebar's Layers tab (they used to
// float over the map and crowd it).  OWNER: workstream A.
// Visibility is shared with the map through layerState.tsx (AppShell provides it); MapView publishes
// each group's load status and count there. Optional layers (interconnection queue, demand growth,
// recommended sites, 2.5D footprints) show a compact key under their toggle while on, so they are
// explained even with the legend folded. Jargon in layer names and legend titles (queue, utility
// territory, kV, IOU / POU) explains itself through <Term> (lib/glossary.ts).
import { useState, type ReactNode } from "react";

import { scenarioLabel } from "@/components/forecast/forecastData";
import { forecastAdjusted, usePhase2 } from "@/components/forecast/usePhase2";
import { Term } from "@/components/glossary/Term";
import type { GlossaryKey } from "@/lib/glossary";
import { useGridForge } from "@/lib/store";

import { useLayerState } from "./layerState";
import { DATA_KEYS, FOOTPRINT_OPACITY, FOOTPRINT_WIND_OPACITY, GROUP_LABEL, type LayerGroup } from "./mapStyle";
import {
  ASSET_STROKE,
  CONTEXT_COLOR,
  DEMAND_CREDIT,
  DEMAND_FILL_OPACITY,
  DEMAND_RAMP,
  FUEL_COLOR,
  FUEL_LABEL,
  FUELS,
  QUEUE_CREDIT,
  QUEUE_FILL_OPACITY,
  QUEUE_RAMP,
  REC_SITE_RING,
  SITE_COLOR,
  UNKNOWN_VOLTAGE,
  UTILITY_TYPE_COLOR,
  VOLTAGE_CLASSES,
} from "./palette";
import { Dot, LineSwatch, Square } from "./Swatch";

export type { LayerStatus } from "./layerState";

const GROUPS: LayerGroup[] = ["plants", "transmission", "substations", "boundaries", "utilities", "queue", "demand", "sites", "footprints"];
const UNAVAILABLE_HINT: Partial<Record<LayerGroup, string>> = {
  queue: "The backend has no interconnection-queue data",
  demand: "The demand forecast is unavailable right now",
  footprints: "The technology catalog (land per MW) could not be loaded",
};
/** Groups listed only while they have something to show (no disabled row before the data exists). */
const ONLY_WHEN_LOADED: ReadonlySet<LayerGroup> = new Set(["sites"]);
const COUNT_UNIT: Partial<Record<LayerGroup, string>> = { queue: "counties", demand: "counties", sites: "sites" };
/** Ticks of the demand legend; evenly spaced because DEMAND_RAMP has a stop at each. */
const DEMAND_TICKS = DEMAND_RAMP.map(([v]) => (v >= 1000 ? `${v / 1000}k` : String(v)));
const SITE_KEYS: { label: string; color: string }[] = [
  { label: "Solar", color: FUEL_COLOR.solar },
  { label: "Wind", color: FUEL_COLOR.wind },
  { label: "Battery", color: FUEL_COLOR.battery },
  { label: "Gas", color: FUEL_COLOR.gas },
];
/** Ticks of the queue legend; evenly spaced because QUEUE_RAMP has a stop at each. */
const QUEUE_TICKS = QUEUE_RAMP.map(([mw]) => mw / 1000);
const FOOTPRINT_KEYS: { label: string; color: string; opacity: number }[] = [
  { label: "Solar", color: FUEL_COLOR.solar, opacity: FOOTPRINT_OPACITY },
  { label: "Wind", color: FUEL_COLOR.wind, opacity: FOOTPRINT_WIND_OPACITY },
  { label: "Battery", color: FUEL_COLOR.battery, opacity: FOOTPRINT_OPACITY },
  { label: "Gas", color: FUEL_COLOR.gas, opacity: FOOTPRINT_OPACITY },
];
const UTILITY_SHORT: Record<"IOU" | "POU", string> = { IOU: "Investor-owned", POU: "Publicly owned" };
const UTILITY_TERM: Record<"IOU" | "POU", GlossaryKey> = { IOU: "iou", POU: "pou" };
/** Layer names that are jargon get a glossary card (hover or focus; a tap on the word explains it
 *  rather than toggling the layer, and the checkbox still toggles). */
const GROUP_TERM: Partial<Record<LayerGroup, GlossaryKey>> = {
  transmission: "transmission_line",
  substations: "substation",
  utilities: "utility_territory",
  queue: "interconnection_queue",
};
const VOLTAGE_SHORT: Record<string, string> = { "500": "500", "345": "345", "230": "220–287", "115": "115–161", "69": "≤ 92" };

function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="mb-1 mt-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{children}</div>;
}

/** Swatches drawn as on the (light) basemap: a light backing in dark mode keeps dark lines visible. */
function OnMap({ children }: { children: ReactNode }) {
  return <span className="inline-flex shrink-0 items-center gap-0.5 rounded-sm px-0.5 dark:bg-zinc-200">{children}</span>;
}

function Note({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">{children}</p>;
}

/** Sequential key for the queue choropleth, drawn over the basemap's light gray at the map's fill opacity. */
function QueueKey() {
  const stops = QUEUE_RAMP.map(([, c], i) => `${c} ${(i / (QUEUE_RAMP.length - 1)) * 100}%`).join(", ");
  const last = QUEUE_TICKS.length - 1;
  return (
    <div className="mb-1 ml-5 mt-0.5">
      <div className="rounded-sm bg-[#F2F3F0] ring-1 ring-black/10 dark:ring-white/20">
        <div className="h-2 rounded-sm" style={{ backgroundImage: `linear-gradient(90deg, ${stops})`, opacity: QUEUE_FILL_OPACITY }} />
      </div>
      <div className="relative mt-0.5 h-3 text-[10px] tabular-nums text-zinc-500 dark:text-zinc-400">
        {QUEUE_TICKS.map((gw, i) => (
          <span
            key={gw}
            className="absolute top-0 whitespace-nowrap"
            style={i === 0 ? { left: 0 } : i === last ? { right: 0 } : { left: `${(i / last) * 100}%`, transform: "translateX(-50%)" }}
          >
            {gw}
          </span>
        ))}
      </div>
      <p className="mt-0.5 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">GW of active requests per county · {QUEUE_CREDIT}</p>
    </div>
  );
}

/** Sequential key for the demand-growth choropleth, drawn over the basemap's light gray at the map's fill opacity. */
function DemandKey({ caption }: { caption?: ReactNode }) {
  const stops = DEMAND_RAMP.map(([, c], i) => `${c} ${(i / (DEMAND_RAMP.length - 1)) * 100}%`).join(", ");
  const last = DEMAND_TICKS.length - 1;
  return (
    <div className="mb-1 ml-5 mt-0.5">
      <div className="rounded-sm bg-[#F2F3F0] ring-1 ring-black/10 dark:ring-white/20">
        <div className="h-2 rounded-sm" style={{ backgroundImage: `linear-gradient(90deg, ${stops})`, opacity: DEMAND_FILL_OPACITY }} />
      </div>
      <div className="relative mt-0.5 h-3 text-[10px] tabular-nums text-zinc-500 dark:text-zinc-400">
        {DEMAND_TICKS.map((t, i) => (
          <span
            key={t}
            className="absolute top-0 whitespace-nowrap"
            style={i === 0 ? { left: 0 } : i === last ? { right: 0 } : { left: `${(i / last) * 100}%`, transform: "translateX(-50%)" }}
          >
            {i === 0 ? "≤0" : t}
          </span>
        ))}
      </div>
      <p className="mt-0.5 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">
        {caption ?? (
          <>
            MW of new <Term k="p50_p90">P90</Term> peak per county
          </>
        )}{" "}
        · estimate
      </p>
    </div>
  );
}

function SitesKey() {
  return (
    <div className="mb-1 ml-5 mt-0.5">
      <ul className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px]">
        {SITE_KEYS.map((k) => (
          <li key={k.label} className="flex items-center gap-1">
            <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: k.color, boxShadow: `0 0 0 1.5px #fff, 0 0 0 2.5px ${REC_SITE_RING}` }} />
            {k.label}
          </li>
        ))}
      </ul>
      <p className="mt-0.5 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">Size ∝ MW · screening candidates, not buildable sites</p>
    </div>
  );
}

function FootprintKey() {
  return (
    <div className="mb-1 ml-5 mt-0.5">
      <ul className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px]">
        {FOOTPRINT_KEYS.map((k) => (
          <li key={k.label} className="flex items-center gap-1">
            <Square color={k.color} opacity={k.opacity} />
            {k.label}
          </li>
        ))}
      </ul>
      <p className="mt-0.5 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">
        Footprint = MW × acres/MW (Evaluate catalog); wind area is turbine spacing. Heights are schematic.
      </p>
    </div>
  );
}

export function LayerControl() {
  const { visible, toggleGroup: onToggle, status, hiddenOverlays, toggleOverlay: onToggleOverlay } = useLayerState();
  const overlays = useGridForge().overlays;
  const forecast = usePhase2((st) => st.forecast);
  const demandCaption = forecast?.available ? (
    <>
      MW of new <Term k="p50_p90">P90</Term> peak by {forecast.year} · {scenarioLabel(forecast.scenario).toLowerCase()} scenario
      {forecastAdjusted(forecast) ? ", adjusted" : ""}
    </>
  ) : undefined;
  // The sidebar has room: the legend starts open; the viewer can fold it.
  const [legendOpen, setLegendOpen] = useState(true);
  const failed = DATA_KEYS.filter((k) => status[k] === "error");

  return (
    <div className="space-y-3 text-xs text-zinc-800 dark:text-zinc-100">
      <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950" aria-labelledby="layers-heading">
        <h2 id="layers-heading" className="mb-1 text-sm font-semibold uppercase tracking-wide text-zinc-700 dark:text-zinc-300">
          Map layers
        </h2>
        <p className="mb-2 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">Click a feature on the map for its details, or empty map to pick a site.</p>
        <ul className="space-y-1 text-[13px]">
          {GROUPS.map((g) => {
            const s = status[g];
            if (ONLY_WHEN_LOADED.has(g) && typeof s !== "number") return null;
            const unavailable = s === "unavailable";
            const on = visible[g] && !unavailable;
            const term = GROUP_TERM[g];
            return (
              <li key={g}>
                <label
                  className={`flex items-center gap-2 ${unavailable ? "cursor-not-allowed text-zinc-400 dark:text-zinc-500" : "cursor-pointer"}`}
                  title={unavailable ? UNAVAILABLE_HINT[g] : undefined}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={unavailable}
                    onChange={() => onToggle(g)}
                    className="accent-zinc-700 dark:accent-zinc-300"
                  />
                  <span className="flex-1">{term ? <Term k={term}>{GROUP_LABEL[g]}</Term> : GROUP_LABEL[g]}</span>
                  <span
                    className={`text-[11px] tabular-nums ${s === "error" ? "text-red-600" : "text-zinc-500 dark:text-zinc-400"}`}
                    title={s === "error" ? "Failed to load" : g === "queue" && typeof s === "number" ? "Counties with active interconnection requests" : undefined}
                  >
                    {s === undefined ? "…" : s === "error" ? "failed" : s === "unavailable" ? "unavailable" : COUNT_UNIT[g] ? `${s} ${COUNT_UNIT[g]}` : s.toLocaleString()}
                  </span>
                </label>
                {on && g === "queue" && <QueueKey />}
                {on && g === "demand" && <DemandKey caption={demandCaption} />}
                {on && g === "sites" && <SitesKey />}
                {on && g === "footprints" && <FootprintKey />}
              </li>
            );
          })}
          {overlays.map((o) => (
            <li key={`ov-${o.id}`}>
              <label className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" checked={!hiddenOverlays.has(o.id)} onChange={() => onToggleOverlay(o.id)} className="accent-zinc-700 dark:accent-zinc-300" />
                <span className="flex-1 truncate" title={o.label}>
                  {o.label}
                </span>
              </label>
            </li>
          ))}
          {failed.length > 0 && <li className="text-[10px] text-red-600">Could not load: {failed.join(", ")}</li>}
        </ul>
      </section>
      <section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <button
          type="button"
          onClick={() => setLegendOpen(!legendOpen)}
          aria-expanded={legendOpen}
          className="flex w-full items-center justify-between rounded-lg px-4 py-3 text-sm font-semibold uppercase tracking-wide text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          <span>Legend &amp; sources</span>
          <span aria-hidden className="text-zinc-400">
            {legendOpen ? "▾" : "▸"}
          </span>
        </button>
        {legendOpen && (
          <div className="px-4 pb-4 text-[11px]">
            <SectionTitle>
              Plants by fuel · size ∝ <Term k="mw">MW</Term>
            </SectionTitle>
            <ul className="flex flex-wrap gap-x-2.5 gap-y-0.5">
              {FUELS.map((f) => (
                <li key={f} className="flex items-center gap-1">
                  <Dot color={FUEL_COLOR[f]} size={8} />
                  {FUEL_LABEL[f]}
                </li>
              ))}
            </ul>

            <SectionTitle>
              Lines · substations by <Term k="kv">kV</Term>
            </SectionTitle>
            <ul className="flex justify-between gap-x-1">
              {VOLTAGE_CLASSES.map((c, i) => (
                <li key={c.id} className="flex flex-col items-center gap-0.5" title={`${c.label} lines and substations`}>
                  <OnMap>
                    <LineSwatch color={c.color} width={Math.max(1, 4 - i * 0.7)} />
                    <Dot color={c.color} ring size={8} />
                  </OnMap>
                  <span className="whitespace-nowrap text-[10px] tabular-nums">{VOLTAGE_SHORT[c.id] ?? c.label}</span>
                </li>
              ))}
            </ul>
            <ul className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5">
              <li className="flex items-center gap-1">
                <OnMap>
                  <LineSwatch color={VOLTAGE_CLASSES[2].color} width={2} dashed />
                </OnMap>
                Proposed / closed
              </li>
              <li className="flex items-center gap-1">
                <Dot color={UNKNOWN_VOLTAGE.color} ring size={8} />
                kV unknown
              </li>
            </ul>
            <Note>Plants under 20 MW appear from zoom 7; substations under 115 kV or kV unknown from zoom 8.</Note>

            {visible.utilities && (
              <>
                <SectionTitle>Utility territories</SectionTitle>
                <ul className="flex flex-wrap gap-x-2.5 gap-y-0.5">
                  {(["IOU", "POU"] as const).map((t) => (
                    <li key={t} className="flex items-center gap-1">
                      <span aria-hidden className="inline-block h-2.5 w-4 rounded-sm" style={{ backgroundColor: `${UTILITY_TYPE_COLOR[t]}33`, border: `1px solid ${UTILITY_TYPE_COLOR[t]}` }} />
                      <Term k={UTILITY_TERM[t]}>{UTILITY_SHORT[t]}</Term>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <SectionTitle>Scenario</SectionTitle>
            <ul className="flex flex-wrap gap-x-2.5 gap-y-0.5">
              <li className="flex items-center gap-1">
                <Dot color={SITE_COLOR} size={8} />
                Selected site
              </li>
              <li className="flex items-center gap-1">
                <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: FUEL_COLOR.solar, border: `2px solid ${ASSET_STROKE}` }} />
                Placed asset
              </li>
              <li className="flex items-center gap-1">
                <OnMap>
                  <LineSwatch color={CONTEXT_COLOR} width={2} dashed />
                </OnMap>
                25 km ring · links to 220 kV+
              </li>
            </ul>

            <p className="mt-2 border-t border-zinc-200 pt-1.5 text-[10px] leading-snug text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
              Data: plants EIA-860 (2024); transmission lines and utility territories California Energy Commission (CC BY 4.0); substations © OpenStreetMap contributors
              (ODbL; coverage incomplete); counties US Census; interconnection queue LBNL Queued Up 2026 (CC BY 4.0; requested capacity, not a build
              forecast); footprints MW × acres/MW from the Evaluate catalog.
              {visible.demand && ` Demand growth: ${DEMAND_CREDIT} (a scenario, not a prediction).`}
              {visible.sites && " Recommended sites: Griddy site ranking (screening only)."} Click empty map to select a site.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
