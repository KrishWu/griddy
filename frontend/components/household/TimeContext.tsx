"use client";

import { hourLabel, kg, kwh, num } from "./fmt";
import { MONTHS } from "./theme";
import type { HouseholdResult, TimeSelection } from "./types";
import { Card, INPUT } from "./ui";

export function TimeContext({ r, value, onChange }: { r: HouseholdResult; value: TimeSelection; onChange: (patch: Partial<TimeSelection>) => void }) {
  const v = r.time_view;
  return <Card title="Explore this home's day" aside="Local Pacific clock time">
    <div className="grid grid-cols-2 gap-2 text-xs">
      <label>Time of year
        <select aria-label="Home time of year" className={`mt-1 ${INPUT}`} value={value.view_month ?? "all"} onChange={e => onChange({ view_month: e.target.value === "all" ? null : Number(e.target.value) })}>
          <option value="all">All months</option>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
      </label>
      <label>Day type
        <select aria-label="Home day type" className={`mt-1 ${INPUT}`} value={value.view_day_type} onChange={e => onChange({ view_day_type: e.target.value as TimeSelection["view_day_type"] })}>
          <option value="all">All days</option><option value="weekday">Weekdays</option><option value="weekend">Weekends</option>
        </select>
      </label>
    </div>
    <label className="mt-2 block text-xs">Hour to inspect: {hourLabel(value.view_hour)}
      <input aria-label="Home hour to inspect" className="mt-1 w-full accent-emerald-600" type="range" min={0} max={23} step={1} value={value.view_hour} onChange={e => onChange({ view_hour: Number(e.target.value) })} />
    </label>
    {v && <>
      <p className="mb-2 text-[11px] text-zinc-500">{v.label} · {v.days} matching days · {hourLabel(v.hour)}–{hourLabel(v.hour + 1)} average</p>
      <dl className="grid grid-cols-2 gap-2 text-xs tabular-nums">
        <div><dt className="text-zinc-500">Home electricity</dt><dd>{kwh(num(v.load_kwh[v.hour]))}</dd></div>
        <div><dt className="text-zinc-500">Grid footprint</dt><dd>{kg(num(v.carbon_kg[v.hour]))} CO₂e</dd></div>
        <div><dt className="text-zinc-500">Solar output</dt><dd>{kwh(num(v.solar_kwh[v.hour]))}</dd></div>
        <div><dt className="text-zinc-500">Import energy charge</dt><dd>${num(v.import_energy_cost_usd[v.hour]).toFixed(2)}</dd></div>
      </dl>
    </>}
    <details className="mt-2 text-[10px] text-zinc-500"><summary className="cursor-pointer">About these hourly estimates</summary><p className="mt-1">The daily charts follow this selection. Annual bills, savings and provider labels still cover a full year. CAISO is historical 2024; solar is a nearby typical-year profile. Energy charges here exclude credits and fixed charges.</p></details>
  </Card>;
}
