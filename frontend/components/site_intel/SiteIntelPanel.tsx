"use client";
// Satellite + environmental screening.  OWNER: workstream E (Site Intelligence).
import { FindingsList } from "@/components/shell/FindingsList";
import { Panel } from "@/components/shell/Panel";
import { useGridForge } from "@/lib/store";

export function SiteIntelPanel() {
  const { siteIntel } = useGridForge();
  return (
    <Panel title="Site intelligence" owner="E · Site intel">
      {siteIntel ? <FindingsList findings={siteIntel.findings} /> : <p className="text-sm text-zinc-500">Select a site on the map.</p>}
    </Panel>
  );
}
