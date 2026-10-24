"use client";
// Page layout. Every workstream's panel is already mounted here, so feature
// branches edit their own components, not this file.  OWNER: workstream D.
import { BuildPanel } from "@/components/builder/BuildPanel";
import { ReportPanel } from "@/components/builder/ReportPanel";
import { EvaluatePanel } from "@/components/evaluate/EvaluatePanel";
import { MapView } from "@/components/explore/MapView";
import { SitePanel } from "@/components/explore/SitePanel";
import { SimulatePanel } from "@/components/simulate/SimulatePanel";
import { StressPanel } from "@/components/simulate/StressPanel";
import { SiteIntelPanel } from "@/components/site_intel/SiteIntelPanel";
import { useGridForge } from "@/lib/store";

export function AppShell() {
  const { error, result } = useGridForge();
  return (
    <div className="flex h-screen flex-col bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-100">
      <header className="flex items-center gap-3 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <h1 className="text-lg font-bold">GridForge</h1>
        <span className="text-sm text-zinc-500">Energy infrastructure planning</span>
        {error && <span className="ml-auto truncate text-xs text-red-600">{error}</span>}
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[300px_1fr_420px] lg:overflow-hidden">
        <aside className="space-y-3 border-r lg:overflow-y-auto border-zinc-200 p-3 dark:border-zinc-800">
          <BuildPanel />
          <SitePanel />
          <SiteIntelPanel />
        </aside>
        <main className="h-[50vh] min-h-0 lg:h-auto">
          <MapView />
        </main>
        <aside className="space-y-3 border-l lg:overflow-y-auto border-zinc-200 p-3 dark:border-zinc-800">
          {result ? (
            <>
              <SimulatePanel />
              <EvaluatePanel />
              <StressPanel />
              <ReportPanel />
            </>
          ) : (
            <p className="p-4 text-sm text-zinc-500">Pick a preset and press Run scenario.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
