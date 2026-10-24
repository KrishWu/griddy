"use client";
// Selected-site summary: grid context, nearby plants, findings and sources.  OWNER: workstream A (Explore / GIS).
import { useMemo, type ReactNode } from "react";

import { FindingsList } from "@/components/shell/FindingsList";
import { Panel } from "@/components/shell/Panel";
import type { Provenance, SiteSummary } from "@/lib/contract";
import { useGridForge } from "@/lib/store";

import { fmtKm, fmtKv, fmtMw, safeUrl } from "./geo";
import { FUEL_COLOR, FUEL_LABEL, voltageClass } from "./palette";
import { Dot, LineSwatch } from "./Swatch";
import { readSummary, useSiteSummary, type SiteView, type SubstationRef } from "./useSiteSummary";

const KIND_BADGE: Record<Provenance["kind"], string> = {
  observed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  assumption: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  simulated: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  inferred: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
};

export function SitePanel() {
  const { scenario } = useGridForge();
  const { summary, loading, error } = useSiteSummary();
  const view = useMemo(() => (summary ? readSummary(summary) : null), [summary]);
  if (!scenario) return null;
  const { lon, lat } = scenario.site.location;
  return (
    <Panel title="Site" owner="A · Explore">
      <p className="mb-3 text-sm">
        <span className="font-medium">{scenario.site.name}</span>
        <span className="text-zinc-500">
          {" "}
          · {lat.toFixed(3)}, {lon.toFixed(3)}
        </span>
      </p>
      {summary && view ? (
        <SiteDetails summary={summary} v={view} />
      ) : loading ? (
        <div className="space-y-2" aria-busy="true">
          <p className="text-sm text-zinc-500">Loading site summary…</p>
          <div className="h-3 w-3/4 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
        </div>
      ) : error ? (
        <p className="text-sm text-red-600">Could not load the site summary: {error}</p>
      ) : (
        <p className="text-sm text-zinc-500">Click the map to select a site.</p>
      )}
    </Panel>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{title}</h3>
      {children}
    </section>
  );
}

function Fact({ label, value, title }: { label: string; value: string | null; title?: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-zinc-500">{label}</dt>
      <dd className="truncate font-medium" title={title ?? value ?? undefined}>
        {value ?? "–"}
      </dd>
    </div>
  );
}

function SubstationRow({ s, note }: { s: SubstationRef; note?: string }) {
  return (
    <li className="flex items-center gap-2">
      <Dot color={voltageClass(s.voltage_kv).color} ring size={9} />
      <span className="min-w-0 flex-1 truncate" title={[s.name, s.operator].filter(Boolean).join(" · ")}>
        {note && <span className="text-zinc-500">{note} </span>}
        {s.name}
      </span>
      <span className="shrink-0 text-xs text-zinc-500">{fmtKv(s.voltage_kv)}</span>
      <span className="w-14 shrink-0 text-right tabular-nums">{fmtKm(s.distance_km)}</span>
    </li>
  );
}

function SiteDetails({ summary, v }: { summary: SiteSummary; v: SiteView }) {
  const county = v.county ? (/county/i.test(v.county) ? v.county : `${v.county} County`) : null;
  const hv = v.hvSubstation && !v.substations.some((s) => s.id === v.hvSubstation?.id) ? v.hvSubstation : null;
  const closerLine =
    v.anyLine && v.anyLine.distance_km !== null && (v.hvLine?.distance_km ?? Infinity) - v.anyLine.distance_km > 0.05 ? v.anyLine : null;
  const provenance = Array.isArray(summary.provenance) ? summary.provenance : [];

  return (
    <div className="space-y-4 text-sm">
      {v.inCalifornia === false && (
        <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Outside California: the grid layers and distances cover California only.
        </p>
      )}

      <dl className="grid grid-cols-3 gap-2">
        <Fact label="County" value={county} />
        <Fact label="Utility" value={v.utility} title={v.utilityTitle} />
        <Fact label="Balancing auth." value={v.balancingAuthority} title={v.balancingAuthorityTitle} />
      </dl>

      <Section title="Nearest substations">
        {v.substations.length || hv ? (
          <ul className="space-y-1">
            {v.substations.slice(0, 4).map((s) => (
              <SubstationRow key={s.id} s={s} />
            ))}
            {hv && <SubstationRow s={hv} note="230 kV+:" />}
          </ul>
        ) : (
          <p className="text-zinc-500">No substations found nearby.</p>
        )}
      </Section>

      <Section title="Nearest 230 kV+ line">
        {v.hvLine ? (
          <p className="flex items-center gap-2">
            <LineSwatch color={voltageClass(v.hvLine.voltage_kv).color} />
            <span className="min-w-0 flex-1 truncate" title={v.hvLine.name}>
              {fmtKv(v.hvLine.voltage_kv)}
              {v.hvLine.owner && <span className="text-zinc-500"> · {v.hvLine.owner}</span>}
            </span>
            <span className="w-14 shrink-0 text-right tabular-nums">{fmtKm(v.hvLine.distance_km)}</span>
          </p>
        ) : (
          <p className="text-zinc-500">No operational 230 kV+ line found.</p>
        )}
        {closerLine && (
          <p className="mt-1 text-xs text-zinc-500">
            Closest line of any voltage: {fmtKv(closerLine.voltage_kv)}
            {closerLine.owner ? ` · ${closerLine.owner}` : ""} · {fmtKm(closerLine.distance_km)}
          </p>
        )}
      </Section>

      <Section title="Plants within 25 km">
        {v.plantsCount > 0 ? (
          <>
            <p>
              <span className="font-medium tabular-nums">{v.plantsCount.toLocaleString()}</span> plants ·{" "}
              <span className="font-medium tabular-nums">{fmtMw(v.plantsTotalMw)}</span>
            </p>
            {v.plantsByFuel.length > 0 && (
              <ul className="mt-1.5 flex flex-wrap gap-1">
                {v.plantsByFuel.map(([fuel, total]) => (
                  <li key={fuel} className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800">
                    <Dot color={FUEL_COLOR[fuel]} size={8} />
                    {FUEL_LABEL[fuel]} <span className="tabular-nums text-zinc-500 dark:text-zinc-400">{fmtMw(total)}</span>
                  </li>
                ))}
              </ul>
            )}
            {v.plants.length > 0 && (
              <ul className="mt-2 space-y-1">
                {v.plants.slice(0, 5).map((p) => (
                  <li key={p.id} className="flex items-center gap-2">
                    <Dot color={FUEL_COLOR[p.fuel]} size={8} />
                    <span className="min-w-0 flex-1 truncate" title={`${p.name} (${FUEL_LABEL[p.fuel]})`}>
                      {p.name}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-zinc-500">{fmtMw(p.capacity_mw)}</span>
                    <span className="w-14 shrink-0 text-right tabular-nums">{fmtKm(p.distance_km)}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="text-zinc-500">No operating plants (≥ 1 MW) within 25 km.</p>
        )}
      </Section>

      <Section title="Population within 10 km">
        <p className="tabular-nums">
          {v.population !== null ? `≈ ${Math.round(v.population).toLocaleString()} people (Census estimate)` : <span className="text-zinc-500">Not available</span>}
        </p>
      </Section>

      <Section title="Findings">
        <FindingsList findings={Array.isArray(summary.findings) ? summary.findings : []} />
      </Section>

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
          {v.distanceMethod && <p className="mt-2 text-[11px] text-zinc-500">Distances: {v.distanceMethod}</p>}
        </details>
      )}
    </div>
  );
}
