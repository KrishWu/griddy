"use client";
// Scenario builder: presets + editable asset portfolio.  OWNER: workstream D (Build + Report + UI).
import type { Asset, AssetKind } from "@/lib/contract";
import { useGridForge } from "@/lib/store";
import { Panel } from "@/components/shell/Panel";

const KINDS: { kind: AssetKind; label: string }[] = [
  { kind: "solar_pv", label: "Solar PV" },
  { kind: "onshore_wind", label: "Wind" },
  { kind: "gas_cc", label: "Gas CC" },
  { kind: "gas_ct", label: "Gas CT" },
  { kind: "battery", label: "Battery" },
];

export function BuildPanel() {
  const { presets, scenario, setScenario, updateScenario, run, running } = useGridForge();
  if (!scenario) return <Panel title="Build">Loading presets...</Panel>;

  const setAsset = (id: string, patch: Partial<Asset>) =>
    updateScenario((s) => ({ ...s, assets: s.assets.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));
  const addAsset = (kind: AssetKind) =>
    updateScenario((s) => {
      // First unused id, so removing then re-adding never duplicates an id.
      const used = new Set(s.assets.map((a) => a.id));
      let n = 1;
      while (used.has(`${kind}-${n}`)) n++;
      return { ...s, assets: [...s.assets, { id: `${kind}-${n}`, kind, capacity_mw: 100, duration_h: kind === "battery" ? 4 : null }] };
    });
  const removeAsset = (id: string) => updateScenario((s) => ({ ...s, assets: s.assets.filter((a) => a.id !== id) }));

  return (
    <Panel title="Build" owner="D · Build">
      <label className="mb-3 block text-sm">
        Preset
        <select
          className="mt-1 w-full rounded border border-zinc-300 bg-transparent p-1 dark:border-zinc-700"
          value={scenario.preset ?? ""}
          onChange={(e) => {
            const p = presets.find((x) => x.id === e.target.value);
            if (p) setScenario({ ...p, site: scenario.site });
          }}
        >
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      <label className="mb-3 block text-sm">
        Data center peak (MW)
        <input
          type="number"
          className="mt-1 w-full rounded border border-zinc-300 bg-transparent p-1 dark:border-zinc-700"
          value={scenario.demand.peak_mw}
          onChange={(e) => updateScenario((s) => ({ ...s, demand: { ...s.demand, peak_mw: Number(e.target.value) } }))}
        />
      </label>

      <label className="mb-3 block text-sm">
        Grid import limit (MW)
        <input
          type="number"
          className="mt-1 w-full rounded border border-zinc-300 bg-transparent p-1 dark:border-zinc-700"
          value={scenario.grid.import_limit_mw}
          onChange={(e) => updateScenario((s) => ({ ...s, grid: { ...s.grid, import_limit_mw: Number(e.target.value) } }))}
        />
      </label>

      <ul className="mb-3 space-y-2">
        {scenario.assets.map((a) => (
          <li key={a.id} className="flex items-center gap-2 text-sm">
            <span className="w-20">{KINDS.find((k) => k.kind === a.kind)?.label}</span>
            <input
              type="number"
              className="w-24 rounded border border-zinc-300 bg-transparent p-1 dark:border-zinc-700"
              value={a.capacity_mw}
              onChange={(e) => setAsset(a.id, { capacity_mw: Number(e.target.value) })}
            />
            <span className="text-zinc-500">MW</span>
            {a.kind === "battery" && (
              <>
                <input
                  type="number"
                  className="w-14 rounded border border-zinc-300 bg-transparent p-1 dark:border-zinc-700"
                  value={a.duration_h ?? 4}
                  onChange={(e) => setAsset(a.id, { duration_h: Number(e.target.value) })}
                />
                <span className="text-zinc-500">h</span>
              </>
            )}
            <button className="ml-auto text-zinc-400 hover:text-red-500" onClick={() => removeAsset(a.id)} aria-label="Remove">
              ×
            </button>
          </li>
        ))}
      </ul>

      <div className="mb-4 flex flex-wrap gap-1">
        {KINDS.map((k) => (
          <button key={k.kind} className="rounded border border-zinc-300 px-2 py-0.5 text-xs dark:border-zinc-700" onClick={() => addAsset(k.kind)}>
            + {k.label}
          </button>
        ))}
      </div>

      <button
        className="w-full rounded bg-emerald-600 py-2 text-sm font-semibold text-white disabled:opacity-50"
        onClick={run}
        disabled={running}
      >
        {running ? "Simulating..." : "Run scenario"}
      </button>
    </Panel>
  );
}
