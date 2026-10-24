"use client";
// Demand forecast + what-if view (Phase 2).  OWNER: workstream A.
// Pick a scenario preset and a target year, adjust the assumptions, and see the new peak demand by
// region and county; B's Sites panel below follows the same scenario. Everything reads the shared
// Phase 2 state (usePhase2), so the map's demand layer and recommended sites always agree with it.
// MapView mounts this in its "Forecast & sites" drawer (embedded); D may also mount it as a full view.
import { useEffect, useId, useState, type ReactNode } from "react";

import { safeUrl } from "@/components/explore/geo";
import { Term } from "@/components/glossary/Term";
import { Panel } from "@/components/shell/Panel";
import { PanelGuard } from "@/components/shell/PanelGuard";
import { SitesPanel } from "@/components/sites/SitesPanel";
import type { DemandForecast, ForecastRequest, Provenance } from "@/lib/contract";
import { mw, pct } from "@/lib/format";
import { useGridForge } from "@/lib/store";

import { CountyBars } from "./CountyBars";
import {
  DEFAULT_DC_GEOID,
  countyByGeoid,
  countyByName,
  countyName,
  perYear,
  scenarioLabel,
  signedMw,
  signedMwh,
  signedPct,
  totals,
} from "./forecastData";
import { RegionChart } from "./RegionChart";
import {
  DEFAULT_YEAR,
  effectiveParams,
  getPhase2State,
  isAdjusted,
  presetOf,
  resetToPreset,
  retryPhase2,
  selectScenario,
  updateForecast,
  usePhase2,
  type EffectiveParams,
  type LoadStatus,
} from "./usePhase2";

const SCENARIOS = ["low", "mid", "high"];
const QUICK_YEARS = [2030, 2035, 2040];
const YEAR_MIN = 2025;
const YEAR_MAX = 2050;
const DC_MAX_MW = 3000;

const KIND_BADGE: Record<Provenance["kind"], string> = {
  observed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  assumption: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  simulated: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  inferred: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
};

export function ForecastView({ embedded = false }: { embedded?: boolean }) {
  const body = <ForecastBody />;
  return embedded ? (
    body
  ) : (
    <Panel title="Demand forecast" owner="A · Forecast">
      {body}
    </Panel>
  );
}

function ForecastBody() {
  const request = usePhase2((s) => s.request);
  const forecast = usePhase2((s) => s.forecast);
  const status = usePhase2((s) => s.forecastStatus);
  const siteRequest = usePhase2((s) => s.siteRequest);

  // Opened again after a failure (e.g. the backend restarted): try once more.
  useEffect(() => {
    if (getPhase2State().forecastStatus === "error") retryPhase2();
  }, []);

  let main: ReactNode;
  if (forecast?.available) main = <ForecastContent forecast={forecast} request={request} status={status} />;
  else if (forecast || status === "error") main = <Unavailable />;
  else main = <Loading />;

  return (
    <div className="space-y-5 text-sm">
      {main}
      {/* TODO(after B's Sites panel merges): also pass recommendation={recommendation} (usePhase2((s) => s.recommendation)) and onRequestChange={setSiteRequest}. */}
      <PanelGuard name="Where to build">
        <SitesPanel request={siteRequest} />
      </PanelGuard>
      {forecast?.available && <SourcesAndNotes forecast={forecast} />}
    </div>
  );
}

function Loading() {
  return (
    <div className="space-y-2" aria-busy="true">
      <p className="text-sm text-zinc-500">Loading the demand forecast…</p>
      <div className="h-3 w-3/4 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-3 w-1/2 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-24 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
    </div>
  );
}

function Unavailable() {
  return (
    <p className="rounded-md bg-zinc-50 px-3 py-2 text-sm text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
      Forecast unavailable right now.{" "}
      <button type="button" className="font-medium underline" onClick={retryPhase2}>
        Retry
      </button>
    </p>
  );
}

