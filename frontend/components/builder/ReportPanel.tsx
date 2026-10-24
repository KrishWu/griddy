"use client";
// Report export.  OWNER: workstream D (Build + Report + UI).
import { api } from "@/lib/api";
import { useGridForge } from "@/lib/store";
import { Panel } from "@/components/shell/Panel";

export function ReportPanel() {
  const { result } = useGridForge();
  if (!result) return null;
  const download = async () => {
    const csv = await api.reportCsv(result);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `gridforge-${result.scenario.id}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Panel title="Report" owner="D · Report">
      <button className="rounded border border-zinc-300 px-3 py-1 text-sm dark:border-zinc-700" onClick={download}>
        Download CSV
      </button>
    </Panel>
  );
}
