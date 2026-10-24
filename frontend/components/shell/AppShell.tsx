"use client";
// Page layout: header, a tabbed left sidebar (Plan · Site · Layers · Build), the map, and a tabbed
// right sidebar (Basic: Summary; Advanced: Simulate · Costs · Stress · Report). Both sidebars fold to a
// slim rail (remembered in the viewer settings) so the map can use the width; nothing floats over the
// map except its own controls. Every workstream's panel is mounted here, so feature branches edit
// their own components, not this file.  OWNER: workstream D.
import Link from "next/link";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { AssumptionsPanel } from "@/components/builder/AssumptionsPanel";
import { BuildPanel } from "@/components/builder/BuildPanel";
import { OptimizePanel, type RevealTarget } from "@/components/builder/OptimizePanel";
import { GriddyMark } from "@/components/builder/GriddyMark";
import { CompareView } from "@/components/builder/CompareView";
import { ProjectPlanner } from "@/components/builder/ProjectPlanner";
import { ReportPanel } from "@/components/builder/ReportPanel";
import { EvaluatePanel } from "@/components/evaluate/EvaluatePanel";
import { ProjectDetails, ProjectSummary } from "@/components/evaluate/ProjectSummary";
import { AreaPanel } from "@/components/explore/AreaPanel";
import { LayerControl } from "@/components/explore/LayerControl";
import { LayerStateProvider } from "@/components/explore/layerState";
import { MapView } from "@/components/explore/MapView";
import { SitePanel } from "@/components/explore/SitePanel";
import { SettingsButton } from "@/components/settings/SettingsButton";
import { SimulatePanel } from "@/components/simulate/SimulatePanel";
import { StressPanel } from "@/components/simulate/StressPanel";
import { GriddyGradeCard } from "@/components/site_intel/GriddyGradeCard";
import { SiteIntelPanel } from "@/components/site_intel/SiteIntelPanel";
import type { Mode, ScenarioResult } from "@/lib/contract";
import { updateSettings, useSettings } from "@/lib/settings";
import { useGridForge, type View } from "@/lib/store";

import { BuildIcon, CostsIcon, LayersIcon, PlanIcon, ReportIcon, SimulateIcon, SiteIcon, StressIcon, SummaryIcon } from "./icons";
import { PanelGuard } from "./PanelGuard";
import { Sidebar, type SidebarTab } from "./Sidebar";
import { selectSidebarTab, showRightTab, useSidebarTab } from "./sidebarTabs";

/** Any number still coming from a stub or placeholder? Judges reward saying so. */
function usesPlaceholderData(r: ScenarioResult | null): boolean {
  if (!r) return false;
  const json = JSON.stringify([r.simulation.provenance, r.evaluation.economics.lines.map((l) => l.provenance), r.evaluation.emissions.provenance]);
  return /"source":"(STUB|PLACEHOLDER)/.test(json);
}

function Toggle<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex rounded-md border border-zinc-300 p-0.5 text-xs dark:border-zinc-700">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`rounded px-2 py-0.5 focus-visible:outline-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-cyan-300 ${value === o.value ? "bg-emerald-800 text-white dark:bg-cyan-300 dark:text-slate-950" : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const ICON = "h-4 w-4";
const headerLink =
  "rounded border border-zinc-300 px-2 py-0.5 hover:border-zinc-400 focus-visible:outline-2 focus-visible:outline-emerald-600 dark:border-zinc-700 dark:hover:border-zinc-500 dark:focus-visible:outline-cyan-300";

