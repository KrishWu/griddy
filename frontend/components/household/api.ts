// Griddy Home endpoints (backend/app/household/router.py), through the shared /api client.
// OWNER: household (frontend).
import { post, request } from "@/lib/api";

import type { HouseholdOptions, HouseholdRequest, HouseholdResult, SolarOptimizeRequest, SolarOptimizeResult, UsageParseResult } from "./types";

export const householdApi = {
  options: () => request<HouseholdOptions>("/household/options"),
  parseUsage: (csv_text: string) => post<UsageParseResult>("/household/usage/parse", { csv_text }),
  /** Abortable: the what-if controls fire a new plan on every change and cancel the stale one. */
  plan: (req: HouseholdRequest, signal?: AbortSignal) =>
    request<HouseholdResult>("/household/plan", { method: "POST", body: JSON.stringify(req), signal }),
  /** Best solar (+ battery) size for this home by 25-year NPV, within roof room and budget. */
  optimizeSolar: (req: SolarOptimizeRequest, signal?: AbortSignal) =>
    request<SolarOptimizeResult>("/household/solar/optimize", { method: "POST", body: JSON.stringify(req), signal }),
};

/** The backend's error text, trimmed to its `detail` when FastAPI sent one. */
export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /-> (\d+): ([\s\S]*)$/.exec(msg);
  if (!m) return msg;
  try {
    const body = JSON.parse(m[2]) as { detail?: unknown };
    if (typeof body.detail === "string") return `${m[1]}: ${body.detail}`;
    if (Array.isArray(body.detail)) {
      const first = body.detail[0] as { loc?: unknown[]; msg?: string } | undefined;
      if (first?.msg) return `${m[1]}: ${first.loc?.slice(1).join(".") ?? ""} ${first.msg}`.trim();
    }
  } catch {
    /* not JSON */
  }
  return `${m[1]}: ${m[2].slice(0, 200)}`;
}
