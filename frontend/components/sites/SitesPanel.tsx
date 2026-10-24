"use client";
// Where to build: recommended sites for the forecast demand growth (Phase 2).  OWNER: workstream B.
// Renders the SiteRecommendation for the forecast view's SiteRequest. When the parent passes
// `recommendation` (its shared state already fetched it, so the map shows the same sites) this
// panel only displays it; otherwise it fetches POST /api/sites/whatif itself. Mix changes go to
// `onRequestChange` when given, so the map and this panel stay on one request.
import { useEffect, useMemo, useState } from "react";

import { Term } from "@/components/glossary/Term";
import { Panel, Stat } from "@/components/shell/Panel";
import { post } from "@/lib/api";
import type { AssetKind, SiteCandidate, SiteRecommendation, SiteRequest } from "@/lib/contract";
import { mw, pct, usd } from "@/lib/format";
import { useGridForge } from "@/lib/store";

const KINDS: { kind: AssetKind; label: string; color: string }[] = [
  { kind: "solar_pv", label: "Solar", color: "#E69F00" },
  { kind: "onshore_wind", label: "Wind", color: "#56B4E9" },
  { kind: "battery", label: "Battery", color: "#E377C2" },
  { kind: "gas_cc", label: "Gas", color: "#4B5563" },
];
const LABEL = Object.fromEntries(KINDS.map((k) => [k.kind, k.label])) as Record<string, string>;
const COLOR = Object.fromEntries(KINDS.map((k) => [k.kind, k.color])) as Record<string, string>;
// Same defaults as backend/app/sites/service.py DEFAULT_MIX.
const DEFAULT_MIX = { clean_energy_share: 0.8, solar_pv: 0.75, onshore_wind: 0.25, battery: 0.7, gas_cc: 0.3 };
const SHOWN = 8;

type Mix = typeof DEFAULT_MIX;

