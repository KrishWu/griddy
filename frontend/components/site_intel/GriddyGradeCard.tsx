"use client";
// The GriddyGrade: the selected site's 0-100 data center feasibility score as the headline number,
// above every detail.  OWNER: workstream E (Site Intelligence).
// SiteIntelPanel mounts it first in E's site cards; AppShell can mount it above A's Site card
// instead and pass <SiteIntelPanel showGrade={false} />. The breakdown is GriddyGradeBreakdown.
import { ProvenanceTip } from "@/components/evaluate/ProvenanceTip";

import { DEFAULT_LOAD_MW, type ComponentStatus } from "./feasibility";
import { setLoadBasis, useGriddyGrade } from "./useGriddyGrade";

const FILL: Record<ComponentStatus, string> = {
  observed: "bg-sky-600 dark:bg-sky-400",
  partial: "bg-sky-600/60 dark:bg-sky-400/60",
  unavailable: "bg-zinc-400 dark:bg-zinc-600",
};

/** Score bar on a 0-100 track. `bands` marks the category boundaries (20/40/60/80) as gaps. */
export function Meter({ value, status = "observed", label, bands = false }: { value: number; status?: ComponentStatus; label?: string; bands?: boolean }) {
  const a11y = label
    ? { role: "meter", "aria-label": label, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(value) }
    : { "aria-hidden": true };
  return (
    <span {...a11y} className={`relative block w-full min-w-0 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800 ${bands ? "h-3" : "h-1.5"}`}>
      <span className={`block h-full rounded-full ${FILL[status]}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      {bands &&
        [20, 40, 60, 80].map((b) => <span key={b} className="absolute inset-y-0 w-0.5 bg-white dark:bg-zinc-950" style={{ left: `calc(${b}% - 1px)` }} />)}
    </span>
  );
}

const mwText = (v: number) => `${Math.round(v).toLocaleString()} MW`;

function Header() {
  return (
    <header className="flex items-baseline justify-between">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-700 dark:text-zinc-300">GriddyGrade</h2>
      <span className="text-[10px] text-zinc-400">E · Site intel</span>
    </header>
  );
}

export function GriddyGradeCard() {
  const g = useGriddyGrade();
  const r = g.result;
  if (!g.location) return null;
  const load = g.scenarioLoad;

  return (
    <section className="rounded-lg border-2 border-sky-600/50 bg-white p-4 shadow-sm dark:border-sky-400/40 dark:bg-zinc-950">
      <Header />
      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">Data center site feasibility · preliminary screening</p>
      {r ? (
        <>
          <div className="mt-2 flex items-end gap-3">
            <span className="text-7xl font-bold leading-none tracking-tight tabular-nums">{r.overallScore}</span>
            <span className="min-w-0 flex-1 pb-1">
              <span className="block text-xs text-zinc-500 dark:text-zinc-400">out of 100</span>
              <span className="block text-base font-semibold leading-tight">{r.category}</span>
            </span>
            <span className="pb-1.5">
              <ProvenanceTip label="GriddyGrade" provenance={{ kind: "inferred", source: "Griddy feasibility heuristic (initial product weights)" }}>
                S = 0.30 G + 0.20 P + 0.15 C + 0.15 A + 0.10 L + 0.10 I. A screening heuristic, not an approval decision or a prediction of
                interconnection, permitting or cost. The breakdown shows each component.
              </ProvenanceTip>
            </span>
          </div>
          <div className="mt-3">
            <Meter value={r.overallScoreRaw} label="GriddyGrade, 0 to 100" bands />
          </div>

          <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 text-xs">
            <dt className="text-[11px] text-zinc-500 dark:text-zinc-400">Data completeness</dt>
            <dd className="flex flex-wrap items-center gap-x-1">
              <span className="font-semibold tabular-nums">{r.dataCompletenessPercent}%</span>
              <span>· {r.completenessLabel}</span>
              {r.partialPercent > 0 && <span className="text-zinc-500">(+{r.partialPercent}% partial)</span>}
              <ProvenanceTip label="Data completeness" provenance={{ kind: "inferred", source: "Share of the score's weight from fully observed components" }}>
                High 80–100%, Moderate 50–79%, Low under 50%. It measures data coverage, not statistical confidence or the probability of success.
              </ProvenanceTip>
            </dd>
            <dt className="text-[11px] text-zinc-500 dark:text-zinc-400">Site</dt>
            <dd className="min-w-0 break-words">
              {g.siteName}
              <span className="block tabular-nums text-zinc-500">
                {g.location.lat.toFixed(3)}, {g.location.lon.toFixed(3)}
              </span>
            </dd>
            <dt className="text-[11px] text-zinc-500 dark:text-zinc-400">Assumed load</dt>
            <dd className="min-w-0">
              <span className="block">
                <span className="font-semibold tabular-nums">{mwText(g.loadMw)}</span> average
                <span className="text-zinc-500">
                  {g.usingScenarioLoad && load
                    ? ` · scenario: ${mwText(load.peakMw)} peak × ${load.loadFactor.toFixed(2)} load factor`
                    : ` · default assumption${load ? "" : " (this scenario is not a data center)"}`}
                </span>
              </span>
              <span role="group" aria-label="Load used for the GriddyGrade" className="mt-1 inline-flex rounded-md border border-zinc-300 p-0.5 text-[11px] dark:border-zinc-700">
                {(
                  [
                    ["scenario", "Scenario load"],
                    ["default", `${DEFAULT_LOAD_MW} MW default`],
                  ] as const
                ).map(([value, label]) => {
                  const active = value === "scenario" ? g.usingScenarioLoad : !g.usingScenarioLoad;
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={active}
                      disabled={value === "scenario" && !load}
                      onClick={() => setLoadBasis(value)}
                      className={`rounded px-1.5 py-0.5 focus-visible:outline-2 focus-visible:outline-sky-500 disabled:cursor-not-allowed disabled:opacity-40 ${
                        active ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black" : "text-zinc-600 dark:text-zinc-400"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </span>
            </dd>
          </dl>

          {g.intelPending && <p className="mt-2 text-[11px] text-zinc-400">Waiting for site screening (air, land); those components count as missing until it arrives.</p>}
          {r.qualification && (
            <p
              className={`mt-3 rounded border px-2 py-1 text-[11px] ${
                r.completenessLabel === "Low"
                  ? "border-amber-400 bg-amber-50 font-medium text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
                  : "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
              }`}
            >
              {r.qualification}
            </p>
          )}
          {r.seriousConstraints.length > 0 && (
            <div className="mt-3 rounded border border-red-300 bg-red-50 px-2 py-1 text-[11px] text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
              <p className="font-semibold">Serious constraints (the GriddyGrade does not offset these)</p>
              <ul className="mt-0.5 list-disc pl-4">
                {r.seriousConstraints.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">Grid capacity is not verified. See the GriddyGrade breakdown for each component.</p>
        </>
      ) : g.loading ? (
        <div className="mt-2 space-y-2" aria-busy="true">
          <p className="text-sm text-zinc-500">Grading this site…</p>
          <div className="h-16 w-1/3 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-3 w-full animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
        </div>
      ) : g.error ? (
        <p className="mt-2 text-sm text-red-600">Could not grade this site: the site summary failed to load ({g.error}).</p>
      ) : (
        <p className="mt-2 text-sm text-zinc-500">Click the map to place a data center and grade the site.</p>
      )}
    </section>
  );
}
