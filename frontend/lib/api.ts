// Typed client for the FastAPI backend. Every call goes through /api (proxied by
// next.config.ts), so components never hard-code a host. SHARED (foundation).
// Adding an endpoint to your own router? Call it from your own component with
// request()/post() below instead of editing this file.
import type {
  Catalog,
  EvaluationResult,
  Finding,
  LngLat,
  Scenario,
  ScenarioResult,
  SimulationResult,
  SiteIntel,
  SiteSummary,
} from "./contract";

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} /api${path} -> ${res.status}: ${await res.text()}`);
  const type = res.headers.get("content-type") ?? "";
  return (type.includes("application/json") ? res.json() : res.text()) as Promise<T>;
}

export const post = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  health: () => request<{ ok: boolean; schema_version: string }>("/health"),
  layer: (layer: "plants" | "transmission" | "substations" | "boundaries") =>
    request<GeoJSON.FeatureCollection>(`/layers/${layer}`),
  siteSummary: (p: LngLat) => request<SiteSummary>(`/site/summary?lon=${p.lon}&lat=${p.lat}`),
  siteIntel: (p: LngLat) => request<SiteIntel>(`/site/intel?lon=${p.lon}&lat=${p.lat}`),
  catalog: () => request<Catalog>("/catalog"),
  presets: () => request<Scenario[]>("/presets"),
  simulate: (scenario: Scenario) => post<SimulationResult>("/simulate", scenario),
  evaluate: (scenario: Scenario, simulation: SimulationResult) =>
    post<EvaluationResult>("/evaluate", { scenario, simulation }),
  stress: (scenario: Scenario, simulation: SimulationResult) =>
    post<Finding[]>("/stress", { scenario, simulation }),
  run: (scenario: Scenario) => post<ScenarioResult>("/run", scenario),
  compare: (scenarios: Scenario[]) => post<ScenarioResult[]>("/compare", scenarios),
  reportCsv: (result: ScenarioResult) => post<string>("/report.csv", result),
};
