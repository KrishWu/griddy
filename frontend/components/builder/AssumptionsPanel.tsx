"use client";
// Economic and data assumptions, collapsed to a one-line summary by default so the
// site cards and results stay on screen at 1280x720.  OWNER: workstream D.
// The gas price is the authoritative annual average (C may apply a monthly shape
// scaled to it); the carbon price applies to on-site combustion only. Only inputs a
// module actually uses are shown: a control that moves nothing looks broken on stage.
import { useState } from "react";

import { Term } from "@/components/glossary/Term";
import { Panel } from "@/components/shell/Panel";
import type { Assumptions } from "@/lib/contract";
import { useGridForge } from "@/lib/store";

import { SliderField } from "./SliderField";

export function AssumptionsPanel() {
  const { scenario, updateScenario } = useGridForge();
  const [open, setOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  if (!scenario) return null;

  const a = scenario.assumptions ?? {};
  const set = (patch: Partial<Assumptions>) => updateScenario((s) => ({ ...s, assumptions: { ...s.assumptions, ...patch } }));

  if (!open) {
    return (
      <Panel title="Assumptions" owner="D · Build">
        <button className="w-full text-left text-xs text-zinc-600 dark:text-zinc-400" onClick={() => setOpen(true)}>
          Discount {((a.discount_rate ?? 0.07) * 100).toFixed(1)}% · Gas ${(a.gas_price_usd_per_mmbtu ?? 3.65).toFixed(2)}/MMBtu · Carbon $
          {(a.carbon_price_usd_per_t ?? 0).toFixed(0)}/t
          {a.price_source === "flat" && ` · Grid flat $${(a.flat_price_usd_per_mwh ?? 60).toFixed(0)}/MWh`}{" "}
          <span className="text-emerald-700 dark:text-emerald-400">Edit</span>
        </button>
      </Panel>
    );
  }

  return (
    <Panel title="Assumptions" owner="D · Build">
      <div className="space-y-3">
        <button className="text-xs text-emerald-700 hover:underline dark:text-emerald-400" onClick={() => setOpen(false)}>
          Collapse
        </button>
        <SliderField
          label={<Term k="discount_rate">Discount rate</Term>}
          unit="%"
          value={a.discount_rate ?? 0.07}
          onChange={(v) => set({ discount_rate: v })}
          min={0}
          max={0.15}
          inputMax={0.3}
          step={0.005}
          displayScale={100}
        />
        <SliderField
          label="Gas price (annual average)"
          unit={<Term k="mmbtu">$/MMBtu</Term>}
          value={a.gas_price_usd_per_mmbtu ?? 3.65}
          onChange={(v) => set({ gas_price_usd_per_mmbtu: v })}
          min={1}
          max={12}
          inputMax={50}
          step={0.1}
        />
        <SliderField
          label={
            <>
              <Term k="carbon_price">Carbon price</Term> (on-site combustion)
            </>
          }
          unit="$/t"
          value={a.carbon_price_usd_per_t ?? 0}
          onChange={(v) => set({ carbon_price_usd_per_t: v })}
          min={0}
          max={200}
          inputMax={1000}
          step={5}
          hint="Grid imports already pay California cap-and-trade through market prices."
        />

        <button className="text-xs text-emerald-700 hover:underline dark:text-emerald-400" onClick={() => setAdvanced((x) => !x)}>
          {advanced ? "Hide advanced" : "Show advanced"}
        </button>

        {advanced && (
          <div className="space-y-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
            <SliderField
              label="Analysis period"
              unit="years"
              value={a.analysis_years ?? 20}
              onChange={(v) => set({ analysis_years: Math.round(v) })}
              min={5}
              max={40}
              inputMax={60}
              step={1}
            />
            <SliderField
              label={<Term k="import_adder">Grid delivery adder on imports</Term>}
              unit="$/MWh"
              value={a.import_adder_usd_per_mwh ?? 20}
              onChange={(v) => set({ import_adder_usd_per_mwh: v })}
              min={0}
              max={60}
              inputMax={200}
              step={1}
            />
            <label className="block text-xs text-zinc-600 dark:text-zinc-400">
              Weather and price year
              <select
                className="mt-1 w-full rounded border border-zinc-300 bg-transparent p-1 text-sm dark:border-zinc-700"
                value={a.weather_year ?? 2024}
                onChange={(e) => set({ weather_year: Number(e.target.value) })}
              >
                <option value={2024}>2024</option>
              </select>
            </label>
            <label className="block text-xs text-zinc-600 dark:text-zinc-400">
              <Term k="lmp">Grid price</Term>
              <select
                className="mt-1 w-full rounded border border-zinc-300 bg-transparent p-1 text-sm dark:border-zinc-700"
                value={a.price_source ?? "caiso_historical"}
                onChange={(e) => set({ price_source: e.target.value as Assumptions["price_source"] })}
              >
                <option value="caiso_historical">CAISO 2024 hourly prices</option>
                <option value="flat">Flat price (what-if)</option>
              </select>
            </label>
            {a.price_source === "flat" && (
              <SliderField
                label="Flat grid price"
                unit="$/MWh"
                value={a.flat_price_usd_per_mwh ?? 60}
                onChange={(v) => set({ flat_price_usd_per_mwh: v })}
                min={0}
                max={200}
                inputMax={1000}
                step={1}
                hint="Every hour of grid imports and exports at this price."
              />
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