function useRecommendation(request: SiteRequest, given: SiteRecommendation | null | undefined) {
  const [own, setOwn] = useState<{ key: string; rec: SiteRecommendation | null; error: string | null } | null>(null);
  const key = JSON.stringify(request);
  const fetchOwn = given === undefined;
  useEffect(() => {
    if (!fetchOwn) return;
    let stale = false;
    const t = setTimeout(() => {
      post<SiteRecommendation>("/sites/whatif", JSON.parse(key)).then(
        (rec) => !stale && setOwn({ key, rec, error: null }),
        (e: unknown) => !stale && setOwn({ key, rec: null, error: e instanceof Error ? e.message : String(e) }),
      );
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [key, fetchOwn]);
  if (!fetchOwn) return { rec: given ?? null, loading: given === null, error: null };
  return { rec: own?.key === key ? own.rec : null, loading: own?.key !== key, error: own?.key === key ? own.error : null };
}

function Slider({ label, value, onChange, left, right }: { label: string; value: number; onChange: (v: number) => void; left?: string; right?: string }) {
  return (
    <label className="block text-xs">
      <span className="flex justify-between text-zinc-500">
        <span>{label}</span>
        <span className="tabular-nums text-zinc-700 dark:text-zinc-300">{left && right ? `${left} ${pct(1 - value)} · ${right} ${pct(value)}` : pct(value)}</span>
      </span>
      <input type="range" min={0} max={1} step={0.05} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-emerald-600" aria-label={label} />
    </label>
  );
}

function SiteRow({ s, onUse }: { s: SiteCandidate; onUse: (s: SiteCandidate) => void }) {
  return (
    <li className="py-1.5">
      <div className="flex items-start gap-2 text-sm">
        <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: COLOR[s.kind] ?? "#9CA3AF" }} />
        <div className="min-w-0 flex-1">
          <div className="flex justify-between gap-2">
            <span className="font-medium">
              {LABEL[s.kind] ?? s.kind} · {mw(s.mw)}
            </span>
            <span className="shrink-0 text-xs text-zinc-500">{s.county ? `${s.county} Co.` : s.region}</span>
          </div>
          <p className="text-xs text-zinc-500">{s.reason}</p>
          <div className="mt-0.5 flex items-center justify-between text-xs">
            <span className="tabular-nums text-zinc-600 dark:text-zinc-400">
              {s.capex_usd != null && `CAPEX ${usd(s.capex_usd)}`}
              {s.gen_tie_usd != null && s.gen_tie_usd > 0 && ` + gen-tie ${usd(s.gen_tie_usd)}`}
            </span>
            <button type="button" onClick={() => onUse(s)} className="font-medium text-emerald-700 underline hover:text-emerald-900 dark:text-emerald-400">
              Use this site
            </button>
          </div>
        </div>
      </div>
    </li>
  );
}

export function SitesPanel({
  request,
  recommendation,
  onRequestChange,
}: {
  request: SiteRequest;
  recommendation?: SiteRecommendation | null;
  onRequestChange?: (r: SiteRequest) => void;
}) {
  const { selectSite } = useGridForge();
  const [localMix, setLocalMix] = useState<Partial<Mix> | null>(null);
  const mix: Mix = { ...DEFAULT_MIX, ...(request.mix ?? {}), ...(onRequestChange ? {} : (localMix ?? {})) };
  const effective = useMemo<SiteRequest>(() => (onRequestChange || !localMix ? request : { ...request, mix: { ...(request.mix ?? {}), ...localMix } }), [request, localMix, onRequestChange]);
  const { rec, loading, error } = useRecommendation(effective, recommendation);
  const [showAll, setShowAll] = useState(false);
  const [showSources, setShowSources] = useState(false);

  const setMix = (patch: Partial<Mix>) => {
    if (onRequestChange) onRequestChange({ ...request, mix: { ...mix, ...patch } });
    else setLocalMix((m) => ({ ...(m ?? {}), ...patch }));
  };
  const pickSite = (s: SiteCandidate) => void selectSite(s.location);

  const totals = useMemo(() => {
    const t = new Map<string, number>();
    for (const s of rec?.sites ?? []) t.set(s.kind, (t.get(s.kind) ?? 0) + s.mw);
    return t;
  }, [rec]);
  const unmet = Object.entries(rec?.unmet_mw ?? {}).filter(([, v]) => v > 0.5);
  const sites = rec?.sites ?? [];

  return (
    <Panel title="Where to build" owner="B · Sites">
      {error ? (
        <p className="text-sm text-red-600">Could not load site recommendations.</p>
      ) : !rec && loading ? (
        <p className="text-sm text-zinc-500">Finding sites…</p>
      ) : !rec?.available ? (
        <p className="text-sm text-zinc-500">Site recommendations aren&apos;t available right now.</p>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-zinc-500">
            New capacity to cover the {rec.scenario} <Term k="forecast_scenario">scenario</Term>&apos;s growth by {rec.year}, placed on the best-scoring 5 km cells.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {KINDS.filter((k) => totals.get(k.kind)).map((k) => (
              <div key={k.kind} className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: k.color }} />
                <Stat label={k.label} value={mw(totals.get(k.kind) ?? 0)} />
              </div>
            ))}
          </div>
          {rec.total_capex_usd != null && rec.total_capex_usd > 0 && (
            <p className="text-sm">
              <span className="text-zinc-500">
                <Term k="capex">CAPEX</Term> incl. <Term k="gen_tie">gen-ties</Term>:
              </span> <span className="font-semibold tabular-nums">{usd(rec.total_capex_usd)}</span>
            </p>
          )}
          {unmet.length > 0 && (
            <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
              Not enough suitable cells for {unmet.map(([k, v]) => `${mw(v)} ${LABEL[k] ?? k}`).join(", ")}.
            </p>
          )}

          <fieldset className="space-y-2 rounded border border-zinc-200 p-2 dark:border-zinc-800">
            <legend className="px-1 text-[11px] uppercase tracking-wide text-zinc-500">How to cover it</legend>
            <Slider label="New energy from solar + wind" value={mix.clean_energy_share} onChange={(v) => setMix({ clean_energy_share: v })} />
            <Slider
              label="Clean energy split"
              value={mix.onshore_wind / (mix.solar_pv + mix.onshore_wind || 1)}
              onChange={(v) => setMix({ solar_pv: 1 - v, onshore_wind: v })}
              left="solar"
              right="wind"
            />
            <Slider label="Peak cover split" value={mix.gas_cc / (mix.battery + mix.gas_cc || 1)} onChange={(v) => setMix({ battery: 1 - v, gas_cc: v })} left="battery" right="gas" />
            {rec.capacity_credit && (
              <p className="text-[11px] text-zinc-500">
                At the evening net-load peak, 1 MW of solar <Term k="capacity_credit">counts as</Term> {pct(rec.capacity_credit.solar_pv ?? 0)}
                {rec.capacity_credit.onshore_wind != null && ` and wind as ${pct(rec.capacity_credit.onshore_wind)}`}, so firm capacity covers most of the peak.
              </p>
            )}
          </fieldset>

          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Top sites</h3>
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {(showAll ? sites : sites.slice(0, SHOWN)).map((s) => (
                <SiteRow key={s.id} s={s} onUse={pickSite} />
              ))}
            </ul>
            {sites.length > SHOWN && (
              <button type="button" className="mt-1 text-xs underline text-zinc-600 dark:text-zinc-400" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show fewer" : `Show all ${sites.length} sites`}
              </button>
            )}
          </div>

          <div className="text-[11px] text-zinc-500">
            {(rec.caveats ?? []).map((c) => (
              <p key={c}>{c}</p>
            ))}
            <button type="button" className="mt-1 underline" onClick={() => setShowSources((v) => !v)}>
              {showSources ? "Hide sources" : "Sources"}
            </button>
            {showSources && (
              <ul className="mt-1 list-disc pl-4">
                {(rec.provenance ?? []).map((p, i) => (
                  <li key={`${p.source}-${i}`}>
                    <span className="uppercase">{p.kind}</span> · {p.url ? <a className="underline" href={p.url} target="_blank" rel="noreferrer">{p.source}</a> : p.source}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
