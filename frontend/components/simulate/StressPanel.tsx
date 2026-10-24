"use client";
// Feasibility findings.  OWNER: workstream B (Simulate + Stress Test).
import { FindingsList } from "@/components/shell/FindingsList";
import { Panel } from "@/components/shell/Panel";
import { useGridForge } from "@/lib/store";

export function StressPanel() {
  const { result } = useGridForge();
  if (!result) return null;
  return (
    <Panel title="Stress test" owner="B · Stress">
      <FindingsList findings={result.findings} />
    </Panel>
  );
}
