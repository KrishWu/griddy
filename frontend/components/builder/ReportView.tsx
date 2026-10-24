"use client";
import { ProjectDetails } from "@/components/evaluate/ProjectSummary";
import { projectOf, resilienceOf } from "@/components/evaluate/project";
// Printable scenario report: headline numbers, design, assumptions, every cost
// line with its source, BOM, emissions, findings.  OWNER: workstream D.
// Lives at /report; state comes from GridForgeProvider in the root layout.
import Link from "next/link";
import type { ReactNode } from "react";

import { Term } from "@/components/glossary/Term";
import type { Finding, Provenance, ScenarioResult, SiteIntel, SiteSummary } from "@/lib/contract";
import { mw, mwh, pct, tons, usd } from "@/lib/format";
import type { GlossaryKey } from "@/lib/glossary";
import { useGridForge } from "@/lib/store";

import { ASSET_META } from "./assetMeta";
import { downloadCsv } from "./downloadCsv";

const SEVERITY_STYLE = { pass: "text-emerald-700", info: "text-sky-700", warn: "text-amber-700", fail: "text-red-700" } as const;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="break-inside-avoid space-y-2">
      <h2 className="border-b border-zinc-300 pb-1 text-sm font-semibold uppercase tracking-wide">{title}</h2>
      {children}
    </section>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-zinc-500">
          {head.map((h, i) => (
            <th key={h} className={`py-1 font-medium ${i > 0 ? "text-right" : ""}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-zinc-200 align-top">
            {r.map((c, j) => (
              <td key={j} className={`py-1 ${j > 0 ? "text-right tabular-nums" : ""}`}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function sourceLabel(p: Provenance) {
  return `${p.kind}: ${p.source}`;
}

function allProvenance(r: ScenarioResult, site: (SiteSummary | SiteIntel)[]): Provenance[] {
  const seen = new Map<string, Provenance>();
  const add = (p: Provenance) => seen.set(`${p.kind}|${p.source}|${p.url ?? ""}`, p);
  r.simulation.provenance.forEach(add);
  r.evaluation.economics.lines.forEach((l) => add(l.provenance));
  r.evaluation.emissions.provenance.forEach(add);
  const project = projectOf(r);
  if (project) { add(project.provenance); add(project.jobs.provenance); project.area.demographics?.provenance.forEach(add); }
  const resilience = resilienceOf(r);
  if (resilience) add(resilience.provenance);
  site.forEach((x) => x.provenance.forEach(add));
  return [...seen.values()];
}

/** Site screening only belongs in this report if it was computed for this result's site. */
function sameSpot(a: { lon: number; lat: number }, b: { lon: number; lat: number }) {
  return Math.abs(a.lon - b.lon) < 1e-4 && Math.abs(a.lat - b.lat) < 1e-4;
}

function FindingList({ findings }: { findings: Finding[] }) {
  return (
    <ul className="space-y-1 text-xs">
      {findings.map((f) => (
        <li key={`${f.module}-${f.id}`}>
          <span className={`font-semibold uppercase ${SEVERITY_STYLE[f.severity]}`}>{f.severity}</span> {f.title}: {f.detail}
          {f.needs_utility_study && <span className="text-amber-700"> (needs a utility study)</span>}
        </li>
      ))}
    </ul>
  );
}

export function ReportView() {
  const { result, siteSummary, siteIntel } = useGridForge();

  if (!result) {
    return (
      <main className="mx-auto max-w-2xl space-y-3 p-8">
        <h1 className="text-xl font-bold">Griddy report</h1>
        <p className="text-sm text-zinc-600">No scenario has been run in this tab yet (reloading the page clears results).</p>
        <Link href="/" className="inline-block rounded bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white">
          Back to the planner
        </Link>
      </main>
    );
  }

  const { scenario: sc, simulation, evaluation } = result;
  const s = simulation.summary;
  const e = evaluation.economics;
  const em = evaluation.emissions;
  const a = sc.assumptions ?? {};
  const loc = sc.site.location;
  const summary = siteSummary && sameSpot(siteSummary.site.location, loc) ? siteSummary : null;
  const intel = siteIntel && sameSpot(siteIntel.location, loc) ? siteIntel : null;
  const sources = allProvenance(result, [summary, intel].filter((x): x is SiteSummary | SiteIntel => x !== null));
  const syntheticPrices = simulation.provenance.some((p) => /^(STUB|PLACEHOLDER)/.test(p.source));
  const placeholder = sources.some((p) => /^(STUB|PLACEHOLDER)/.test(p.source));

  return (
    <div className="min-h-screen bg-zinc-100 py-6 print:bg-white print:py-0">
      <main className="mx-auto max-w-4xl space-y-6 rounded-lg bg-white p-8 text-zinc-900 shadow-sm print:max-w-none print:rounded-none print:p-0 print:shadow-none">
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <Link href="/" className="text-sm text-emerald-700 hover:underline">
            ← Back to the planner
          </Link>
          <span className="ml-auto" />
          <button className="rounded border border-zinc-300 px-3 py-1 text-sm" onClick={() => void downloadCsv(result)}>
            Download CSV
          </button>
          <button className="rounded bg-zinc-900 px-3 py-1 text-sm text-white" onClick={() => window.print()}>
            Print / Save as PDF
          </button>
        </div>

        <header className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-zinc-500">Griddy scenario report</p>
          <h1 className="text-2xl font-bold">{sc.name}</h1>
          <p className="text-sm text-zinc-600">
            {sc.site.name} · {sc.site.location.lat.toFixed(3)}, {sc.site.location.lon.toFixed(3)}
            {sc.site.county ? ` · ${sc.site.county} County` : ""}
            {sc.site.utility_territory ? ` · ${sc.site.utility_territory}` : ""} · {sc.mode === "community" ? "Community microgrid" : "Industrial / AI campus"}
          </p>
          {placeholder && (
            <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
              Some figures still use placeholder data or stub models; they are marked in the sources below.
            </p>
          )}
        </header>

        <Section title="Headline results">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                ["CAPEX", usd(e.capex_total_usd), "capex"],
                ["Annual OPEX", usd(e.annual_opex_usd), "opex"],
                ["Net present cost", usd(e.npc_usd), "npc"],
                ["LCOE", `$${e.lcoe_usd_per_mwh.toFixed(0)}/MWh`, "lcoe"],
                ["CO2e per year", tons(em.annual_t_co2e), "co2e"],
                ["Carbon intensity", `${Math.round(em.intensity_kg_per_mwh)} kg/MWh`, "co2_intensity"],
                ["On-site clean share", pct(s.onsite_clean_share), "onsite_clean_share"],
                ["Unmet demand", `${s.hours_unmet} h (${mwh(s.unmet_mwh)})`, "unmet"],
              ] as [string, string, GlossaryKey][]
            ).map(([label, value, term]) => (
              <div key={label} className="rounded border border-zinc-200 p-2">
                <div className="text-[11px] text-zinc-500">
                  <Term k={term}>{label}</Term>
                </div>
                <div className="text-base font-semibold tabular-nums">{value}</div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-zinc-500">Financial boundary: {e.financial_boundary}</p>
        </Section>

        <div className="grid gap-6 sm:grid-cols-2">
          <Section title="Design">
            <Table
              head={["Asset", "Capacity", "Energy"]}
              rows={[
                ...sc.assets.map((x) => [
                  ASSET_META[x.kind].label,
                  mw(x.capacity_mw),
                  x.kind === "battery" ? `${mwh(x.capacity_mw * (x.duration_h ?? 4))} (${x.duration_h ?? 4} h)` : "",
                ]),
                ["Grid import limit", mw(sc.grid.import_limit_mw), ""],
                ["Grid export limit", mw(sc.grid.export_limit_mw ?? 0), ""],
              ]}
            />
          </Section>
          <Section title="Demand and grid">
            <Table
              head={["", "Value"]}
              rows={[
                ...(sc.mode === "community"
                  ? [["Peak demand", mw(sc.demand.peak_mw)]]
                  : [
                      ["IT load (compute)", mw(sc.demand.peak_mw / (sc.demand.pue ?? 1.2))],
                      [<Term key="t" k="pue">PUE</Term>, (sc.demand.pue ?? 1.2).toFixed(2)],
                      ["Facility peak (IT × PUE)", mw(sc.demand.peak_mw)],
                    ]),
                [<Term key="t" k="load_factor">Load factor</Term>, (sc.demand.load_factor ?? 0.9).toFixed(2)],
                ["Load profile", sc.demand.profile ?? "flat"],
                ["Annual demand", mwh(s.demand_mwh)],
                ["Peak grid import", mw(s.peak_import_mw)],
                ["New line to grid", `${(sc.grid.interconnection_km ?? 0).toFixed(0)} km`],
                [<Term key="t" k="poi">Point of interconnection</Term>, sc.grid.poi_voltage_kv ? `${Math.round(sc.grid.poi_voltage_kv)} kV` : "not yet known"],
              ]}
            />
          </Section>
        </div>

        <Section title="Assumptions">
          <Table
            head={["Assumption", "Value"]}
            rows={[
              ["Weather / price year", String(a.weather_year ?? 2024)],
              ["Analysis period", `${a.analysis_years ?? 20} years`],
              [<Term key="t" k="discount_rate">Discount rate</Term>, `${((a.discount_rate ?? 0.07) * 100).toFixed(1)}%`],
              ["Gas price (annual average)", `$${(a.gas_price_usd_per_mmbtu ?? 3.65).toFixed(2)}/MMBtu`],
              ["Carbon price (on-site combustion)", `$${(a.carbon_price_usd_per_t ?? 0).toFixed(0)}/t`],
              [
                "Grid prices",
                a.price_source === "flat"
                  ? `Flat $${(a.flat_price_usd_per_mwh ?? 60).toFixed(0)}/MWh every hour (what-if assumption)`
                  : syntheticPrices
                    ? "Synthetic hourly placeholder (CAISO 2024 pending)"
                    : "CAISO 2024 hourly, per the simulation sources below",
              ],
              [<Term key="t" k="import_adder">Import delivery adder</Term>, `$${(a.import_adder_usd_per_mwh ?? 20).toFixed(0)}/MWh`],
            ]}
          />
        </Section>

        <ProjectDetails result={result} expanded />

        <Section title="Costs">
          <Table
            head={["Item", "Category", "Amount", "Source"]}
            rows={e.lines.map((l) => [
              l.item,
              l.category.replace("_", " "),
              `${usd(l.usd)}${l.category === "capex" ? "" : " /yr"}`,
              <span key="s" className="text-zinc-500">
                {sourceLabel(l.provenance)}
              </span>,
            ])}
          />
        </Section>

        {e.bom.length > 0 && (
          <Section title="Bill of materials">
            <Table head={["Item", "Quantity", "Basis"]} rows={e.bom.map((b) => [b.item, `${b.quantity.toLocaleString()} ${b.unit}`, b.basis])} />
          </Section>
        )}

        <Section title="Emissions">
          <Table
            head={["Source", "t CO2e / yr"]}
            rows={Object.entries(em.by_source_t_co2e).map(([k, v]) => [k === "grid_imports" ? "Grid imports" : (ASSET_META[k as keyof typeof ASSET_META]?.label ?? k), tons(v)])}
          />
        </Section>

        {(summary || intel) && (
          <Section title="Site screening">
            {summary && summary.nearest_substations.length > 0 && (
              <Table
                head={["Nearest substations", "Distance", "Voltage"]}
                rows={summary.nearest_substations.map((s) => [
                  s.name,
                  `${s.distance_km.toFixed(1)} km`,
                  typeof s.voltage_kv === "number" ? `${Math.round(s.voltage_kv)} kV` : "",
                ])}
              />
            )}
            <FindingList findings={[...(summary?.findings ?? []), ...(intel?.findings ?? [])]} />
          </Section>
        )}

        <Section title="Feasibility findings">
          <FindingList findings={result.findings} />
        </Section>

        <Section title="Sources">
          <ul className="space-y-0.5 text-xs text-zinc-600">
            {sources.map((p) => (
              <li key={`${p.kind}|${p.source}|${p.url ?? ""}`}>
                <span className="font-medium">{p.kind}</span>: {p.source}
                {p.url && <span className="text-zinc-400"> ({p.url})</span>}
              </li>
            ))}
          </ul>
        </Section>
      </main>
    </div>
  );
}
