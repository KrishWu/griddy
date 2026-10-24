// Site summary for the current scenario site, shared by MapView and SitePanel.  OWNER: workstream A.
// The store only fetches a summary when a site is clicked (selectSite), so for the preset
// site (and after a failed click fetch) we fetch it here. One request per location: the
// promise cache dedupes the two consumers, and map clicks in flight are tracked so we
// don't race the store's own request.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { api } from "@/lib/api";
import type { LngLat, SiteSummary } from "@/lib/contract";
import { useGridForge } from "@/lib/store";

import { lngLat, locKey, num, rec, sameLoc, str } from "./geo";
import { asFuel, type Fuel } from "./palette";

const MAX_CACHED = 50;
const cache = new Map<string, Promise<SiteSummary>>();
// Settled successes, so a remounted panel (AppShell re-keys it on every run) renders without a loading flash.
const resolved = new Map<string, SiteSummary>();

function fetchSummary(p: LngLat): Promise<SiteSummary> {
  const key = locKey(p);
  let pr = cache.get(key);
  if (!pr) {
    pr = api.siteSummary(p);
    cache.set(key, pr);
    pr.then(
      (s) => {
        resolved.set(key, s);
        if (resolved.size > MAX_CACHED) resolved.delete(resolved.keys().next().value as string);
      },
      () => cache.delete(key), // let a later attempt retry
    );
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
  }
  return pr;
}

// --- map clicks in flight (selectSite fetches the summary itself) ---
let pendingKey: string | null = null;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const setPending = (key: string | null) => {
  pendingKey = key;
  listeners.forEach((fn) => fn());
};

/** Call around selectSite() so panels show a loading state instead of fetching twice. */
export function trackSiteSelection(p: LngLat, selection: Promise<void>): void {
  const key = locKey(p);
  setPending(key);
  selection
    .catch(() => undefined)
    .finally(() => {
      if (pendingKey === key) setPending(null);
    });
}

export interface SiteSummaryState {
  summary: SiteSummary | null;
  loading: boolean;
  error: string | null;
}

