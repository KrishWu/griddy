"use client";
// Layer toggles + a compact, foldable legend with data attribution, overlaid on the map.  OWNER: workstream A.
// The toggles stay visible; the legend starts folded on a short or narrow map, and the whole
// card starts folded on a tiny one (a phone), until the viewer opens or closes either themselves.
// Optional layers (interconnection queue, 2.5D footprints) show a compact key under their toggle
// while on, so they are explained even with the legend folded.
import { useEffect, useState, type ReactNode, type RefObject } from "react";

import { DATA_KEYS, FOOTPRINT_OPACITY, FOOTPRINT_WIND_OPACITY, GROUP_LABEL, type LayerGroup } from "./mapStyle";
import {
  ASSET_STROKE,
  CONTEXT_COLOR,
  FUEL_COLOR,
  FUEL_LABEL,
  FUELS,
  QUEUE_CREDIT,
  QUEUE_FILL_OPACITY,
  QUEUE_RAMP,
  SITE_COLOR,
  UNKNOWN_VOLTAGE,
  UTILITY_TYPE_COLOR,
  VOLTAGE_CLASSES,
} from "./palette";
import { Dot, LineSwatch, Square } from "./Swatch";

/** Per group: a count once loaded, "error" if its fetch failed, "unavailable" if the backend has no
 *  data for it (the toggle is disabled), undefined while loading. */
export type LayerStatus = Partial<Record<LayerGroup, number | "error" | "unavailable">>;

const GROUPS: LayerGroup[] = ["plants", "transmission", "substations", "boundaries", "utilities", "queue", "footprints"];
const UNAVAILABLE_HINT: Partial<Record<LayerGroup, string>> = {
  queue: "The backend has no interconnection-queue data",
  footprints: "The technology catalog (land per MW) could not be loaded",
};
/** Ticks of the queue legend; evenly spaced because QUEUE_RAMP has a stop at each. */
const QUEUE_TICKS = QUEUE_RAMP.map(([mw]) => mw / 1000);
const FOOTPRINT_KEYS: { label: string; color: string; opacity: number }[] = [
  { label: "Solar", color: FUEL_COLOR.solar, opacity: FOOTPRINT_OPACITY },
  { label: "Wind", color: FUEL_COLOR.wind, opacity: FOOTPRINT_WIND_OPACITY },
  { label: "Battery", color: FUEL_COLOR.battery, opacity: FOOTPRINT_OPACITY },
  { label: "Gas", color: FUEL_COLOR.gas, opacity: FOOTPRINT_OPACITY },
];
const UTILITY_SHORT: Record<"IOU" | "POU", string> = { IOU: "Investor-owned", POU: "Publicly owned" };
const VOLTAGE_SHORT: Record<string, string> = { "500": "500", "345": "345", "230": "220–287", "115": "115–161", "69": "≤ 92" };

type SizeClass = "tiny" | "compact" | "roomy";

/** Size class of the map container, kept up to date with a ResizeObserver (null until measured). */
function useSizeClass(container: RefObject<HTMLElement | null>): SizeClass | null {
  const [size, setSize] = useState<SizeClass | null>(null);
  useEffect(() => {
    const node = container.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const w = node.clientWidth;
      const h = node.clientHeight;
      setSize(w < 320 || h < 500 ? "tiny" : w < 700 || h < 800 ? "compact" : "roomy");
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [container]);
  return size;
}

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

export function LayerControl(props: {
  /** The map container: its size sets the default open state. */
  container: RefObject<HTMLElement | null>;
  visible: Record<LayerGroup, boolean>;
  onToggle: (group: LayerGroup) => void;
  status: LayerStatus;
  overlays: { id: string; label: string }[];
  hiddenOverlays: ReadonlySet<string>;
  onToggleOverlay: (id: string) => void;
}) {
  const { container, visible, onToggle, status, overlays, hiddenOverlays, onToggleOverlay } = props;
  const size = useSizeClass(container);
  // null = follow the map size; a click pins the viewer's choice.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [userLegend, setUserLegend] = useState<boolean | null>(null);
  const open = userOpen ?? size !== "tiny";
  const legendOpen = userLegend ?? size === "roomy";
  const failed = DATA_KEYS.filter((k) => status[k] === "error");

  // MapView caps the height; the toggles and the legend each scroll if squeezed.
  return (
    <div className="pointer-events-auto flex min-h-0 w-56 flex-col overflow-hidden rounded-lg bg-white/95 text-xs text-zinc-800 shadow-md ring-1 ring-black/10 backdrop-blur-sm dark:bg-zinc-900/95 dark:text-zinc-100 dark:ring-white/10">
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        aria-expanded={open}
        className="flex shrink-0 items-center justify-between px-3 py-1.5 font-semibold hover:bg-zinc-50 dark:hover:bg-zinc-800"
      >
        <span>Layers</span>
        <span aria-hidden className="text-zinc-400">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <>
          {/* With the legend open it gives up height first (it scrolls); folded, the toggles scroll if squeezed. */}
          <ul className={`space-y-0.5 px-3 pb-2 ${legendOpen ? "shrink-0" : "min-h-0 overflow-y-auto"}`}>
            {GROUPS.map((g) => {
              const s = status[g];
              const unavailable = s === "unavailable";
              const on = visible[g] && !unavailable;
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
                    <span className="flex-1">{GROUP_LABEL[g]}</span>
                    <span
                      className={`tabular-nums ${s === "error" ? "text-red-600" : "text-zinc-400"}`}
                      title={s === "error" ? "Failed to load" : g === "queue" && typeof s === "number" ? "Counties with active interconnection requests" : undefined}
                    >
                      {s === undefined ? "…" : s === "error" ? "failed" : s === "unavailable" ? "unavailable" : g === "queue" ? `${s} counties` : s.toLocaleString()}
                    </span>
                  </label>
                  {on && g === "queue" && <QueueKey />}
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

          <button
            type="button"
            onClick={() => setUserLegend(!legendOpen)}
            aria-expanded={legendOpen}
            className="flex shrink-0 items-center justify-between border-t border-zinc-200 px-3 py-1.5 font-semibold hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            <span>Legend &amp; sources</span>
            <span aria-hidden className="text-zinc-400">
              {legendOpen ? "▾" : "▸"}
            </span>
          </button>
          {legendOpen && (
            <div className="min-h-0 overflow-y-auto px-3 pb-2.5 text-[11px]">
              <SectionTitle>Plants by fuel · size ∝ MW</SectionTitle>
              <ul className="flex flex-wrap gap-x-2.5 gap-y-0.5">
                {FUELS.map((f) => (
                  <li key={f} className="flex items-center gap-1">
                    <Dot color={FUEL_COLOR[f]} size={8} />
                    {FUEL_LABEL[f]}
                  </li>
                ))}
              </ul>

              <SectionTitle>Lines · substations by kV</SectionTitle>
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
                        {UTILITY_SHORT[t]}
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
                forecast); footprints MW × acres/MW from the Evaluate catalog. Click empty map to select a site.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
