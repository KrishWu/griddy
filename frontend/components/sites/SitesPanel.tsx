"use client";
// Recommended sites for the forecast demand growth (Phase 2).  OWNER: workstream B.
// STUB: shows the API's status until workstream B builds the panel. Takes the same SiteRequest
// the forecast view builds, so both stay on one scenario.
import { useEffect, useState } from "react";

import { Panel } from "@/components/shell/Panel";
import { post } from "@/lib/api";
import type { SiteRecommendation, SiteRequest } from "@/lib/contract";

export function SitesPanel({ request }: { request: SiteRequest }) {
  const [r, setR] = useState<SiteRecommendation | null>(null);
  const key = JSON.stringify(request);
  useEffect(() => {
    post<SiteRecommendation>("/sites/whatif", JSON.parse(key)).then(setR, () => setR(null));
  }, [key]);
  return (
    <Panel title="Where to build" owner="B · Sites">
      <p className="text-sm text-zinc-500">{r?.caveats?.[0] ?? "Loading…"}</p>
    </Panel>
  );
}
