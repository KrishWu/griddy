"use client";
// Report export: printable report page + CSV.  OWNER: workstream D (Build + Report + UI).
import Link from "next/link";

import { Panel } from "@/components/shell/Panel";
import { useGridForge } from "@/lib/store";

import { downloadCsv } from "./downloadCsv";

export function ReportPanel() {
  const { result } = useGridForge();
  if (!result) return null;
  return (
    <Panel title="Report" owner="D · Report">
      <div className="flex flex-wrap gap-2">
        <Link href="/report" className="rounded bg-zinc-900 px-3 py-1 text-sm text-white dark:bg-zinc-100 dark:text-black">
          Open full report
        </Link>
        <button className="rounded border border-zinc-300 px-3 py-1 text-sm dark:border-zinc-700" onClick={() => void downloadCsv(result)}>
          Download CSV
        </button>
      </div>
      <p className="mt-2 text-[11px] text-zinc-500">Every number with its source, ready to print or save as PDF.</p>
    </Panel>
  );
}
