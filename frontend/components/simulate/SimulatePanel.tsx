"use client";
// Hourly dispatch chart + simulation summary.  OWNER: workstream B (Simulate + Stress Test).
// Day / week dispatch window over the 8,760/8,784-hour year (only the visible points are
// charted), jump-to-worst-day, summary stats, data-quality notes, and the provenance of
// every number shown.
import { useEffect, useMemo, useState } from "react";

import { Panel, Stat } from "@/components/shell/Panel";
import type { AssetKind, ScenarioResult } from "@/lib/contract";
import { mw, mwh, pct } from "@/lib/format";
import { useGridForge } from "@/lib/store";

import { DispatchChart, type View } from "./DispatchChart";
import { fallbackWorstDay, gridChargeShare, scanYear } from "./dispatch";
import { readExtras, type WorstDay } from "./extras";
import { dayOf, fmtDate, makeClock, rangeLabel, wallAt } from "./time";

/** Engine default when an asset has no duration_h (fallback when extras.battery_energy_mwh is absent). */
const DEFAULT_BATTERY_H = 4;

// The panel remounts on every new result (AppShell keys it on resultVersion); keep the
// viewer's day and window across re-runs so scenarios compare on the same day.
let remembered: { day: number; view: View } | null = null;

const pct1 = (v: number) => `${(v * 100).toFixed(1)}%`;

export function SimulatePanel() {
  const { result } = useGridForge();
  if (!result) return null;
  return <SimulateBody result={result} />;
}

