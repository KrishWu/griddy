"use client";
import { closeForecastDrawer, openForecastDrawer } from "@/components/explore/forecastDrawer";
import { useLayerState } from "@/components/explore/layerState";
import { ASSET_FUEL, ASSET_LABEL, FUEL_COLOR } from "@/components/explore/palette";
import { Star } from "@/components/explore/Swatch";
import { retryPhase2, usePhase2 } from "@/components/forecast/usePhase2";
import { Panel } from "@/components/shell/Panel";
import type { SiteCandidate } from "@/lib/contract";
import { useGridForge } from "@/lib/store";

export function RecommendedSites() {
  const rec = usePhase2((s) => s.recommendation);
  const status = usePhase2((s) => s.sitesStatus);
  const { selectSite, scenario } = useGridForge();
  const { visible, setVisible } = useLayerState();
  const sites = [...(rec?.sites ?? [])].filter((site) => Number.isFinite(site.suitability))
    .sort((a, b) => b.suitability - a.suitability || b.mw - a.mw).slice(0, 3);
  const updating = status === "loading" || status === "idle";
  const pick = (site: SiteCandidate) => {
    setVisible((value) => ({ ...value, sites: true }));
    closeForecastDrawer();
    void selectSite(site.location);
  };
  return <Panel title="Recommended sites">
    <p className="text-xs text-zinc-500">Choose a candidate site before planning its power supply.</p>
    {updating && <p role="status" className="mt-2 text-xs text-zinc-500">{rec ? "Updating recommended sites…" : "Finding recommended sites…"}</p>}
    {status === "error" ? <div role="alert" className="mt-2 text-xs"><p>Could not load recommended sites.</p><button type="button" onClick={retryPhase2} className="mt-1 underline">Retry</button></div>
      : rec?.available && sites.length > 0 ? <ol className="mt-2 divide-y divide-zinc-200 dark:divide-zinc-800">
        {sites.map((site, index) => {
          const selected = scenario && Math.abs(scenario.site.location.lon - site.location.lon) < 0.00001 && Math.abs(scenario.site.location.lat - site.location.lat) < 0.00001;
          return <li key={site.id} className="py-2 text-xs">
            <div className="flex items-start gap-2">
              <Star color={FUEL_COLOR[ASSET_FUEL[site.kind]] ?? FUEL_COLOR.other} size={18} />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{index + 1}. {site.county ? site.county + " County" : site.region}</p>
                <p className="mt-0.5 text-zinc-500">{ASSET_LABEL[site.kind]} · {Math.round(site.mw).toLocaleString()} MW</p>
                <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                  <span className="tabular-nums">Suitability {Math.round(Math.max(0, Math.min(1, site.suitability)) * 100)}/100</span>
                  <button type="button" disabled={updating || !!selected} onClick={() => pick(site)} className="rounded border border-emerald-600 px-2 py-1 font-medium text-emerald-800 disabled:opacity-50 dark:border-cyan-400 dark:text-cyan-300">{selected ? "Selected" : "Select site"}</button>
                </div>
              </div>
            </div>
          </li>;
        })}
      </ol> : !updating && <p className="mt-2 text-xs text-zinc-500">{rec?.available ? "No candidate sites match this forecast." : "Recommendations are unavailable for this forecast."}</p>}
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
      <label className="flex items-center gap-1.5"><input type="checkbox" checked={visible.sites} onChange={(event) => setVisible((value) => ({ ...value, sites: event.target.checked }))} />Show stars on map</label>
      <button type="button" onClick={openForecastDrawer} className="underline">View all sites</button>
    </div>
    <p className="mt-2 text-[10px] text-zinc-500">These screening candidates need a utility study.</p>
  </Panel>;
}
