"use client";
import { useEffect, useState } from "react";
import { useGridForge } from "@/lib/store";

export function RunFeedback() {
  const { running, runProgress } = useGridForge();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (!runProgress) return null;
  const elapsed = Math.max(0, Math.floor((now - runProgress.startedAt) / 1000));
  const percent = runProgress.percent;
  return <section data-chrome aria-label="Simulation progress" className="shrink-0 border-b border-zinc-200 bg-white px-4 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-950">
    <div className="flex items-center justify-between gap-3">
      <p role="status" aria-live="polite" className="font-medium">{runProgress.message}</p>
      <span className="shrink-0 tabular-nums">{percent !== null ? `${percent}%` : "In progress"}{running && ` · ${elapsed}s`}</span>
    </div>
    <progress aria-label="Completed simulation workflow stages" max={100} value={percent ?? undefined} className="mt-1.5 block h-1.5 w-full accent-emerald-700 dark:accent-cyan-300" />
    {running && <p className="mt-1 text-[10px] text-zinc-500">{elapsed >= 10 ? "Still running while the current step finishes." : "Progress follows completed workflow stages."}</p>}
  </section>;
}
