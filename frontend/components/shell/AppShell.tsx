"use client";
// Page layout. Every workstream's panel is already mounted here, so feature
// branches edit their own components, not this file.  OWNER: workstream D.
import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";

import { AssumptionsPanel } from "@/components/builder/AssumptionsPanel";
import { BuildPanel } from "@/components/builder/BuildPanel";
import { ProjectPlanner } from "@/components/builder/ProjectPlanner";
import { ThemeToggle } from "@/components/builder/ThemeToggle";
import { CompareView } from "@/components/builder/CompareView";
import { ReportPanel } from "@/components/builder/ReportPanel";
import { EvaluatePanel } from "@/components/evaluate/EvaluatePanel";
import { ProjectDetails, ProjectSummary } from "@/components/evaluate/ProjectSummary";
import { AreaPanel } from "@/components/explore/AreaPanel";
import { MapView } from "@/components/explore/MapView";
import { SitePanel } from "@/components/explore/SitePanel";
import { SimulatePanel } from "@/components/simulate/SimulatePanel";
import { StressPanel } from "@/components/simulate/StressPanel";
import { PanelGuard } from "@/components/shell/PanelGuard";
import { GriddyGradeCard } from "@/components/site_intel/GriddyGradeCard";
import { SiteIntelPanel } from "@/components/site_intel/SiteIntelPanel";
import type { Mode, ScenarioResult } from "@/lib/contract";
import { useGridForge, type View } from "@/lib/store";

/** Any number still coming from a stub or placeholder? Judges reward saying so. */
function usesPlaceholderData(r: ScenarioResult | null): boolean {
  if (!r) return false;
  const json = JSON.stringify([r.simulation.provenance, r.evaluation.economics.lines.map((l) => l.provenance), r.evaluation.emissions.provenance]);
  return /"source":"(STUB|PLACEHOLDER)/.test(json);
}

function Toggle<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-md border border-zinc-300 p-0.5 text-xs dark:border-zinc-700">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`rounded px-2 py-0.5 ${value === o.value ? "bg-emerald-800 text-white dark:bg-cyan-300 dark:text-slate-950" : "text-zinc-600 dark:text-zinc-400"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const LARGE = "(min-width: 1024px)";

/** True on lg+ screens, so the site cards mount once (over the map) instead of twice. */
function useIsLarge(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = window.matchMedia(LARGE);
      m.addEventListener("change", onChange);
      return () => m.removeEventListener("change", onChange);
    },
    () => window.matchMedia(LARGE).matches,
    () => false,
  );
}

/** E's GriddyGrade for the selected site: the score viewers should see first, above every other card. */
function GradeCard({ epoch }: { epoch: number }) {
  return (
    <PanelGuard key={`grade-${epoch}`} name="GriddyGrade">
      <GriddyGradeCard />
    </PanelGuard>
  );
}

function SiteCards({ epoch }: { epoch: number }) {
  return (
    <>
      <PanelGuard key={`site-${epoch}`} name="Site">
        <SitePanel />
      </PanelGuard>
      <PanelGuard key={`intel-${epoch}`} name="Site intelligence">
        <SiteIntelPanel showGrade={false} />
      </PanelGuard>
    </>
  );
}

