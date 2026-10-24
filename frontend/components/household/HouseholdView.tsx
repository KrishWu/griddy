"use client";
// Griddy Home: the "Individual / Home" scale, laid out like the project workspace. The map stays in
// the centre and the house pin placed on it (click, search or locate-me) is the household location;
// the left sidebar's Home tab holds the profile form, the right sidebar holds the dashboard tabs
// (Usage · Costs · Sources & carbon · What-if · Solar & battery · Outlook · Tips) under headline numbers.
// HouseholdProvider owns the state both sidebars share. Every edit re-plans through
// POST /api/household/plan after a 250 ms pause; a newer edit aborts the older request, and the last
// good result stays on screen while the next one loads. A new pin pre-fills the provider from the
// clicked point's utility territory (GET /api/site/summary); the viewer can still change it.
// OWNER: household (frontend).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Term } from "@/components/glossary/Term";
import { api } from "@/lib/api";

import { errorText, householdApi } from "./api";
import { kg, kwh, num, pct0, usd0 } from "./fmt";
import { setHomePin, useHomePin, type HomePin } from "./homePin";
import { DEFAULT_DRAFT, ProfileForm, toRequest, type ProfileDraft } from "./ProfileForm";
import { OutlookTab, SolarTab, TipsTab } from "./tabsMore";
import { CostsTab, loadProvenance, SimulatedBadge, SourcesTab, UsageTab } from "./tabsUsage";
import type { HouseholdOptions, HouseholdResult, HouseholdWhatIf, TimeSelection, UtilityId } from "./types";
import { TimeContext } from "./TimeContext";
import { FOCUS, StatTile } from "./ui";
import { WhatIfTab } from "./WhatIfTab";

const DEBOUNCE_MS = 250;

export const HOME_TABS = [
  { id: "usage", label: "Usage", title: "Usage", hint: "Usage: your load curve, monthly use and end uses" },
  { id: "costs", label: "Costs", title: "Costs", hint: "Costs: your bill by time-of-use period and on every plan" },
  { id: "sources", label: "Carbon", title: "Sources & carbon", hint: "Sources & carbon: where your power comes from and its CO2e, hour by hour" },
  { id: "whatif", label: "What-if", title: "What-if", hint: "What-if: shift loads, change the thermostat, compare cost and carbon" },
  { id: "solar", label: "Solar", title: "Solar & battery", hint: "Solar & battery: rooftop solar and a battery under the Net Billing Tariff" },
  { id: "outlook", label: "Outlook", title: "Outlook", hint: "Outlook: your bill over the next 5 to 20 years" },
  { id: "tips", label: "Tips", title: "Tips", hint: "Tips: personal recommendations and every assumption" },
] as const;
export type HomeTabId = (typeof HOME_TABS)[number]["id"];

/** Where the pin is, by the territory map (A's site summary). */
export interface PinPlace {
  key: string;
  territory: string | null;
  county: string | null;
  suggested: UtilityId | null;
}

interface HomeState {
  draft: ProfileDraft;
  patchDraft: (p: Partial<ProfileDraft>) => void;
  whatif: HouseholdWhatIf;
  setWhatif: (p: Partial<HouseholdWhatIf>) => void;
  options: HouseholdOptions | null;
  result: HouseholdResult | null;
  error: string | null;
  pending: boolean;
  retry: () => void;
  pin: HomePin | null;
  place: PinPlace | null;
  time: TimeSelection;
  setTime: (patch: Partial<TimeSelection>) => void;
}

const HomeCtx = createContext<HomeState | null>(null);

function useHome(): HomeState {
  const s = useContext(HomeCtx);
  if (!s) throw new Error("Griddy Home panels need <HouseholdProvider>");
  return s;
}

/** CEC utility-territory names (the map's utilities layer) to Griddy Home providers. */
function utilityFor(territory: string | null): UtilityId | null {
  if (!territory) return null;
  const t = territory.toUpperCase();
  if (t.includes("PG&E") || t.includes("PACIFIC GAS")) return "pge";
  // CCSF (Hetch Hetchy) serves city facilities; most San Francisco homes are PG&E delivery customers.
  if (t === "CCSF") return "pge";
  if (t.includes("SDG&E") || t.includes("SAN DIEGO GAS")) return "sdge";
  if (t === "SCE" || t.includes("SOUTHERN CALIFORNIA EDISON")) return "sce";
  return "municipal";
}

const pinKey = (p: HomePin) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;

/** Load-weighted carbon-free share of the CAISO average day: how clean the hours you use are. */
function cleanShare(r: HouseholdResult): number {
  if (r.time_view?.annual_grid_clean_share != null) return r.time_view.annual_grid_clean_share;
  const load = r.usage.avg_day_kwh.all;
  const share = r.sources.caiso_avg_day_clean_share;
  let w = 0;
  let t = 0;
  for (let h = 0; h < 24; h++) {
    w += num(load[h]) * num(share[h]);
    t += num(load[h]);
  }
  return t > 0 ? w / t : 0;
}

/** Holds Griddy Home's state for both sidebars. Inactive (another scale showing): keeps the state
 *  but sends no requests. */
