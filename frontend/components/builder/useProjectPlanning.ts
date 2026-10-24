"use client";

import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { request } from "@/lib/api";
import type { Scenario } from "@/lib/contract";

export interface PlanningInputs {
  plant_type: "hybrid" | "solar_storage" | "wind_storage" | "gas_cc" | "gas_ct";
  renewable_energy_share: number;
  storage_hours: number;
  reserve_margin: number;
}

export interface ProjectPlan {
  scenario: Scenario;
  projection: { years: number; peak_mw: number; unmet_hours: number; capex_usd: number; annual_t_co2e: number; lcoe_usd_per_mwh: number };
  screening: { meets_entered_checks: boolean; issues: string[]; basis: string };
}

const DEFAULTS: PlanningInputs = { plant_type: "hybrid", renewable_energy_share: 0.7, storage_hours: 4, reserve_margin: 0.15 };
export const PLAN_DEBOUNCE_MS = 400;

function inputsFor(scenario: Scenario | null): PlanningInputs {
  const saved = scenario?.options?.planner as Partial<PlanningInputs> | undefined;
  const number = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  return {
    plant_type: saved?.plant_type && ["hybrid", "solar_storage", "wind_storage", "gas_cc", "gas_ct"].includes(saved.plant_type) ? saved.plant_type : DEFAULTS.plant_type,
    renewable_energy_share: number(saved?.renewable_energy_share, DEFAULTS.renewable_energy_share, 0, 1),
    storage_hours: number(saved?.storage_hours, DEFAULTS.storage_hours, 0.5, 48),
    reserve_margin: number(saved?.reserve_margin, DEFAULTS.reserve_margin, 0, 1),
  };
}

/** Generated assets and sizing notes are outputs, so applying them must not start another search. */
export function planningRequestKey(scenario: Scenario | null): string | null {
  if (!scenario) return null;
  const options = Object.fromEntries(Object.entries(scenario.options ?? {}).filter(([key]) => key !== "sizing" && key !== "planner"));
  return JSON.stringify({
    scenario: { ...scenario, name: "Automatically planned project", assets: [], options },
    ...inputsFor(scenario),
    project: options.project ?? {},
  });
}

export function useProjectPlanning(scenario: Scenario | null, setScenario: Dispatch<SetStateAction<Scenario | null>>) {
  const key = planningRequestKey(scenario);
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState<{ key: string; attempt: number; plan?: ProjectPlan; error?: string } | null>(null);
  const current = response?.key === key && response.attempt === attempt ? response : null;

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      request<ProjectPlan>("/projects/plan", { method: "POST", body: key, signal: controller.signal }).then(
        (plan) => {
          if (cancelled) return;
          setScenario((latest) => {
            if (!latest || planningRequestKey(latest) !== key) return latest;
            // Preserve edits made elsewhere, including labels, presets and manual asset changes
            // while idle. Only replace the sized fleet and its generated sizing annotation.
            return { ...latest, assets: plan.scenario.assets, options: { ...latest.options, sizing: plan.scenario.options?.sizing } };
          });
          setResponse({ key, attempt, plan });
        },
        (error: unknown) => {
          if (!cancelled) setResponse({ key, attempt, error: error instanceof Error ? error.message : String(error) });
        },
      );
    }, PLAN_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, attempt, setScenario]);

  const updateInputs = useCallback((patch: Partial<PlanningInputs>) => {
    setScenario((latest) => latest ? { ...latest, options: { ...latest.options, planner: { ...inputsFor(latest), ...patch } } } : latest);
  }, [setScenario]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { inputs: inputsFor(scenario), updateInputs, plan: current?.plan, error: current?.error ?? null, busy: key !== null && current === null, retry };
}

export type ProjectPlanningState = ReturnType<typeof useProjectPlanning>;