export function AppShell() {
  // Panels are keyed on panelEpoch (deliberate actions only), never on every auto-run,
  // so panel-local state like B's selected day survives edits.
  const { error, result, panelEpoch: v, running, view, setView, scenario, setMode, retry } = useGridForge();
  const placeholder = useMemo(() => usesPlaceholderData(result), [result]);
  const large = useIsLarge();
  const [detailMode, setDetailMode] = useState<"basic" | "advanced">("basic");
  const advanced = detailMode === "advanced";
  const mode: Mode = scenario?.mode ?? "industrial";

  return (
    <div className="flex h-screen flex-col bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-100">
      <header className="flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-white/80 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-950/90">
        <h1 className="text-lg font-bold">Griddy</h1>
        <span className="hidden text-sm text-zinc-500 xl:inline">Energy infrastructure planning</span>
        <Toggle value={detailMode} onChange={setDetailMode} options={[{ value: "basic", label: "Basic" }, { value: "advanced", label: "Advanced" }]} />
        <Toggle<View>
          value={view}
          onChange={setView}
          options={[
            { value: "single", label: "Single" },
            { value: "compare", label: "Compare" },
          ]}
        />
        <Toggle<Mode>
          value={mode}
          onChange={setMode}
          options={[
            { value: "industrial", label: "Industrial / AI campus" },
            { value: "community", label: "Community" },
          ]}
        />
        <div className="ml-auto flex items-center gap-3 text-xs">
          <ThemeToggle />
          {running && <span className="text-zinc-500">Simulating...</span>}
          {result && (
            <Link href="/report" className="rounded border border-zinc-300 px-2 py-0.5 hover:border-zinc-400 dark:border-zinc-700">
              Report
            </Link>
          )}
          {placeholder && (
            <span
              className="rounded bg-amber-100 px-2 py-0.5 font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
              title="Some numbers still come from placeholder data or stub models"
            >
              Placeholder data
            </span>
          )}
        </div>
      </header>
      {error && (
        <div className="flex items-center gap-3 border-b border-red-200 bg-red-50 px-4 py-1.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          <span className="truncate">{error}</span>
          <button className="ml-auto shrink-0 underline" onClick={retry}>
            Retry
          </button>
        </div>
      )}
      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[300px_minmax(0,1fr)_420px] lg:overflow-hidden">
        <aside className="min-w-0 space-y-3 border-r border-zinc-200 p-3 lg:overflow-y-auto dark:border-zinc-800">
          <PanelGuard name="Project planner"><ProjectPlanner /></PanelGuard>
          <PanelGuard name="Selected area"><AreaPanel /></PanelGuard>
          {advanced && <><PanelGuard name="Build">
            <BuildPanel />
          </PanelGuard>
          <PanelGuard name="Assumptions">
            <AssumptionsPanel />
          </PanelGuard>
          {/* On small screens the site cards live here (GriddyGrade on top); on large screens they float over the map. */}
          {!large && <><GradeCard epoch={v} /><SiteCards epoch={v} /></>}</>}
        </aside>
        {view === "compare" ? (
          <main className="min-h-0 min-w-0 lg:col-span-2 lg:overflow-y-auto">
            <PanelGuard name="Compare">
              <CompareView />
            </PanelGuard>
          </main>
        ) : (
          <>
            <main className="relative h-[50vh] min-h-0 min-w-0 lg:h-auto">
              <PanelGuard name="Map">
                <MapView advanced={advanced} />
              </PanelGuard>
              {/* Site results appear next to where you clicked, not three screens down the sidebar. */}
              {large && advanced && (
                <div className="absolute bottom-8 left-3 z-10 max-h-[55%] w-80 space-y-2 overflow-y-auto">
                  <GradeCard epoch={v} />
                  <SiteCards epoch={v} />
                </div>
              )}
            </main>
            <aside className="min-w-0 space-y-3 border-l border-zinc-200 p-3 lg:overflow-y-auto dark:border-zinc-800">
              {result ? (
                <>
                  {!advanced && <PanelGuard name="Project summary"><ProjectSummary /></PanelGuard>}
                  {advanced && <>
                  <PanelGuard key={`sim-${v}`} name="Simulate">
                    <SimulatePanel />
                  </PanelGuard>
                  <PanelGuard key={`eval-${v}`} name="Evaluate">
                    <EvaluatePanel />
                  </PanelGuard>
                  <PanelGuard key={`stress-${v}`} name="Stress test">
                    <StressPanel />
                  </PanelGuard>
                  </>}
                  <PanelGuard name="Project impacts"><ProjectDetails result={result} /></PanelGuard>
                  <PanelGuard key={`report-${v}`} name="Report">
                    <ReportPanel />
                  </PanelGuard>
                </>
              ) : (
                <p className="p-4 text-sm text-zinc-500">{running ? "Simulating a year, hour by hour..." : "Pick a preset to see results."}</p>
              )}
            </aside>
          </>
        )}
      </div>
    </div>
  );
}
