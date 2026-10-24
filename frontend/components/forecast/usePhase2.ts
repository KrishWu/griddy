"use client";
// Shared Phase 2 state: the forecast what-if request and the latest DemandForecast + SiteRecommendation
// fetched for it.  OWNER: workstream A.
// One module-level store read with useSyncExternalStore, so the map's forecast layers, the forecast
// drawer, the Site panel and B's Sites panel always show the same scenario. Requests are debounced,
// a newer request aborts the one in flight (stale responses are dropped), and every subscriber
// shares the same fetch. The first subscriber triggers the initial load.
import { useSyncExternalStore } from "react";

import { request as apiRequest } from "@/lib/api";
import type { DemandForecast, ForecastRequest, SiteRecommendation, SiteRequest } from "@/lib/contract";

export const DEFAULT_SCENARIO = "mid";
export const DEFAULT_YEAR = 2035;
const FORECAST_DEBOUNCE_MS = 250;
const SITES_DEBOUNCE_MS = 400; // the site ranking reruns the forecast plus an optimizer: give sliders a little longer

export type LoadStatus = "idle" | "loading" | "ready" | "error";
type Weights = Record<string, number> | null;

export interface Phase2State {
  /** What the controls show: preset + target year + overrides (unset fields = the preset). Updates instantly. */
  request: ForecastRequest;
  /** Technology mix and ranking weights for the site recommendations (B's panel sets them). */
  mix: Weights;
  weights: Weights;
  /** The SiteRequest of the latest site fetch (debounced): `recommendation` answers this request. */
  siteRequest: SiteRequest;
  /** Latest forecast response; it can lag `request` while `forecastStatus` is "loading". */
  forecast: DemandForecast | null;
  forecastStatus: LoadStatus;
  recommendation: SiteRecommendation | null;
  sitesStatus: LoadStatus;
}

const INITIAL_REQUEST: ForecastRequest = { scenario: DEFAULT_SCENARIO, year: DEFAULT_YEAR };
const INITIAL: Phase2State = {
  request: INITIAL_REQUEST,
  mix: null,
  weights: null,
  siteRequest: { forecast: INITIAL_REQUEST },
  forecast: null,
  forecastStatus: "idle",
  recommendation: null,
  sitesStatus: "idle",
};

let state: Phase2State = INITIAL;
const listeners = new Set<() => void>();
let started = false;

function emit(patch: Partial<Phase2State>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function buildSiteRequest(s: Pick<Phase2State, "request" | "mix" | "weights">): SiteRequest {
  return { forecast: s.request, ...(s.mix ? { mix: s.mix } : {}), ...(s.weights ? { weights: s.weights } : {}) };
}

/** A debounced POST whose newest call wins: scheduling again aborts the previous request. */
function channel<T>(path: string, delayMs: number, hooks: { body: () => unknown; done: (v: T) => void; fail: (e: unknown) => void }) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ctl: AbortController | null = null;
  const run = () => {
    timer = undefined;
    ctl?.abort();
    const c = new AbortController();
    ctl = c;
    apiRequest<T>(path, { method: "POST", body: JSON.stringify(hooks.body()), signal: c.signal }).then(
      (v) => {
        if (ctl !== c) return; // superseded
        ctl = null;
        hooks.done(v);
      },
      (e: unknown) => {
        if (ctl !== c) return; // aborted by a newer request
        ctl = null;
        hooks.fail(e);
      },
    );
  };
  return (immediate = false) => {
    clearTimeout(timer);
    if (immediate) run();
    else timer = setTimeout(run, delayMs);
  };
}

const scheduleForecast = channel<DemandForecast>("/forecast/whatif", FORECAST_DEBOUNCE_MS, {
  body: () => state.request,
  done: (forecast) => emit({ forecast, forecastStatus: "ready" }),
  fail: (e) => {
    console.warn("forecast request failed", e);
    emit({ forecastStatus: "error" }); // keep the last good forecast on screen
  },
});

const scheduleSites = channel<SiteRecommendation>("/sites/whatif", SITES_DEBOUNCE_MS, {
  body: () => {
    const siteRequest = buildSiteRequest(state);
    emit({ siteRequest });
    return siteRequest;
  },
  done: (recommendation) => emit({ recommendation, sitesStatus: "ready" }),
  fail: (e) => {
    console.warn("site recommendation request failed", e);
    emit({ recommendation: null, sitesStatus: "error" });
  },
});

function refetch(what: { forecast?: boolean; sites?: boolean }, immediate: boolean): void {
  if (what.forecast) {
    emit({ forecastStatus: "loading" });
    scheduleForecast(immediate);
  }
  if (what.sites) {
    emit({ sitesStatus: "loading" });
    scheduleSites(immediate);
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!started) {
    started = true;
    refetch({ forecast: true, sites: true }, true);
  }
  return () => {
    listeners.delete(listener);
  };
}

/** Read a slice of the shared Phase 2 state. The selector must return existing references (no new objects). */
export function usePhase2<T>(selector: (s: Phase2State) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(INITIAL),
  );
}

export function getPhase2State(): Phase2State {
  return state;
}

/** Replace the forecast request (debounced fetch unless `immediate`, e.g. for a button press). */
export function setForecastRequest(next: ForecastRequest | ((r: ForecastRequest) => ForecastRequest), opts: { immediate?: boolean } = {}): void {
  const request = typeof next === "function" ? next(state.request) : next;
  if (JSON.stringify(request) === JSON.stringify(state.request)) return;
  emit({ request });
  refetch({ forecast: true, sites: true }, !!opts.immediate);
}

