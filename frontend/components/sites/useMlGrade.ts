"use client";
// The site-location model's GriddyGrade for one point (GET /api/sites/grade): a projected 1-100
// data center feasibility score, 100 = the best 5 km cell in California.  OWNER: workstream B.
// Keyed on the location rounded to 0.0001 deg; results are cached per key so moving between
// sites and back doesn't refetch.
import { useEffect, useState } from "react";

import { request } from "@/lib/api";
import type { LngLat, Provenance } from "@/lib/contract";

export interface MlGradeDriver {
  key: string;
  label: string;
  value: number;
  unit: string;
}

export interface MlGrade {
  location: LngLat;
  available: boolean;
  in_coverage: boolean;
  score: number | null;
  percentile: number | null;
  rank: number | null;
  n_cells: number;
  suitability: Record<string, number>;
  composite: number | null;
  nearest_cell_km: number | null;
  cells_used: number;
  county: string | null;
  drivers: MlGradeDriver[];
  model: { artifact_id?: string; mode?: string; scenario?: string; year?: number; model_version?: string; roc_auc?: Record<string, number> };
  method: string;
  note: string | null;
  provenance: Provenance[];
}

const cache = new Map<string, MlGrade>();
const keyOf = (p: LngLat) => `${p.lon.toFixed(4)},${p.lat.toFixed(4)}`;

export function useMlGrade(location: LngLat | null): { grade: MlGrade | null; loading: boolean; error: string | null } {
  const key = location ? keyOf(location) : null;
  const [own, setOwn] = useState<{ key: string; grade: MlGrade | null; error: string | null } | null>(null);

  useEffect(() => {
    if (!key || cache.has(key)) return;
    let stale = false;
    const [lon, lat] = key.split(",");
    request<MlGrade>(`/sites/grade?lon=${lon}&lat=${lat}`).then(
      (g) => {
        cache.set(key, g);
        if (!stale) setOwn({ key, grade: g, error: null });
      },
      (e: unknown) => !stale && setOwn({ key, grade: null, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      stale = true;
    };
  }, [key]);

  if (!key) return { grade: null, loading: false, error: null };
  const cached = cache.get(key);
  if (cached) return { grade: cached, loading: false, error: null };
  return { grade: own?.key === key ? own.grade : null, loading: own?.key !== key, error: own?.key === key ? own.error : null };
}

/** The ML score when the model covers this point, else null (callers fall back to the heuristic). */
export function mlScore(g: MlGrade | null): number | null {
  return g && g.available && g.in_coverage && typeof g.score === "number" && Number.isFinite(g.score) ? g.score : null;
}
