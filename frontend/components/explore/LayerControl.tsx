"use client";
// Collapsible layer toggles + legend + data attribution, overlaid on the map.  OWNER: workstream A.
import { useState, type ReactNode } from "react";

import { DATA_KEYS, GROUP_LABEL, type DataKey, type LayerGroup } from "./mapStyle";
import {
  ASSET_STROKE,
  CONTEXT_COLOR,
  FUEL_COLOR,
  FUEL_LABEL,
  FUELS,
  SITE_COLOR,
  UNKNOWN_VOLTAGE,
  UTILITY_TYPE_COLOR,
  UTILITY_TYPE_LABEL,
  VOLTAGE_CLASSES,
} from "./palette";
import { Dot, LineSwatch } from "./Swatch";

/** Feature count once loaded, "error" if the fetch failed, undefined while loading. */
export type LayerStatus = Partial<Record<DataKey, number | "error">>;

const GROUPS: LayerGroup[] = ["plants", "transmission", "substations", "boundaries", "utilities"];

function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="mb-1 mt-2.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{children}</div>;
}

export function LayerControl(props: {
  visible: Record<LayerGroup, boolean>;
  onToggle: (group: LayerGroup) => void;
  status: LayerStatus;
  overlays: { id: string; label: string }[];
  hiddenOverlays: ReadonlySet<string>;
  onToggleOverlay: (id: string) => void;
}) {
  const { visible, onToggle, status, overlays, hiddenOverlays, onToggleOverlay } = props;
  const [open, setOpen] = useState(true);
  const failed = DATA_KEYS.filter((k) => status[k] === "error");

  return (
    <div className="pointer-events-auto flex min-h-0 w-56 flex-col overflow-hidden rounded-lg bg-white/95 text-xs text-zinc-800 shadow-md ring-1 ring-black/10 backdrop-blur-sm dark:bg-zinc-900/95 dark:text-zinc-100 dark:ring-white/10">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center justify-between px-3 py-2 font-semibold hover:bg-zinc-50 dark:hover:bg-zinc-800"
      >
        <span>Layers &amp; legend</span>
        <span aria-hidden className="text-zinc-400">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="min-h-0 overflow-y-auto px-3 pb-3">
          <ul className="space-y-1">
            {GROUPS.map((g) => {
              const s = status[g];
              return (
                <li key={g}>
                  <label className="flex cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={visible[g]} onChange={() => onToggle(g)} className="accent-zinc-700 dark:accent-zinc-300" />
                    <span className="flex-1">{GROUP_LABEL[g]}</span>
                    <span className={`tabular-nums ${s === "error" ? "text-red-600" : "text-zinc-400"}`} title={s === "error" ? "Failed to load" : undefined}>
                      {s === undefined ? "…" : s === "error" ? "failed" : s.toLocaleString()}
                    </span>
                  </label>
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
          </ul>
          {failed.length > 0 && <p className="mt-1 text-[10px] text-red-600">Could not load: {failed.join(", ")}</p>}

          <SectionTitle>Plants by fuel · size ∝ MW</SectionTitle>
          <ul className="grid grid-cols-2 gap-x-2 gap-y-1">
            {FUELS.map((f) => (
              <li key={f} className="flex items-center gap-1.5">
                <Dot color={FUEL_COLOR[f]} />
                {FUEL_LABEL[f]}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[10px] text-zinc-500 dark:text-zinc-400">Plants under 20 MW appear from zoom 7.</p>

          <SectionTitle>Lines · substations by voltage</SectionTitle>
          <ul className="space-y-1">
            {VOLTAGE_CLASSES.map((c, i) => (
              <li key={c.id} className="flex items-center gap-1.5">
                <LineSwatch color={c.color} width={Math.max(1, 4 - i * 0.7)} />
                <Dot color={c.color} ring size={9} />
                {c.label}
              </li>
            ))}
            <li className="flex items-center gap-1.5">
              <LineSwatch color={VOLTAGE_CLASSES[2].color} width={2} dashed />
              <span>Proposed / closed line</span>
            </li>
            <li className="flex items-center gap-1.5">
              <span className="inline-block w-5" />
              <Dot color={UNKNOWN_VOLTAGE.color} ring size={9} />
              <span>Substation, kV unknown</span>
            </li>
          </ul>
          <p className="mt-1 text-[10px] text-zinc-500 dark:text-zinc-400">Substations under 115 kV or unknown appear from zoom 8.</p>

          {visible.utilities && (
            <>
              <SectionTitle>Utility territories</SectionTitle>
              <ul className="space-y-1">
                {(["IOU", "POU"] as const).map((t) => (
                  <li key={t} className="flex items-center gap-1.5">
                    <span aria-hidden className="inline-block h-2.5 w-4 rounded-sm" style={{ backgroundColor: `${UTILITY_TYPE_COLOR[t]}33`, border: `1px solid ${UTILITY_TYPE_COLOR[t]}` }} />
                    {UTILITY_TYPE_LABEL[t]}
                  </li>
                ))}
              </ul>
            </>
          )}

          <SectionTitle>Scenario</SectionTitle>
          <ul className="space-y-1">
            <li className="flex items-center gap-1.5">
              <Dot color={SITE_COLOR} />
              Selected site
            </li>
            <li className="flex items-center gap-1.5">
              <LineSwatch color={CONTEXT_COLOR} width={2} dashed />
              25 km ring · link to nearest 230 kV+
            </li>
            <li className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: FUEL_COLOR.solar, border: `2px solid ${ASSET_STROKE}` }} />
              Placed asset (by type)
            </li>
          </ul>

          <p className="mt-3 border-t border-zinc-200 pt-2 text-[10px] leading-snug text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
            Data: plants EIA-860 (2024); transmission lines and utility territories California Energy Commission (CC BY 4.0); substations © OpenStreetMap contributors (ODbL;
            coverage incomplete); counties US Census. Click empty map to select a site.
          </p>
        </div>
      )}
    </div>
  );
}
