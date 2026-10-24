"use client";
// Selected-site summary.  OWNER: workstream A (Explore / GIS).
import { FindingsList } from "@/components/shell/FindingsList";
import { Panel } from "@/components/shell/Panel";
import { useGridForge } from "@/lib/store";

export function SitePanel() {
  const { scenario, siteSummary } = useGridForge();
  if (!scenario) return null;
  const { lon, lat } = scenario.site.location;
  return (
    <Panel title="Site" owner="A · Explore">
      <p className="mb-2 text-sm">
        {scenario.site.name} · {lat.toFixed(3)}, {lon.toFixed(3)}
      </p>
      {siteSummary ? (
        <>
          <ul className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
            {siteSummary.nearest_substations.map((s) => (
              <li key={s.id}>
                {s.name}: {s.distance_km.toFixed(1)} km
              </li>
            ))}
          </ul>
          <FindingsList findings={siteSummary.findings} />
        </>
      ) : (
        <p className="text-sm text-zinc-500">Click the map to select a site.</p>
      )}
    </Panel>
  );
}