function SimulateBody({ result }: { result: ScenarioResult }) {
  const h = result.simulation.hourly;
  const s = result.simulation.summary;
  const scenario = result.scenario;
  const n = h.demand_mw.length;

  const clock = useMemo(() => makeClock(h.start, h.step_minutes), [h.start, h.step_minutes]);
  const per = clock.perDay;
  const days = Math.max(1, Math.floor(n / per));
  const stepH = clock.stepMs / 3_600_000;

  const extras = useMemo(() => readExtras(result.simulation.extras, n, days), [result.simulation.extras, n, days]);
  const scan = useMemo(() => scanYear(h), [h]);
  const gridShare = useMemo(() => gridChargeShare(h, extras, stepH), [h, extras, stepH]);
  const worst: WorstDay = useMemo(
    () => extras.worstDay ?? fallbackWorstDay(h, per, days, stepH),
    [extras.worstDay, h, per, days, stepH],
  );

  const [day, setDayRaw] = useState(() => remembered?.day ?? dayOf(clock, 6, 15, days)); // Jul 15: duck curve
  const [view, setViewRaw] = useState<View>(() => remembered?.view ?? "day");
  const [jumped, setJumped] = useState(false);
  const d = Math.min(Math.max(0, day), days - 1);

  useEffect(() => {
    remembered = { day: d, view };
  }, [d, view]);

  const setDay = (next: number) => {
    setDayRaw(Math.min(Math.max(0, next), days - 1));
    setJumped(false);
  };

  // Week view centers the selected day where possible.
  const firstDay = view === "day" ? d : Math.min(Math.max(0, d - 3), Math.max(0, days - 7));
  const start = firstDay * per;
  const length = Math.min(view === "day" ? per : 7 * per, n - start);
  const stepDays = view === "day" ? 1 : 7;

  const cap = (kind: AssetKind) => scenario.assets.filter((a) => a.kind === kind).reduce((t, a) => t + a.capacity_mw, 0);
  const socCapacityMwh =
    extras.batteryEnergyMwh ??
    scenario.assets.filter((a) => a.kind === "battery").reduce((t, a) => t + a.capacity_mw * (a.duration_h ?? DEFAULT_BATTERY_H), 0);

  // Capacity factor: the engine's value when present, else generation / (nameplate x hours).
  const cf = (kind: AssetKind): number | null => {
    const c = cap(kind);
    if (c <= 0) return null;
    return extras.capacityFactor[kind] ?? (s.generation_mwh[kind] ?? 0) / (c * n * stepH);
  };
  const solarCf = cf("solar_pv");
  const windCf = cf("onshore_wind");
  const renewableMwh = (s.generation_mwh.solar_pv ?? 0) + (s.generation_mwh.onshore_wind ?? 0);
  // Gated on solar/wind capacity like the CFs: the engine reports 0.0 with no renewables.
  const hasRenewables = cap("solar_pv") + cap("onshore_wind") > 0;
  const curtailShare = hasRenewables ? (extras.curtailmentShare ?? (renewableMwh > 0 ? s.curtailed_mwh / renewableMwh : null)) : null;
  const grid = scenario.grid;
  const connected = grid.connected !== false;

  return (
    <Panel title="Simulate" owner="B · Simulate">
      <div className="mb-3 grid grid-cols-3 gap-3">
        <Stat label="Demand / yr" value={mwh(s.demand_mwh)} />
        <Stat label={s.unmet_mwh > 0 ? `Unmet · ${mwh(s.unmet_mwh)}` : "Unmet hours"} value={`${s.hours_unmet} h`} />
        <Stat label="On-site clean share" value={pct(s.onsite_clean_share)} />
        {connected ? (
          // The limit in full with its unit, on its own line: rounding it ("1.1k") made a
          // run sitting exactly at the limit look like it exceeded it.
          <div>
            <Stat label="Peak import" value={mw(s.peak_import_mw)} />
            <div className="text-[10px] leading-3 tabular-nums text-zinc-400">of {mw(grid.import_limit_mw)} limit</div>
          </div>
        ) : (
          <Stat label="Grid" value="Off-grid" />
        )}
        {solarCf !== null && <Stat label="Solar CF" value={pct1(solarCf)} />}
        {windCf !== null && <Stat label="Wind CF" value={pct1(windCf)} />}
        {curtailShare !== null && <Stat label="Curtailment" value={pct1(curtailShare)} />}
        {socCapacityMwh > 0 && (
          // Price-aware charging can fill the battery from cheap grid imports, so the cycles
          // are not all solar time-shifting: say how much of the charge came from the grid.
          <div>
            <Stat label="Battery cycles / yr" value={s.battery_cycles.toFixed(0)} />
            {gridShare !== null && gridShare > 0 && (
              <div
                className="text-[10px] leading-3 tabular-nums text-zinc-400"
                title="Share of the battery's charging energy drawn from grid imports in cheap hours; the rest is surplus solar/wind."
              >
                {gridShare < 0.005 ? "<1%" : pct(gridShare)} grid-charged
              </div>
            )}
          </div>
        )}
      </div>

      {extras.notes.length > 0 && (
        <ul className="mb-2 space-y-0.5 text-[11px] leading-4 text-amber-700 dark:text-amber-500">
          {extras.notes.map((note, i) => (
            <li key={`${i}-${note}`}>Data note: {note}</li>
          ))}
        </ul>
      )}

      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{rangeLabel(clock, start, length)}</span>
        <div role="group" aria-label="Chart window" className="flex shrink-0 overflow-hidden rounded border border-zinc-300 text-[11px] dark:border-zinc-700">
          {(["day", "week"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setViewRaw(v)}
              className={`px-2 py-0.5 ${view === v ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-600 dark:text-zinc-400"}`}
            >
              {v === "day" ? "Day" : "Week"}
            </button>
          ))}
        </div>
      </div>

      <DispatchChart
        hourly={h}
        clock={clock}
        start={start}
        length={length}
        view={view}
        selectedDay={d}
        scan={scan}
        socCapacityMwh={socCapacityMwh}
        extras={extras}
      />

      <div className="mt-2 flex items-center gap-1.5 text-xs">
        <button
          type="button"
          aria-label={view === "day" ? "Previous day" : "Previous week"}
          onClick={() => setDay(d - stepDays)}
          disabled={d === 0}
          className="rounded border border-zinc-300 px-1.5 leading-5 disabled:opacity-40 dark:border-zinc-700"
        >
          ‹
        </button>
        <input
          type="range"
          aria-label="Day of year"
          aria-valuetext={`${fmtDate(wallAt(clock, d * per))}, day ${d + 1} of ${days}`}
          min={0}
          max={days - 1}
          value={d}
          onChange={(e) => setDay(Number(e.target.value))}
          className="min-w-0 flex-1"
        />
        <button
          type="button"
          aria-label={view === "day" ? "Next day" : "Next week"}
          onClick={() => setDay(d + stepDays)}
          disabled={d === days - 1}
          className="rounded border border-zinc-300 px-1.5 leading-5 disabled:opacity-40 dark:border-zinc-700"
        >
          ›
        </button>
        <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-zinc-500">
          Day {d + 1}/{days}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <button
          type="button"
          onClick={() => {
            setDay(worst.index);
            setJumped(true);
          }}
          className="rounded border border-zinc-300 px-2 py-0.5 text-xs dark:border-zinc-700"
        >
          Jump to worst day
        </button>
        {jumped && (
          <span className="text-[11px] text-zinc-500">
            {fmtDate(wallAt(clock, worst.index * per))}
            {worst.reason ? `: ${worst.reason}` : ""}
            {extras.worstDay ? "" : " (estimated in the browser)"}
          </span>
        )}
      </div>

      <Sources result={result} />
    </Panel>
  );
}

function Sources({ result }: { result: ScenarioResult }) {
  const prov = result.simulation.provenance;
  if (!prov.length) return null;
  return (
    <p className="mt-3 text-[10px] leading-4 text-zinc-400">
      <span className="font-medium text-zinc-500">Sources: </span>
      {prov.map((p, i) => (
        <span key={`${p.kind}-${i}`} title={p.note ?? undefined}>
          {i > 0 && " · "}
          <span className="uppercase">{p.kind}</span>{" "}
          {p.url ? (
            <a href={p.url} target="_blank" rel="noreferrer" className="underline hover:text-zinc-600 dark:hover:text-zinc-300">
              {p.source}
            </a>
          ) : (
            p.source
          )}
        </span>
      ))}
    </p>
  );
}
