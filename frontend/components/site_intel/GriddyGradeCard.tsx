"use client";
// The GriddyGrade: the selected site's 0-100 data center feasibility score, shown as just a number
// above every other card, with the details one click away.  OWNER: workstream E (Site Intelligence).
// AppShell mounts it first (above A's Site card) and passes <SiteIntelPanel showGrade={false} />;
// without that, SiteIntelPanel mounts it at the top of E's cards.
// The number is B's site-location model score (GET /api/sites/grade: 1-100, one decimal, 100 = the
// best cell in California); E's feasibility heuristic stays in the details as the site checks, and
// stands in for the number only where the model has no score (outside its coverage, or unavailable).
import { useEffect, useId, useRef, useState } from "react";

import { fmtGrade, mlScore, useMlGrade } from "@/components/sites/useMlGrade";

import { GriddyGradeDetails } from "./GriddyGradeDetails";
import { useGriddyGrade } from "./useGriddyGrade";

export function GriddyGradeCard() {
  const g = useGriddyGrade();
  const ml = useMlGrade(g.location);
  const modelScore = mlScore(ml.grade);
  const detailsId = useId();
  const ref = useRef<HTMLElement>(null);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const key = g.location ? `${g.location.lon.toFixed(4)},${g.location.lat.toFixed(4)}` : null;
  const lastKey = useRef(key);

  // A newly dropped data center: bring its grade into view (the site cards may be scrolled down).
  useEffect(() => {
    if (key && lastKey.current !== null && key !== lastKey.current) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    lastKey.current = key;
  }, [key]);

  if (!key) return null;
  const r = g.result;
  const open = openFor === key; // every newly dropped site starts collapsed: just the number
  const heuristicOnly = modelScore === null && !ml.loading && r !== null;
  const shown = modelScore ?? (heuristicOnly && r ? r.overallScore : null);
  const alerts = r ? r.seriousConstraints.length + (r.completenessLabel === "Low" ? 1 : 0) : 0;

  return (
    <section ref={ref} aria-label="GriddyGrade" className="rounded-lg border-2 border-sky-600/50 bg-white p-4 shadow-sm dark:border-sky-400/40 dark:bg-zinc-950">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-700 dark:text-zinc-300">
            GriddyGrade
            {r && g.intelPending && <span className="ml-2 text-[10px] font-normal normal-case tracking-normal text-zinc-400">updating…</span>}
          </h2>
          {shown !== null ? (
            <p className="mt-1 text-7xl font-bold leading-none tracking-tight tabular-nums">
              {fmtGrade(shown)}
              <span className="sr-only"> out of 100</span>
              {heuristicOnly && (
                <span className="ml-2 align-middle text-[10px] font-normal tracking-normal text-zinc-500" title={ml.grade?.note ?? ml.error ?? undefined}>
                  site checks
                </span>
              )}
            </p>
          ) : g.loading || ml.loading ? (
            <div aria-busy="true" aria-label="Grading this site" className="mt-1 h-[72px] w-28 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          ) : g.error ? (
            <p className="mt-1 text-sm text-red-600">Could not grade this site: the site summary failed to load ({g.error}).</p>
          ) : (
            <p className="mt-1 text-sm text-zinc-500">Drop a data center on the map to grade the site.</p>
          )}
        </div>
        {(r || modelScore !== null) && (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpenFor(open ? null : key)}
            className="mb-1 inline-flex shrink-0 items-center gap-1 rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:border-zinc-400 focus-visible:outline-2 focus-visible:outline-sky-500 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-500"
          >
            {open ? "Hide details" : "Details"}
            {!open && alerts > 0 && (
              <span className="rounded bg-amber-100 px-1 text-[10px] font-semibold text-amber-900 dark:bg-amber-950 dark:text-amber-300">
                {alerts} alert{alerts === 1 ? "" : "s"}
              </span>
            )}
            <svg viewBox="0 0 16 16" className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden>
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
      <div id={detailsId}>
        {(r || modelScore !== null) && open && (
          <div className="mt-4 border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <GriddyGradeDetails grade={g} result={r} ml={ml} />
          </div>
        )}
      </div>
    </section>
  );
}
