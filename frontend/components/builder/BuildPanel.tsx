"use client";
// Scenario builder: presets, demand, the asset portfolio, and grid connection.
// Edits auto-run (debounced in the store).  OWNER: workstream D (Build + Report + UI).
import { Term } from "@/components/glossary/Term";
import { Panel } from "@/components/shell/Panel";
import type { Asset, AssetKind, DemandSpec } from "@/lib/contract";
import { itLoadMw, useGridForge } from "@/lib/store";

import { ASSET_META, ASSET_ORDER } from "./assetMeta";
import { SliderField } from "./SliderField";

const INDUSTRIAL_PROFILES: { value: NonNullable<DemandSpec["profile"]>; label: string }[] = [
  { value: "flat", label: "Flat (24/7 campus)" },
  { value: "ai_training", label: "AI training" },
  { value: "ai_inference", label: "AI inference (diurnal)" },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2 border-t border-zinc-100 pt-3 first:border-0 first:pt-0 dark:border-zinc-800">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{title}</h3>
      {children}
    </div>
  );
}

export function BuildPanel() {
  const {
    presets,
    scenario,
    applyPreset,
    updateScenario,
    setPeakMw,
    setItLoadMw,
    setPue,
    scaleWithDemand,
    setScaleWithDemand,
    autoRun,
    setAutoRun,
    runNow,
    running,
    siteSummary,
    scenarioLabel,
  } = useGridForge();
  if (!scenario) return <Panel title="Build">Loading presets...</Panel>;

  const mode = scenario.mode ?? "industrial";
  const community = mode === "community";
  const peak = scenario.demand.peak_mw;
  const modePresets = presets.filter((p) => (p.mode ?? "industrial") === mode);

  const setDemand = (patch: Partial<DemandSpec>) => updateScenario((s) => ({ ...s, demand: { ...s.demand, ...patch } }));
  const setGrid = (patch: Partial<typeof scenario.grid>) => updateScenario((s) => ({ ...s, grid: { ...s.grid, ...patch } }));
  const setAsset = (id: string, patch: Partial<Asset>) =>
    updateScenario((s) => ({ ...s, assets: s.assets.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));
  const removeAsset = (id: string) => updateScenario((s) => ({ ...s, assets: s.assets.filter((a) => a.id !== id) }));
  const addAsset = (kind: AssetKind) =>
    updateScenario((s) => {
      // First unused id, so removing then re-adding never duplicates an id.
      const used = new Set(s.assets.map((a) => a.id));
      let n = 1;
      while (used.has(`${kind}-${n}`)) n++;
      const capacity = Math.round(s.demand.peak_mw * (kind === "battery" ? 0.25 : 0.5));
      return {
        ...s,
        assets: [...s.assets, { id: `${kind}-${n}`, kind, capacity_mw: capacity, duration_h: kind === "battery" ? 4 : null }],
      };
    });

  const lineKm = siteSummary?.nearest_line_km;
  const modified = scenarioLabel.endsWith("(modified)");
  const assets = [...scenario.assets].sort((a, b) => ASSET_ORDER.indexOf(a.kind) - ASSET_ORDER.indexOf(b.kind));

  return (
    <Panel title="Build" owner="D · Build">
      <div className="space-y-3">
        <Section title="Start from a preset">
          <div className="grid grid-cols-1 gap-1">
            {modePresets.map((p) => (
              <button
                key={p.id}
                onClick={() => applyPreset(p.id)}
                className={`rounded border px-2 py-1 text-left text-sm ${
                  scenario.preset === p.id
                    ? "border-emerald-600 bg-emerald-50 font-medium dark:bg-emerald-950"
                    : "border-zinc-300 hover:border-zinc-400 dark:border-zinc-700"
                }`}
              >
                {p.name}
                {scenario.preset === p.id && modified && <span className="ml-1 text-[11px] font-normal text-amber-700 dark:text-amber-400">modified</span>}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-zinc-500">Illustrative configurations, not engineered designs.</p>
        </Section>

        <Section title={community ? "Community demand" : "Data center demand"}>
          {community ? (
            <SliderField
              label={<Term k="peak_demand">Peak demand</Term>}
              unit={<Term k="mw">MW</Term>}
              value={peak}
              onChange={setPeakMw}
              min={1}
              max={100}
              inputMax={10000}
              step={1}
            />
          ) : (
            <>
              {/* Facility peak = IT x PUE (the contract's peak_mw), so better cooling means
                  less grid energy for the same compute. */}
              <SliderField
                label={
                  <>
                    <Term k="it_load">IT load</Term> (compute)
                  </>
                }
                unit={<Term k="mw">MW</Term>}
                value={itLoadMw(scenario)}
                onChange={setItLoadMw}
                min={10}
                max={2500}
                inputMax={10000}
                step={10}
                decimals={0}
              />
              <SliderField
                label={
                  <>
                    <Term k="pue">PUE</Term> (cooling + power overhead)
                  </>
                }
                value={scenario.demand.pue ?? 1.2}
                onChange={setPue}
                min={1.05}
                max={2}
                inputMax={3}
                step={0.01}
                hint="Lower PUE = less grid energy for the same compute."
              />
              <p className="text-xs text-zinc-600 dark:text-zinc-400">
                Facility <Term k="peak_demand">peak</Term> at the meter: <span className="font-medium tabular-nums">{Math.round(peak).toLocaleString()} MW</span> (IT × PUE)
              </p>
            </>
          )}
          <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
            <input type="checkbox" checked={scaleWithDemand} onChange={(e) => setScaleWithDemand(e.target.checked)} />
            Scale portfolio with demand
          </label>
          <SliderField
            label={
              <>
                <Term k="load_factor">Load factor</Term> (average / peak)
              </>
            }
            value={scenario.demand.load_factor ?? 0.9}
            onChange={(v) => setDemand({ load_factor: v })}
            min={0.2}
            max={1}
            inputMax={1}
            step={0.01}
          />
          {!community && (
            <>
              <label className="block text-xs text-zinc-600 dark:text-zinc-400">
                Load profile
                <select
                  className="mt-1 w-full rounded border border-zinc-300 bg-transparent p-1 text-sm dark:border-zinc-700"
                  value={scenario.demand.profile ?? "flat"}
                  onChange={(e) => setDemand({ profile: e.target.value as DemandSpec["profile"] })}
                >
                  {INDUSTRIAL_PROFILES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
        </Section>

        <Section title="On-site portfolio">
          {assets.length === 0 && <p className="text-xs text-zinc-500">No on-site assets: all power comes from the grid.</p>}
          {assets.map((a) => {
            const meta = ASSET_META[a.kind];
            return (
              <div key={a.id} className="space-y-2 rounded border border-zinc-200 p-2 dark:border-zinc-800">
                <div className="flex items-center gap-2 text-sm">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: meta.color }} />
                  <span className="font-medium">
                    {a.kind === "gas_cc" || a.kind === "gas_ct" ? <Term k={a.kind}>{meta.label}</Term> : meta.label}
                  </span>
                  {a.kind === "battery" && (
                    <span className="text-[11px] text-zinc-500">
                      {Math.round(a.capacity_mw * (a.duration_h ?? 4)).toLocaleString()} <Term k="mwh">MWh</Term>
                    </span>
                  )}
                  <button
                    className="ml-auto text-zinc-400 hover:text-red-500"
                    onClick={() => removeAsset(a.id)}
                    aria-label={`Remove ${meta.label}`}
                  >
                    ×
                  </button>
                </div>
                <SliderField
                  label="Capacity"
                  unit="MW"
                  value={a.capacity_mw}
                  onChange={(v) => setAsset(a.id, { capacity_mw: v })}
                  min={0}
                  max={Math.max(10, Math.round(peak * meta.maxPerPeak))}
                  inputMax={20000}
                  step={community ? 1 : 10}
                />
                {a.kind === "battery" && (
                  <SliderField
                    label="Duration"
                    unit="h"
                    value={a.duration_h ?? 4}
                    onChange={(v) => setAsset(a.id, { duration_h: v })}
                    min={0.5}
                    max={12}
                    inputMax={24}
                    step={0.5}
                  />
                )}
              </div>
            );
          })}
          <div className="flex flex-wrap gap-1">
            {ASSET_ORDER.map((kind) => (
              <button
                key={kind}
                className="rounded border border-zinc-300 px-2 py-0.5 text-xs hover:border-zinc-400 dark:border-zinc-700"
                onClick={() => addAsset(kind)}
              >
                + {ASSET_META[kind].label}
              </button>
            ))}
          </div>
        </Section>

        <Section title="Grid connection">
          <SliderField
            label={<Term k="imports">Import limit</Term>}
            unit="MW"
            value={scenario.grid.import_limit_mw}
            onChange={(v) => setGrid({ import_limit_mw: v })}
            min={0}
            max={Math.max(10, Math.round(peak * 1.5))}
            inputMax={20000}
            step={community ? 1 : 10}
          />
          <SliderField
            label={<Term k="exports">Export limit</Term>}
            unit="MW"
            value={scenario.grid.export_limit_mw ?? 0}
            onChange={(v) => setGrid({ export_limit_mw: v })}
            min={0}
            max={Math.max(10, Math.round(peak))}
            inputMax={20000}
            step={community ? 1 : 10}
          />
          <SliderField
            label={<Term k="interconnection">New line to grid</Term>}
            unit="km"
            value={scenario.grid.interconnection_km ?? 5}
            onChange={(v) => setGrid({ interconnection_km: v })}
            min={0}
            max={100}
            inputMax={500}
            step={1}
            hint={lineKm != null ? `Nearest line from the site summary: ${lineKm.toFixed(1)} km` : "Select a site on the map to prefill"}
          />
          <p className="text-[11px] text-zinc-500">
            <Term k="poi">Point of interconnection</Term>:{" "}
            {scenario.grid.poi_voltage_kv ? (
              <>
                {Math.round(scenario.grid.poi_voltage_kv)} <Term k="kv">kV</Term>
              </>
            ) : (
              "voltage unknown until a site is selected"
            )}
          </p>
        </Section>

        <div className="space-y-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <button
            className="w-full rounded bg-emerald-600 py-2 text-sm font-semibold text-white disabled:opacity-50"
            onClick={() => void runNow()}
            disabled={running}
          >
            {running ? "Simulating..." : "Run scenario"}
          </button>
          <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
            <input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} />
            Re-run automatically after edits
          </label>
        </div>
      </div>
    </Panel>
  );
}
