"use client";
// The GriddyGrade: power plant site feasibility for a proposed generation project (technology +
// nameplate MW) at the selected site, as a percentile among plausible California sites for the
// same technology and size class, with the 0-100 score beside it and the details one click away.
// OWNER: workstream E (Site Intelligence).
// AppShell mounts it first (above A's Site card) and passes <SiteIntelPanel showGrade={false} />;
// without that, SiteIntelPanel mounts it at the top of E's cards. The project is separate from
// the data center scenario: the site is wherever the map selection is, and grading never moves it.
import { useEffect, useId, useRef, useState } from "react";

import { CRITICAL_HEADLINE, fmtMw } from "./feasibility";
import { GriddyGradeDetails, Meter } from "./GriddyGradeDetails";
import { ProjectControls } from "./ProjectControls";
import { dismissRegionNotice, useRefusedPlacement } from "./regionGuard";
import { useGriddyGrade } from "./useGriddyGrade";

/** A click outside Griddy's region left the site where it was: say why. */
function RegionNotice({ at }: { at: { lon: number; lat: number } }) {
  return (
    <p role="status" className="mb-3 flex items-start gap-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
      <span className="min-w-0 flex-1">
        Griddy covers California only for now. {at.lat.toFixed(3)}, {at.lon.toFixed(3)} is outside the state or offshore, so the selected site stayed where it was.
      </span>
      <button type="button" onClick={dismissRegionNotice} aria-label="Dismiss" className="shrink-0 rounded px-1 font-semibold hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-sky-500 dark:hover:bg-amber-900">
        ×
      </button>
    </p>
  );
}

export function GriddyGradeCard() {
  const g = useGriddyGrade();
  const refused = useRefusedPlacement();
  const detailsId = useId();
  const ref = useRef<HTMLElement>(null);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const key = g.location ? `${g.location.lon.toFixed(4)},${g.location.lat.toFixed(4)}` : null;
  const lastKey = useRef(key);

  // A newly selected site, or a refused one: bring the card into view (the site cards may be scrolled down).
  useEffect(() => {
    if (key && lastKey.current !== null && key !== lastKey.current) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    lastKey.current = key;
  }, [key]);
  useEffect(() => {
    if (refused) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [refused]);

  if (!key) return null;
  const r = g.result;
  const p = g.percentile;
  const open = openFor === key; // every newly selected site starts collapsed: just the number
  const critical = r?.constraints.assessment === "identified";
  const alerts = r ? r.notices.filter((n) => n.tone !== "info").length : 0;

  return (
    <section ref={ref} aria-label="GriddyGrade: power plant site feasibility" className="rounded-lg border-2 border-sky-600/50 bg-white p-4 shadow-sm dark:border-sky-400/40 dark:bg-zinc-950">
      {refused && <RegionNotice at={refused} />}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-700 dark:text-zinc-300">
          GriddyGrade
          {r?.provisional && <span className="ml-2 text-[10px] font-normal normal-case tracking-normal text-zinc-400">updating…</span>}
        </h2>
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">Power Plant Site Feasibility</span>
      </div>

      <div className="mt-2">
        <ProjectControls draft={g.draft} errors={g.projectErrors} />
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0 flex-1">
          {r && p ? (
            <>
              <p className="text-7xl font-bold leading-none tracking-tight tabular-nums">
                {p.display.toFixed(1)}
                <span className="sr-only"> percentile among plausible California {r.technologyLabel} sites</span>
              </p>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                percentile for {r.technologyNoun} at {fmtMw(r.project.capacityMw)} · score{" "}
                <span className="font-semibold tabular-nums text-zinc-700 dark:text-zinc-300">{r.overallScore}</span>/100
                {r.completenessLabel === "Low" && <span className="text-amber-700 dark:text-amber-400"> · limited evidence</span>}
              </p>
            </>
          ) : r ? (
            <>
              <p className="text-7xl font-bold leading-none tracking-tight tabular-nums">
                {r.overallScore}
                <span className="sr-only"> out of 100</span>
              </p>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                score out of 100 for {r.technologyNoun} at {fmtMw(r.project.capacityMw)} (no percentile table for this technology and size)
              </p>
            </>
          ) : g.projectErrors.length ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-300">Fix the project settings above to grade this site; no score is shown for an invalid project.</p>
          ) : g.loading ? (
            <div aria-busy="true" aria-label="Grading this site" className="h-[72px] w-28 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          ) : g.error ? (
            <p className="text-sm text-red-600">Could not grade this site: the site summary failed to load ({g.error}).</p>
          ) : (
            <p className="text-sm text-zinc-500">Select a site on the map to grade it for a power plant.</p>
          )}
        </div>
        {r && (
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

      {r && (
        <>
          <div className="mt-2">
            <Meter value={r.overallScoreRaw} label={`Power plant site feasibility score, ${r.overallScore} out of 100`} bands />
          </div>
          <p className={`mt-2 text-xs font-medium ${critical ? "rounded border border-red-300 bg-red-50 px-2 py-1 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200" : "text-zinc-800 dark:text-zinc-200"}`}>
            {critical ? CRITICAL_HEADLINE : r.headline}
          </p>
          <ul className="mt-1 space-y-0.5 text-[11px]">
            {r.notices
              .filter((n) => n.tone !== "constraint")
              .map((n) => (
                <li key={n.text} className={n.tone === "warning" ? "text-amber-800 dark:text-amber-300" : "text-zinc-500 dark:text-zinc-400"}>
                  {n.text}
                </li>
              ))}
          </ul>
        </>
      )}

      <div id={detailsId}>
        {r && open && (
          <div className="mt-4 border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <GriddyGradeDetails grade={g} result={r} />
          </div>
        )}
      </div>
    </section>
  );
}
