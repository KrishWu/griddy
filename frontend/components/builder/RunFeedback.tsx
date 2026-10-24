"use client";
import { useEffect, useState } from "react";
import { useGridForge } from "@/lib/store";

export function RunFeedback() {
  const { running, runProgress } = useGridForge();
  const [now, setNow] = useState(() => Date.now());
  const [fadingRun, setFadingRun] = useState<number | null>(null);
  const [dismissedRun, setDismissedRun] = useState<number | null>(null);
  const runId = runProgress?.startedAt ?? null;
  const completed = !running && runProgress?.percent === 100;

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (!completed || runId === null) return;
    // Give people a moment to see completion, then fade and remove this run's indicator.
    const fade = setTimeout(() => setFadingRun(runId), 1200);
    const dismiss = setTimeout(() => setDismissedRun(runId), 1500);
    return () => { clearTimeout(fade); clearTimeout(dismiss); };
  }, [completed, runId]);

  if (!runProgress || (completed && dismissedRun === runId)) return null;
  const elapsed = Math.max(0, Math.floor((now - runProgress.startedAt) / 1000));
  const percent = runProgress.percent;
  const fading = completed && fadingRun === runId;
  return <section aria-label="Simulation progress" className={"w-48 max-w-full shrink-0 text-[10px] transition-opacity duration-300 motion-reduce:transition-none " + (fading ? "opacity-0" : "opacity-100")}>
    <div className="flex items-center justify-between gap-2">
      <p role="status" aria-live="polite" className="min-w-0 truncate font-medium" title={runProgress.message}>{runProgress.message}</p>
      <span className="shrink-0 tabular-nums">{percent !== null ? percent + "%" : "In progress"}{running && " · " + elapsed + "s"}</span>
    </div>
    <progress aria-label="Completed simulation workflow stages" title="Progress follows completed workflow stages." max={100} value={percent ?? undefined} className="mt-1 block h-1.5 w-full accent-emerald-700 dark:accent-cyan-300" />
  </section>;
}