/** Override some assumptions of the current preset (or move the target year). */
export function updateForecast(patch: Partial<ForecastRequest>, opts: { immediate?: boolean } = {}): void {
  setForecastRequest((r) => ({ ...r, ...patch }), opts);
}

/** Pick a preset: its assumptions replace every override; the target year stays. */
export function selectScenario(scenario: string): void {
  setForecastRequest((r) => ({ scenario, year: r.year ?? DEFAULT_YEAR }), { immediate: true });
}

/** Drop every override of the current preset. */
export function resetToPreset(): void {
  setForecastRequest((r) => ({ scenario: r.scenario ?? DEFAULT_SCENARIO, year: r.year ?? DEFAULT_YEAR }), { immediate: true });
}

/** Technology mix for the site recommendations (share of the new firm peak per AssetKind); null = B's default. */
export function setSiteMix(mix: Weights): void {
  if (JSON.stringify(mix) === JSON.stringify(state.mix)) return;
  emit({ mix });
  refetch({ sites: true }, false);
}

export function setSiteWeights(weights: Weights): void {
  if (JSON.stringify(weights) === JSON.stringify(state.weights)) return;
  emit({ weights });
  refetch({ sites: true }, false);
}

/** Apply a whole SiteRequest (B's panel's onRequestChange): forecast inputs, mix and weights. */
export function setSiteRequest(r: SiteRequest): void {
  const request = r.forecast ?? state.request;
  const forecastChanged = JSON.stringify(request) !== JSON.stringify(state.request);
  const mix = r.mix ?? null;
  const weights = r.weights ?? null;
  const sitesChanged = forecastChanged || JSON.stringify([mix, weights]) !== JSON.stringify([state.mix, state.weights]);
  if (!sitesChanged) return;
  emit({ request, mix, weights });
  refetch({ forecast: forecastChanged, sites: true }, false);
}

/** Try again after a failure (e.g. the backend restarted). */
export function retryPhase2(): void {
  refetch({ forecast: true, sites: true }, true);
}

// --- effective assumptions (what the backend will use), for the controls ---

export interface EffectiveParams {
  population_growth: number;
  use_dof_population: boolean;
  electrification_growth: number;
  efficiency_offset: number;
  data_center_mw: Record<string, number>;
  data_center_load_factor: number;
  data_center_flexible_share: number;
}

/** Backend defaults for a preset field that is missing (backend/app/forecast/service.py effective_params). */
const PARAM_DEFAULTS: EffectiveParams = {
  population_growth: 0,
  use_dof_population: true,
  electrification_growth: 0,
  efficiency_offset: 0,
  data_center_mw: {},
  data_center_load_factor: 0.9,
  data_center_flexible_share: 0,
};

const OVERRIDE_KEYS = Object.keys(PARAM_DEFAULTS) as (keyof EffectiveParams)[];

export function presetOf(forecast: DemandForecast | null, scenario: string | undefined): Record<string, unknown> | null {
  const p = forecast?.scenarios?.[scenario ?? DEFAULT_SCENARIO];
  return p && typeof p === "object" ? p : null;
}

const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function mwMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) {
      const n = asNum(x);
      if (n !== null && n > 0) out[k] = n;
    }
  }
  return out;
}

/** Request override, else the preset's value, else the backend default: what the sliders show right away,
 *  before the response for the request arrives. */
export function effectiveParams(req: ForecastRequest, forecast: DemandForecast | null): EffectiveParams {
  const preset = presetOf(forecast, req.scenario) ?? {};
  const pick = <K extends keyof EffectiveParams>(k: K): unknown => req[k] ?? preset[k] ?? PARAM_DEFAULTS[k];
  return {
    population_growth: asNum(pick("population_growth")) ?? PARAM_DEFAULTS.population_growth,
    use_dof_population: typeof pick("use_dof_population") === "boolean" ? (pick("use_dof_population") as boolean) : true,
    electrification_growth: asNum(pick("electrification_growth")) ?? PARAM_DEFAULTS.electrification_growth,
    efficiency_offset: asNum(pick("efficiency_offset")) ?? PARAM_DEFAULTS.efficiency_offset,
    data_center_mw: mwMap(pick("data_center_mw")),
    data_center_load_factor: asNum(pick("data_center_load_factor")) ?? PARAM_DEFAULTS.data_center_load_factor,
    data_center_flexible_share: asNum(pick("data_center_flexible_share")) ?? PARAM_DEFAULTS.data_center_flexible_share,
  };
}

function stableKey(p: EffectiveParams): string {
  const dc = Object.entries(p.data_center_mw).sort(([a], [b]) => a.localeCompare(b));
  // Population growth only matters with the flat rate.
  return JSON.stringify([OVERRIDE_KEYS.map((k) => (k === "data_center_mw" ? dc : k === "population_growth" && p.use_dof_population ? null : p[k]))]);
}

/** True when a forecast response was computed with assumptions other than its preset's. */
export function forecastAdjusted(f: DemandForecast | null): boolean {
  if (!f?.params) return false;
  return isAdjusted({ ...(f.params as Partial<ForecastRequest>), scenario: f.scenario, year: f.year }, f);
}

/** True when the request's effective assumptions differ from its preset's. */
export function isAdjusted(req: ForecastRequest, forecast: DemandForecast | null): boolean {
  if (!OVERRIDE_KEYS.some((k) => req[k] !== undefined && req[k] !== null)) return false;
  return stableKey(effectiveParams(req, forecast)) !== stableKey(effectiveParams({ scenario: req.scenario }, forecast));
}