export function useSiteSummary(): SiteSummaryState {
  const { scenario, siteSummary } = useGridForge();
  const lon = scenario?.site.location.lon;
  const lat = scenario?.site.location.lat;
  const loc = useMemo(() => (lon !== undefined && lat !== undefined ? { lon, lat } : null), [lon, lat]);
  const key = loc ? locKey(loc) : null;
  const pending = useSyncExternalStore(subscribe, () => pendingKey, () => null);
  // The store keeps a clicked site's summary after a preset switch moves the site: only use it if it matches.
  const fromStore = siteSummary && (!loc || !siteSummary.site?.location || sameLoc(siteSummary.site.location, loc)) ? siteSummary : null;
  const needLocal = !fromStore && loc !== null && pending !== key;
  const [local, setLocal] = useState<{ key: string; summary: SiteSummary | null; error: string | null } | null>(() => {
    const hit = key ? resolved.get(key) : undefined;
    return key && hit ? { key, summary: hit, error: null } : null;
  });

  useEffect(() => {
    if (!needLocal || !loc) return;
    let stale = false;
    fetchSummary(loc).then(
      (summary) => !stale && setLocal({ key: locKey(loc), summary, error: null }),
      (e: unknown) => !stale && setLocal({ key: locKey(loc), summary: null, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      stale = true; // the location changed: ignore this response
    };
  }, [needLocal, loc]);

  if (fromStore) return { summary: fromStore, loading: false, error: null };
  if (!key) return { summary: null, loading: false, error: null };
  if (pending === key || local?.key !== key) return { summary: null, loading: true, error: null };
  return { summary: local.summary, loading: false, error: local.error };
}

// --- normalized view of SiteSummary (typed fields + optional extras) ---

export interface SubstationRef {
  id: string;
  name: string;
  voltage_kv: number | null;
  distance_km: number | null;
  location: LngLat | null;
  operator: string | null;
  osm_url: string | null;
}

export interface LineRef {
  id: string;
  name: string;
  owner: string | null;
  voltage_kv: number | null;
  distance_km: number | null;
  point: LngLat | null;
}

export interface PlantRef {
  id: string;
  name: string;
  fuel: Fuel;
  capacity_mw: number | null;
  distance_km: number | null;
}

export interface SiteView {
  county: string | null;
  utility: string | null;
  utilityTitle: string | null;
  balancingAuthority: string | null;
  balancingAuthorityTitle: string | null;
  inCalifornia: boolean | null;
  substations: SubstationRef[];
  hvSubstation: SubstationRef | null;
  hvLine: LineRef | null;
  anyLine: LineRef | null;
  plants: PlantRef[];
  plantsCount: number;
  plantsTotalMw: number;
  plantsByFuel: [Fuel, number][];
  population: number | null;
  distanceMethod: string | null;
}

function substation(v: unknown, i: number): SubstationRef | null {
  const r = rec(v);
  if (!r) return null;
  return {
    id: str(r.id) ?? `sub-${i}`,
    name: str(r.name) ?? "Unnamed substation",
    voltage_kv: num(r.voltage_kv),
    distance_km: num(r.distance_km),
    location: lngLat(r.location),
    operator: str(r.operator),
    osm_url: str(r.osm_url),
  };
}

function line(v: unknown): LineRef | null {
  const r = rec(v);
  if (!r) return null;
  return {
    id: str(r.id) ?? "line",
    name: str(r.name) ?? "Transmission line",
    owner: str(r.owner),
    voltage_kv: num(r.voltage_kv),
    distance_km: num(r.distance_km),
    point: lngLat(r.point),
  };
}

export function readSummary(s: SiteSummary): SiteView {
  const x = rec(s.extras) ?? {};
  const utility = rec(x.utility);
  const ba = rec(x.balancing_authority);
  const substations = (Array.isArray(s.nearest_substations) ? s.nearest_substations : [])
    .map(substation)
    .filter((v): v is SubstationRef => v !== null);
  const plants = (Array.isArray(s.nearby_plants) ? s.nearby_plants : [])
    .map((p, i): PlantRef | null => {
      const r = rec(p);
      return r
        ? { id: str(r.id) ?? `plant-${i}`, name: str(r.name) ?? "Unnamed plant", fuel: asFuel(r.fuel), capacity_mw: num(r.capacity_mw), distance_km: num(r.distance_km) }
        : null;
    })
    .filter((v): v is PlantRef => v !== null);

  let hvLine = line(x.nearest_line);
  const lineKv = num(s.nearest_line_kv);
  const lineKm = num(s.nearest_line_km);
  if (!hvLine && (lineKv !== null || lineKm !== null)) {
    hvLine = { id: "nearest-line", name: "Transmission line", owner: null, voltage_kv: lineKv, distance_km: lineKm, point: null };
  }

  // Prefer the backend's 25 km aggregate (nearby_plants is capped); fall back to the list.
  const agg = rec(x.plants_within_25km);
  const byFuelRaw = rec(agg?.by_fuel_mw);
  const byFuel = new Map<Fuel, number>();
  if (byFuelRaw) {
    for (const [f, mw] of Object.entries(byFuelRaw)) {
      const v = num(mw);
      if (v !== null) byFuel.set(asFuel(f), (byFuel.get(asFuel(f)) ?? 0) + v);
    }
  } else {
    for (const p of plants) byFuel.set(p.fuel, (byFuel.get(p.fuel) ?? 0) + (p.capacity_mw ?? 0));
  }
  const listTotal = plants.reduce((a, p) => a + (p.capacity_mw ?? 0), 0);

  const utilityName = str(utility?.name);
  const baName = str(ba?.name);
  return {
    county: str(s.site?.county),
    // An explicit null in extras means "looked it up, none here" (e.g. outside CA): don't fall back to scenario defaults.
    utility: "utility" in x ? (str(utility?.acronym) ?? str(utility?.short_name) ?? utilityName) : str(s.site?.utility_territory),
    utilityTitle: utilityName ? `${utilityName}${str(utility?.utility_type) ? ` (${str(utility?.utility_type)})` : ""}` : null,
    balancingAuthority: "balancing_authority" in x ? str(ba?.short_name) : str(s.site?.balancing_authority),
    balancingAuthorityTitle: baName,
    inCalifornia: typeof x.in_california === "boolean" ? x.in_california : null,
    substations,
    hvSubstation: substation(x.nearest_hv_substation, 99),
    hvLine,
    anyLine: line(x.nearest_any_line),
    plants,
    plantsCount: num(agg?.count) ?? plants.length,
    plantsTotalMw: num(agg?.total_mw) ?? listTotal,
    plantsByFuel: [...byFuel.entries()].filter(([, mw]) => mw > 0).sort((a, b) => b[1] - a[1]),
    population: num(s.population_within_10km),
    distanceMethod: str(x.distance_method),
  };
}
