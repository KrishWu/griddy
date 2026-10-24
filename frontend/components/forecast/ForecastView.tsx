"use client";
// Demand forecast + what-if view (Phase 2).  OWNER: workstream A.
// STUB: shows the API's status until workstream A builds the view. MapView mounts it in its
// "Forecast & sites" drawer; D may also mount it as a full view.
import { useEffect, useState } from "react";

import { Panel } from "@/components/shell/Panel";
import { request } from "@/lib/api";
import type { DemandForecast } from "@/lib/contract";

export function ForecastView() {
  const [f, setF] = useState<DemandForecast | null>(null);
  useEffect(() => {
    request<DemandForecast>("/forecast?scenario=mid&year=2035").then(setF, () => setF(null));
  }, []);
  return (
    <Panel title="Demand forecast" owner="A · Forecast">
      <p className="text-sm text-zinc-500">{f?.notes?.[0] ?? "Loading…"}</p>
    </Panel>
  );
}
