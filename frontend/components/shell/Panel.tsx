// Card wrapper every module panel uses, so the dashboard looks consistent. SHARED (foundation).
import type { ReactNode } from "react";

export function Panel({ title, owner, children }: { title: string; owner?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-700 dark:text-zinc-300">{title}</h2>
        {owner && <span className="text-[10px] text-zinc-400">{owner}</span>}
      </header>
      {children}
    </section>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-zinc-500">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