export function HouseholdProvider({ active, children }: { active: boolean; children: ReactNode }) {
  const [draft, setDraft] = useState<ProfileDraft>(DEFAULT_DRAFT);
  const [whatif, setWhatifState] = useState<HouseholdWhatIf>({});
  const [options, setOptions] = useState<HouseholdOptions | null>(null);
  const [result, setResult] = useState<HouseholdResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [place, setPlace] = useState<PinPlace | null>(null);
  const [time, setTimeState] = useState<TimeSelection>({ view_month: null, view_day_type: "all", view_hour: 12 });
  const setTime = useCallback((patch: Partial<TimeSelection>) => setTimeState(v => ({ ...v, ...patch })), []);
  const pin = useHomePin();
  const lastPrefill = useRef<string | null>(null);

  const patchDraft = useCallback((p: Partial<ProfileDraft>) => setDraft((d) => ({ ...d, ...p })), []);
  const setWhatif = useCallback((p: Partial<HouseholdWhatIf>) => setWhatifState((w) => ({ ...w, ...p })), []);
  const retry = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!active || options) return;
    let live = true;
    householdApi
      .options()
      .then((o) => live && setOptions(o))
      .catch(() => {
        /* the form falls back to its built-in lists; the plan call reports the outage */
      });
    return () => {
      live = false;
    };
  }, [active, options, nonce]);

  // A new pin: look up its utility territory and pre-fill the provider (once per pin, so a choice the
  // viewer makes afterwards sticks). PG&E + SVCE stays if the viewer already picked it.
  const key0 = pin ? pinKey(pin) : null;
  useEffect(() => {
    if (!active || !pin || !key0) return;
    let live = true;
    api
      .siteSummary({ lat: pin.lat, lon: pin.lon })
      .then((s) => {
        if (!live) return;
        const territory = s.site.utility_territory ?? null;
        const suggested = utilityFor(territory);
        setPlace({ key: key0, territory, county: s.site.county ?? null, suggested });
        if (lastPrefill.current === key0) return;
        lastPrefill.current = key0;
        if (suggested) setDraft(d => ({ ...d, utility: suggested }));
      })
      .catch(() => {
        if (live) setPlace({ key: key0, territory: null, county: null, suggested: null });
      });
    return () => {
      live = false;
    };
    // pin is captured through key0 (same coordinates, same lookup)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key0]);

  // Drop null what-if keys so the request (and its cache key) only carries real changes.
  const request = useMemo(() => {
    const w = Object.fromEntries(Object.entries(whatif).filter(([, v]) => v !== null && v !== undefined)) as HouseholdWhatIf;
    return { ...toRequest(draft, w), lat: pin?.lat ?? null, lon: pin?.lon ?? null, ...time };
  }, [draft, whatif, pin, time]);
  const key = JSON.stringify(request);

  useEffect(() => {
    if (!active) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setPending(true);
      householdApi
        .plan(JSON.parse(key), ctrl.signal)
        .then((r) => {
          if (ctrl.signal.aborted) return;
          setResult(r);
          setError(null);
        })
        .catch((e: unknown) => {
          if (!ctrl.signal.aborted) setError(errorText(e));
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setPending(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctrl.abort();
      setPending(false);
    };
  }, [active, key, nonce]);

  const value = useMemo<HomeState>(
    () => ({ draft, patchDraft, whatif, setWhatif, options, result, error, pending, retry, pin, place: place && key0 === place.key ? place : null, time, setTime }),
    [draft, patchDraft, whatif, setWhatif, options, result, error, pending, retry, pin, place, key0, time, setTime],
  );
  return <HomeCtx.Provider value={value}>{children}</HomeCtx.Provider>;
}

/** Left sidebar, Home tab: where the house is, then the profile form (Basic + Advanced). */
export function HomeProfilePanel() {
  const { draft, patchDraft, options, result, pin, place } = useHome();
  const located = result
    ? (result.location.note ?? `Solar profile: ${result.location.solar_profile_city}${result.location.city ? ` (for ${result.location.city})` : result.location.zip ? ` (for ${result.location.zip})` : ""}.`)
    : null;
  return (
    <div className="space-y-3 p-3">
      <div className="rounded-md border border-zinc-200 bg-white p-2.5 text-xs dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-start gap-2">
          <span aria-hidden className="mt-0.5 text-base leading-none">⌂</span>
          <div className="min-w-0 flex-1">
            {pin ? (
              <>
                <div className="font-medium text-zinc-900 dark:text-zinc-100">
                  House pin at {pin.lat.toFixed(4)}, {pin.lon.toFixed(4)}
                </div>
                <div className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
                  {place?.territory ? (
                    <>
                      {place.territory} territory{place.county ? `, ${place.county} County` : ""} (CEC utility map)
                      {place.suggested ? ". Provider pre-filled below; change it if your bill says otherwise." : "."}
                      {place.suggested === "pge" && place.county === "Santa Clara" && " Most Santa Clara County cities outside San José buy power from SVCE: pick PG&E + SVCE if it's on your bill."}
                    </>
                  ) : (
                    "Click the map again to move it."
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="font-medium text-zinc-900 dark:text-zinc-100">Place your home on the map</div>
                <div className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
                  Click the map, search a place or use locate-me. It sets your solar profile, climate and provider. A ZIP or city below works too.
                </div>
              </>
            )}
          </div>
          {pin && (
            <button type="button" onClick={() => setHomePin(null)} className={`shrink-0 rounded text-[11px] text-zinc-500 underline hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100 ${FOCUS}`}>
              Clear
            </button>
          )}
        </div>
      </div>
      <ProfileForm draft={draft} onChange={patchDraft} options={options} pinned={!!pin} located={located} />
    </div>
  );
}

function Headline({ r }: { r: HouseholdResult }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <StatTile
        label={<>Electricity use</>}
        tipLabel="Annual electricity use"
        value={kwh(r.usage.annual_kwh)}
        sub={`a year · CA average ${kwh(r.usage.benchmark.ca_avg_annual_kwh)}`}
        provenance={loadProvenance(r)}
      />
      <StatTile
        label="Annual bill (estimate)"
        value={usd0(r.bill.annual_usd)}
        sub={`${r.bill.plan === "custom" ? "at a flat $/kWh" : `on ${r.bill.plan}`}${r.bill.fixed_usd > 0 ? `, incl. ${usd0(r.bill.fixed_usd)} fixed` : ""}`}
        provenance={r.bill.provenance}
      />
      <StatTile label="Grid CO2e (estimate)" tipLabel="Annual grid CO2e" value={`${kg(r.carbon.annual_kg_hourly)}`} sub="a year, from your hourly use" provenance={r.carbon.provenance} />
      <StatTile
        label="Carbon-free share"
        tipLabel="Carbon-free share of your hours"
        value={pct0(cleanShare(r))}
        sub="of grid imports, weighted by every 2024 hour"
        provenance={[
          {
            kind: "inferred",
            source: "Griddy: hourly grid imports × CAISO 2024 hourly carbon-free share, divided by grid imports",
            note: "Regional hourly average, not a measure of which plant supplies your home.",
          },
          ...r.sources.provenance,
        ]}
      />
    </div>
  );
}

/** Right sidebar: headline numbers, notes, then one dashboard section. */
export function HomeDashboard({ tab }: { tab: HomeTabId }) {
  const { draft, whatif, setWhatif, options, result, error, pending, retry, pin, time, setTime } = useHome();

  let panel: ReactNode = null;
  if (result) {
    if (tab === "usage") panel = <UsageTab r={result} />;
    else if (tab === "costs") panel = <CostsTab r={result} />;
    else if (tab === "sources") panel = <SourcesTab r={result} />;
    else if (tab === "whatif") panel = <WhatIfTab r={result} draft={draft} whatif={whatif} setWhatif={setWhatif} options={options} pending={pending} />;
    else if (tab === "solar") panel = <SolarTab r={result} draft={draft} whatif={whatif} setWhatif={setWhatif} />;
    else if (tab === "outlook") panel = <OutlookTab r={result} whatif={whatif} setWhatif={setWhatif} />;
    else panel = <TipsTab r={result} />;
  }

  return (
    <div className="min-w-0 space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="text-sm font-bold text-zinc-900 dark:text-zinc-50">
          Griddy Home <span className="font-medium text-zinc-500 dark:text-zinc-400">· {HOME_TABS.find((t) => t.id === tab)?.title}</span>
        </h2>
        <span className="ml-auto flex items-center gap-2">
          {pending && (
            <span role="status" className="text-xs text-zinc-500 dark:text-zinc-400">
              Updating...
            </span>
          )}
          {result && <SimulatedBadge r={result} />}
        </span>
        <p className="w-full text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
          {pin ? "Your home's" : "A typical home's"} electricity: cost, sources and carbon, hour by hour (2024 calendar). {pin ? "" : "Click the map to place your house."}
        </p>
      </div>

      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          <span className="min-w-0 flex-1 break-words">Couldn&apos;t plan this home: {error}</span>
          <button type="button" onClick={retry} className={`shrink-0 rounded underline ${FOCUS}`}>
            Retry
          </button>
        </div>
      )}

      {!result ? (
        <div className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
          {error ? "Griddy Home needs its backend (/api/household) to run the numbers." : "Planning your home: a year of hourly usage, rates and grid carbon..."}
        </div>
      ) : (
        <>
          <Headline r={result} />
          <TimeContext r={result} value={time} onChange={setTime} />
          {result.warnings.length > 0 && (
            <details className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-200">
              <summary className={`cursor-pointer select-none rounded ${FOCUS}`}>
                {result.warnings.length} {result.warnings.length === 1 ? "note" : "notes"} about this estimate
              </summary>
              <ul className="mt-1 space-y-0.5 pb-1 leading-snug">
                {result.warnings.map((w, i) => (
                  <li key={i}>• {w}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="min-w-0">{panel}</div>
          <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
            Screening estimates for one household on the 2024 calendar. Bills use published <Term k="tou">time-of-use</Term> rates; carbon uses CAISO&apos;s hourly average grid mix.
            Hover the ⓘ markers for every source.
          </p>
        </>
      )}
    </div>
  );
}
