"use client";
// Top counties by new P90 peak: one bar per county, split into population & electrification growth
// and new data-center load (its firm, non-flexible share, as it lands on the peak).  OWNER: workstream A.
import type { CountyForecast, DemandForecast } from "@/lib/contract";
import { mw } from "@/lib/format";

import { CHART_THEME } from "./RegionChart";
import { dataCenterPeakMw, regionShort, signedMw } from "./forecastData";

const TOP_N = 8;

export function CountyBars({ forecast, highlight }: { forecast: DemandForecast; highlight?: string | null }) {
  const counties: CountyForecast[] = [...(forecast.counties ?? [])].sort((a, b) => b.growth_peak_mw_p90 - a.growth_peak_mw_p90).slice(0, TOP_N);
  if (!counties.length) return null;
  const max = Math.max(1, ...counties.map((c) => c.growth_peak_mw_p90));
  const anyDc = counties.some((c) => (c.added_load_mw ?? 0) > 0);

  return (
    <div className={CHART_THEME}>
      <ul className="space-y-1.5">
        {counties.map((c) => {
          const growth = Math.max(0, c.growth_peak_mw_p90);
          const dc = dataCenterPeakMw(c, forecast);
          const organic = Math.max(0, growth - dc);
          const added = c.added_load_mw ?? 0;
          const on = highlight === c.geoid;
          return (
            <li key={c.geoid} className="text-xs">
              <div className="flex items-center gap-2">
                <span className={`w-24 shrink-0 truncate ${on ? "font-semibold" : ""}`} title={`${c.county} County · ${regionShort(c.region)}`}>
                  {c.county}
                </span>
                {/* Bar: organic growth then data centers, a 2 px surface gap between the segments. */}
                <span className="flex h-2.5 min-w-0 flex-1 items-center" aria-hidden>
                  <span className="flex h-full gap-[2px]" style={{ width: `${(growth / max) * 100}%` }}>
                    {organic > 0 && <span className="h-full rounded-l-[3px] last:rounded-r-[3px]" style={{ flexGrow: organic, background: "var(--fc-accent)" }} />}
                    {dc > 0 && <span className="h-full rounded-r-[3px] first:rounded-l-[3px]" style={{ flexGrow: dc, background: "var(--fc-dc)" }} />}
                  </span>
                </span>
                <span className="w-[4.5rem] shrink-0 text-right font-medium tabular-nums">{signedMw(c.growth_peak_mw_p90)}</span>
              </div>
              {added > 0 && (
                <div className="ml-[6.5rem] text-[10px] text-zinc-500 dark:text-zinc-400">incl. {mw(added)} new data centers</div>
              )}
            </li>
          );
        })}
      </ul>
      <ul className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-zinc-500 dark:text-zinc-400">
        <li className="flex items-center gap-1">
          <span aria-hidden className="inline-block h-2 w-2 rounded-[2px]" style={{ background: "var(--fc-accent)" }} />
          Population &amp; electrification
        </li>
        {anyDc && (
          <li className="flex items-center gap-1">
            <span aria-hidden className="inline-block h-2 w-2 rounded-[2px]" style={{ background: "var(--fc-dc)" }} />
            New data centers (firm share at peak)
          </li>
        )}
      </ul>
    </div>
  );
}