function Section({ title, action, children }: { title: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="inline-flex rounded-md border border-zinc-300 p-0.5 text-xs dark:border-zinc-700" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded px-2.5 py-0.5 ${
            value === o.value ? "bg-zinc-900 font-medium text-white dark:bg-zinc-100 dark:text-black" : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Slider(props: {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const { label, value, min, max, step, format, onChange, hint, disabled } = props;
  const id = useId();
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)) + 1);
  return (
    <div className={disabled ? "opacity-50" : undefined}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-xs text-zinc-600 dark:text-zinc-400">
          {label}
        </label>
        <span className="text-xs font-medium tabular-nums">{format(value)}</span>
      </div>
      <input
        id={id}
        type="range"
        className="w-full accent-sky-600 dark:accent-sky-500"
        min={min}
        max={Math.max(max, value)}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(Number(e.target.value).toFixed(decimals)))}
      />
      {hint && <p className="text-[11px] leading-snug text-zinc-500">{hint}</p>}
    </div>
  );
}

function Stat({ label, value, sub }: { label: ReactNode; value: string; sub: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="text-xl font-semibold leading-tight">{value}</div>
      <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{sub}</div>
    </div>
  );
}

function ForecastContent({ forecast, request, status }: { forecast: DemandForecast; request: ForecastRequest; status: LoadStatus }) {
  const { scenario } = useGridForge();
  const scenarioId = request.scenario ?? "mid";
  const year = request.year ?? DEFAULT_YEAR;
  const baseYear = forecast.base_year ?? 2024;
  const params = effectiveParams(request, forecast);
  const adjusted = isAdjusted(request, forecast);
  const preset = presetOf(forecast, scenarioId);
  const note = typeof preset?.note === "string" ? preset.note : null;
  const options = SCENARIOS.filter((s) => !forecast.scenarios || s in forecast.scenarios).map((s) => ({ value: s, label: scenarioLabel(s) }));

  // The data-center slider edits the selected site's county (Kern, the demo site, when unknown).
  const siteCounty = countyByName(forecast, scenario?.site.county);
  const dcCounty = siteCounty ?? countyByGeoid(forecast, DEFAULT_DC_GEOID);
  const dcGeoid = dcCounty?.geoid ?? DEFAULT_DC_GEOID;

  // Highlighted region: the user's pick, else the selected site's region, else the fastest-growing one.
  const [regionPick, setRegionPick] = useState<string | null>(null);
  const regions = forecast.regions ?? [];
  const fastest = [...regions].sort((a, b) => b.growth_peak_mw_p90 - a.growth_peak_mw_p90)[0]?.region;
  const region = (regionPick && regions.some((r) => r.region === regionPick) ? regionPick : null) ?? siteCounty?.region ?? fastest ?? "";

  const t = totals(forecast);
  const resultYear = forecast.year;
  const updating = status === "loading";
  const reset = adjusted ? (
    <button type="button" onClick={resetToPreset} className="text-[11px] font-medium text-sky-700 hover:underline dark:text-sky-400">
      Reset to preset
    </button>
  ) : null;

  return (
    <>
      <Section title={<Term k="forecast_scenario">Scenario</Term>} action={reset}>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented value={scenarioId} options={options} onChange={selectScenario} label="Scenario preset" />
          {adjusted && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">adjusted</span>}
        </div>
        {note && <p className="mt-1 text-xs leading-snug text-zinc-500 dark:text-zinc-400">{note}</p>}
        <div className="mt-3">
          <div className="flex items-baseline justify-between">
            <span className="text-xs text-zinc-600 dark:text-zinc-400">Target year</span>
            <span className="text-sm font-semibold tabular-nums">{year}</span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <div className="flex gap-1">
              {QUICK_YEARS.map((y) => (
                <button
                  key={y}
                  type="button"
                  aria-pressed={y === year}
                  onClick={() => updateForecast({ year: y }, { immediate: true })}
                  className={`rounded border px-2 py-0.5 text-xs tabular-nums ${
                    y === year
                      ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-black"
                      : "border-zinc-300 text-zinc-700 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300"
                  }`}
                >
                  {y}
                </button>
              ))}
            </div>
            <input
              type="range"
              aria-label="Target year"
              className="min-w-0 flex-1 accent-sky-600 dark:accent-sky-500"
              min={YEAR_MIN}
              max={Math.max(YEAR_MAX, year)}
              step={1}
              value={year}
              onChange={(e) => updateForecast({ year: Number(e.target.value) })}
            />
          </div>
        </div>
      </Section>

      {/* Headline numbers stay in view while the assumptions below are adjusted. */}
      {t && (
        <div className="sticky top-0 z-10 grid grid-cols-2 gap-3 border-y border-zinc-200 bg-white py-2 dark:border-zinc-800 dark:bg-zinc-950" aria-live="polite">
          <Stat
            label={`New peak demand by ${resultYear}`}
            value={signedMw(t.growthPeak)}
            sub={
              <>
                <Term k="p50_p90">P90</Term>, {signedPct(t.basePeak > 0 ? t.growthPeak / t.basePeak : null)} vs {baseYear} · all regions
              </>
            }
          />
          <Stat
            label={`New annual energy by ${resultYear}`}
            value={signedMwh(t.energy - t.baseEnergy)}
            sub={`${signedPct(t.baseEnergy > 0 ? t.energy / t.baseEnergy - 1 : null)} vs ${baseYear}`}
          />
          {updating && <span className="absolute right-0 top-1 text-[10px] text-zinc-400">updating…</span>}
        </div>
      )}

      <Section
        title={
          <>
            Peak demand by <Term k="load_region">load region</Term>
          </>
        }
      >
        <RegionChart regions={regions} selected={region} onSelect={setRegionPick} baseYear={baseYear} />
      </Section>

      <Section title={`Top counties · new P90 peak by ${resultYear}`}>
        <CountyBars forecast={forecast} highlight={siteCounty?.geoid ?? null} />
        <p className="mt-1.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">County demand is an estimate: regional load split by population.</p>
      </Section>

      <Section title="What-if assumptions" action={reset}>
        <div className="space-y-3">
          <Slider
            label="Electrification growth"
            value={params.electrification_growth}
            min={0}
            max={0.04}
            step={0.001}
            format={perYear}
            onChange={(v) => updateForecast({ electrification_growth: v })}
            hint="Per-capita demand from EVs, heat pumps and industry."
          />
          <Slider
            label="Efficiency offset"
            value={params.efficiency_offset}
            min={0}
            max={0.02}
            step={0.001}
            format={(v) => `−${perYear(v)}`}
            onChange={(v) => updateForecast({ efficiency_offset: v })}
          />
          <PopulationControl params={params} />
          <DataCenterControls params={params} forecast={forecast} geoid={dcGeoid} countyLabel={dcCounty ? `${dcCounty.county} County` : "Kern County"} fromSite={!!siteCounty} />
        </div>
      </Section>
    </>
  );
}

function PopulationControl({ params }: { params: EffectiveParams }) {
  const dof = params.use_dof_population;
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-zinc-600 dark:text-zinc-400">Population</span>
        <Segmented
          value={dof ? "dof" : "flat"}
          label="Population projection"
          options={[
            { value: "dof", label: "CA DOF county projections" },
            { value: "flat", label: "Flat rate" },
          ]}
          onChange={(v) => updateForecast({ use_dof_population: v === "dof" })}
        />
      </div>
      {dof ? (
        <p className="mt-1 text-[11px] leading-snug text-zinc-500">Each county grows as the California Department of Finance projects (P-2A).</p>
      ) : (
        <div className="mt-1.5">
          <Slider
            label="Population growth, every county"
            value={params.population_growth}
            min={-0.005}
            max={0.015}
            step={0.001}
            format={(v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${perYear(Math.abs(v))}`}
            onChange={(v) => updateForecast({ population_growth: v })}
          />
        </div>
      )}
    </div>
  );
}

function DataCenterControls({ params, forecast, geoid, countyLabel, fromSite }: { params: EffectiveParams; forecast: DemandForecast; geoid: string; countyLabel: string; fromSite: boolean }) {
  const dc = params.data_center_mw;
  const setCounty = (g: string, v: number) => {
    const next = { ...dc };
    if (v > 0) next[g] = v;
    else delete next[g];
    updateForecast({ data_center_mw: next });
  };
  const listed = Object.entries(dc)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = listed.reduce((a, [, v]) => a + v, 0);

  return (
    <div className="space-y-3 rounded-md border border-zinc-200 p-2.5 dark:border-zinc-800">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium">New data centers</span>
        <span className="text-[11px] tabular-nums text-zinc-500">{total > 0 ? `${mw(total)} total` : "none"}</span>
      </div>
      {listed.length > 0 && (
        <ul className="flex flex-wrap gap-1" aria-label="Counties with new data-center load">
          {listed.map(([g, v]) => (
            <li key={g} className={`inline-flex items-center gap-1 rounded-full py-0.5 pl-2 pr-1 text-[11px] ${g === geoid ? "bg-sky-100 dark:bg-sky-950" : "bg-zinc-100 dark:bg-zinc-800"}`}>
              {countyName(forecast, g)} <span className="tabular-nums text-zinc-500 dark:text-zinc-400">{mw(v)}</span>
              <button
                type="button"
                onClick={() => setCounty(g, 0)}
                className="rounded-full px-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
                aria-label={`Remove the data-center load in ${countyName(forecast, g)}`}
                title="Remove"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <Slider
        label={
          <>
            {countyLabel} <span className="text-zinc-400">{fromSite ? "· selected site" : "· demo site"}</span>
          </>
        }
        value={dc[geoid] ?? 0}
        min={0}
        max={DC_MAX_MW}
        step={50}
        format={mw}
        onChange={(v) => setCounty(geoid, v)}
        hint={fromSite ? undefined : "Select a site on the map to add load in its county."}
      />
      <Slider
        label={<Term k="load_factor">Load factor</Term>}
        value={params.data_center_load_factor}
        min={0.5}
        max={1}
        step={0.05}
        format={pct}
        onChange={(v) => updateForecast({ data_center_load_factor: v })}
      />
      <Slider
        label={
          <>
            Carbon-aware <Term k="flexible_load">flexible share</Term>
          </>
        }
        value={params.data_center_flexible_share}
        min={0}
        max={1}
        step={0.05}
        format={pct}
        onChange={(v) => updateForecast({ data_center_flexible_share: v })}
        hint="Share of data-center load scheduled out of the peak hour: it adds energy but not peak."
      />
    </div>
  );
}

function SourcesAndNotes({ forecast }: { forecast: DemandForecast }) {
  const provenance = Array.isArray(forecast.provenance) ? forecast.provenance : [];
  const notes = Array.isArray(forecast.notes) ? forecast.notes : [];
  if (!provenance.length && !notes.length) return null;
  return (
    <div className="space-y-2">
      {notes.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {provenance.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer select-none text-[11px] font-semibold uppercase tracking-wide text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
            Sources ({provenance.length})
          </summary>
          <ul className="mt-2 space-y-2">
            {provenance.map((p, i) => {
              const url = safeUrl(p.url);
              return (
                <li key={`${p.source}-${i}`} className="text-xs">
                  <span className={`mr-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${KIND_BADGE[p.kind] ?? KIND_BADGE.assumption}`}>{p.kind}</span>
                  {url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer" className="underline decoration-zinc-300 hover:decoration-zinc-500">
                      {p.source}
                    </a>
                  ) : (
                    <span>{p.source}</span>
                  )}
                  {p.note && <div className="mt-0.5 text-zinc-500">{p.note}</div>}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}