export function AppShell() {
  // Panels are keyed on panelEpoch (deliberate actions only), never on every auto-run,
  // so panel-local state like B's selected day survives edits.
  const { error, result, panelEpoch: v, running, view, setView, scenario, setMode, retry } = useGridForge();
  const placeholder = useMemo(() => usesPlaceholderData(result), [result]);
  const [detailMode, setDetailMode] = useState<"basic" | "advanced">("basic");
  const advanced = detailMode === "advanced";
  // "Use this design" in the optimizer: open the results tab it names (Advanced mode, single view,
  // right sidebar expanded) so the loaded design's Simulate or Stress results are on screen.
  const showPanel = useCallback(
    (target: RevealTarget) => {
      setView("single");
      setDetailMode("advanced");
      updateSettings({ rightCollapsed: false });
      showRightTab(target);
    },
    [setView],
  );
  const mode: Mode = scenario?.mode ?? "industrial";
  const compare = view === "compare";
  const { settings } = useSettings();
  const leftTab = useSidebarTab("left");
  const rightTab = useSidebarTab("right");

  const leftTabs: SidebarTab[] = [
    {
      id: "plan",
      label: "Plan",
      icon: <PlanIcon className={ICON} />,
      hint: "Plan a project: design, demand, highlighted area",
      content: (
        <>
          <PanelGuard name="Project planner"><ProjectPlanner /></PanelGuard>
          <PanelGuard name="Optimizer"><OptimizePanel advanced={advanced} onReveal={showPanel} /></PanelGuard>
          <PanelGuard name="Selected area"><AreaPanel /></PanelGuard>
        </>
      ),
    },
    {
      id: "site",
      label: "Site",
      icon: <SiteIcon className={ICON} />,
      hint: "The selected site: grid context, nearby plants, site intelligence",
      content: (
        <>
          {/* E's GriddyGrade: the score viewers should see first, above every other site card. */}
          <PanelGuard key={`grade-${v}`} name="GriddyGrade"><GriddyGradeCard /></PanelGuard>
          <PanelGuard key={`site-${v}`} name="Site"><SitePanel /></PanelGuard>
          <PanelGuard key={`intel-${v}`} name="Site intelligence"><SiteIntelPanel showGrade={false} /></PanelGuard>
        </>
      ),
    },
    {
      id: "layers",
      label: "Layers",
      icon: <LayersIcon className={ICON} />,
      hint: "Map layers, legend and data sources",
      content: <PanelGuard name="Layers"><LayerControl /></PanelGuard>,
    },
    ...(advanced
      ? [
          {
            id: "build",
            label: "Build",
            icon: <BuildIcon className={ICON} />,
            hint: "Build the portfolio and edit assumptions",
            content: (
              <>
                <PanelGuard name="Build"><BuildPanel /></PanelGuard>
                <PanelGuard name="Assumptions"><AssumptionsPanel /></PanelGuard>
              </>
            ),
          },
        ]
      : []),
  ];

  const noResult = (
    <p className="p-4 text-sm text-zinc-500 dark:text-zinc-400">{running ? "Simulating a year, hour by hour..." : "Pick a preset to see results."}</p>
  );
  const withResult = (node: ReactNode) => (result ? node : noResult);
  const rightTabs: SidebarTab[] = advanced
    ? [
        {
          id: "simulate",
          label: "Simulate",
          icon: <SimulateIcon className={ICON} />,
          hint: "Hour-by-hour dispatch for the simulated year",
          content: withResult(<PanelGuard key={`sim-${v}`} name="Simulate"><SimulatePanel /></PanelGuard>),
        },
        {
          id: "costs",
          label: "Costs",
          icon: <CostsIcon className={ICON} />,
          hint: "Costs, emissions and the bill of materials",
          content: withResult(<PanelGuard key={`eval-${v}`} name="Evaluate"><EvaluatePanel /></PanelGuard>),
        },
        {
          id: "stress",
          label: "Stress",
          icon: <StressIcon className={ICON} />,
          hint: "Stress tests: outages, heat waves, price spikes",
          content: withResult(<PanelGuard key={`stress-${v}`} name="Stress test"><StressPanel /></PanelGuard>),
        },
        {
          id: "report",
          label: "Report",
          icon: <ReportIcon className={ICON} />,
          hint: "Project impacts and the printable report",
          content: withResult(
            <>
              <PanelGuard name="Project impacts">{result && <ProjectDetails result={result} />}</PanelGuard>
              <PanelGuard key={`report-${v}`} name="Report"><ReportPanel /></PanelGuard>
            </>,
          ),
        },
      ]
    : [
        {
          id: "summary",
          label: "Summary",
          icon: <SummaryIcon className={ICON} />,
          hint: "Project at a glance, impacts and the report",
          content: withResult(
            <>
              <PanelGuard name="Project summary"><ProjectSummary /></PanelGuard>
              <PanelGuard name="Project impacts">{result && <ProjectDetails result={result} />}</PanelGuard>
              <PanelGuard key={`report-${v}`} name="Report"><ReportPanel /></PanelGuard>
            </>,
          ),
        },
      ];

  // Column widths in rem, so Settings > Text size widens the sidebars with their text. A folded
  // sidebar keeps a 3.25 rem rail. Compare has no right sidebar: it takes the map's place and width.
  const leftCol = settings.leftCollapsed ? "[--shell-l:3.25rem]" : "[--shell-l:18.75rem] xl:[--shell-l:20rem]";
  const rightCol = settings.rightCollapsed ? "[--shell-r:3.25rem]" : "[--shell-r:22.5rem] xl:[--shell-r:26.25rem]";
  const cols = compare ? "lg:grid-cols-[var(--shell-l)_minmax(0,1fr)]" : "lg:grid-cols-[var(--shell-l)_minmax(0,1fr)_var(--shell-r)]";
  // Stacked (below lg): explicit rows, or the auto rows would stretch to fill the screen and leave
  // empty bands under folded sidebars. The map row takes any spare height (at least 55vh); Compare's
  // row is at least as tall as its panels and fills the rest. lg keeps its single full-height row.
  const rows = compare ? "max-lg:grid-rows-[auto_minmax(max-content,1fr)]" : "max-lg:grid-rows-[auto_minmax(55vh,1fr)_auto]";

  return (
    <LayerStateProvider>
      <div className="flex h-screen flex-col bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-100">
        <header
          data-chrome
          className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-zinc-200 bg-white/80 px-3 py-2 sm:px-4 dark:border-zinc-800 dark:bg-zinc-950"
        >
          <h1 className="flex items-center gap-1.5 text-lg font-bold">
            <GriddyMark className="h-6 w-6 text-emerald-700 dark:text-cyan-300" />
            Griddy
          </h1>
          <span className="hidden text-sm text-zinc-500 xl:inline dark:text-zinc-400">Energy infrastructure planning</span>
          <Toggle label="Detail" value={detailMode} onChange={setDetailMode} options={[{ value: "basic", label: "Basic" }, { value: "advanced", label: "Advanced" }]} />
          <Toggle<View>
            label="View"
            value={view}
            onChange={setView}
            options={[
              { value: "single", label: "Single" },
              { value: "compare", label: "Compare" },
            ]}
          />
          <Toggle<Mode>
            label="Project type"
            value={mode}
            onChange={setMode}
            options={[
              { value: "industrial", label: <><span className="sm:hidden">Industrial</span><span className="hidden sm:inline">Industrial / AI campus</span></> },
              { value: "community", label: "Community" },
            ]}
          />
          <div className="ml-auto flex items-center gap-2 text-xs">
            {running && <span className="text-zinc-500 dark:text-zinc-400" role="status">Simulating...</span>}
            {placeholder && (
              <span
                className="rounded bg-amber-100 px-2 py-0.5 font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                title="Some numbers still come from placeholder data or stub models"
              >
                Placeholder data
              </span>
            )}
            {result && (
              <Link href="/report" className={headerLink}>
                Report
              </Link>
            )}
            <Link href="/about" className={headerLink}>
              About
            </Link>
            <SettingsButton />
          </div>
        </header>
        {error && (
          <div data-chrome className="flex items-center gap-3 border-b border-red-200 bg-red-50 px-4 py-1.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            <span className="truncate">{error}</span>
            <button className="ml-auto shrink-0 underline" onClick={retry}>
              Retry
            </button>
          </div>
        )}
        <div className={`grid min-h-0 min-w-0 flex-1 grid-cols-1 overflow-y-auto lg:overflow-hidden ${cols} ${rows} ${leftCol} ${rightCol}`}>
          <Sidebar
            side="left"
            label="Plan and explore"
            tabs={leftTabs}
            active={leftTab}
            onSelect={(id) => selectSidebarTab("left", id)}
            collapsed={settings.leftCollapsed}
            onCollapsedChange={(c) => updateSettings({ leftCollapsed: c })}
          />
          {compare ? (
            // Compare is panels, not map: black in the Mixed theme like the sidebars.
            <main data-chrome className="min-h-0 min-w-0 bg-zinc-50 lg:overflow-y-auto dark:bg-black">
              <PanelGuard name="Compare">
                <CompareView />
              </PanelGuard>
            </main>
          ) : (
            <>
              {/* The map: nothing but its own controls on top of it. */}
              <main className="relative min-h-0 min-w-0">
                <PanelGuard name="Map">
                  <MapView />
                </PanelGuard>
              </main>
              <Sidebar
                side="right"
                label="Results"
                tabs={rightTabs}
                active={advanced ? rightTab : "summary"}
                onSelect={(id) => {
                  if (advanced) selectSidebarTab("right", id);
                }}
                collapsed={settings.rightCollapsed}
                onCollapsedChange={(c) => updateSettings({ rightCollapsed: c })}
              />
            </>
          )}
        </div>
      </div>
    </LayerStateProvider>
  );
}
