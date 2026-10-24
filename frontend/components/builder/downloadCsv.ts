// Download the backend's CSV report for a result.  OWNER: workstream D.
import { api } from "@/lib/api";
import type { ScenarioResult } from "@/lib/contract";

export async function downloadCsv(result: ScenarioResult) {
  const csv = await api.reportCsv(result);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `gridforge-${result.scenario.id}.csv` });
  a.click();
  URL.revokeObjectURL(url);
}
