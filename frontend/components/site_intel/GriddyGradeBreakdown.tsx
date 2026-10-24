"use client";
// How the GriddyGrade is built: the six components, key considerations, method and limits.
// OWNER: workstream E (Site Intelligence). The headline number is GriddyGradeCard.
import { ProvenanceTip } from "@/components/evaluate/ProvenanceTip";
import { Panel } from "@/components/shell/Panel";
import type { Provenance } from "@/lib/contract";

import type { ComponentKey, ComponentResult, ComponentStatus, ConsiderationGroup, ConsiderationTone, FeasibilityResult } from "./feasibility";
import { Meter } from "./GriddyGradeCard";
import { useGriddyGrade } from "./useGriddyGrade";

// Which of the summary's and intel's provenance entries feed each component.
const SOURCES: Record<ComponentKey, RegExp> = {
  grid: /substation|transmission|straight-line/i,
  generation: /EIA-860/i,
  community: /population/i,
  air: /Green Book|AirNow/i,
  land: /3DEP|WorldCover|Cropland Data|WDPA|Surface Water|Griddy screening/i,
  infrastructure: /Load Serving|Balancing Authority/i,
};

function sourcesFor(c: ComponentResult, provenance: Provenance[]): Provenance[] {
  const data = provenance.filter((p, i) => SOURCES[c.key].test(p.source) && provenance.findIndex((q) => q.source === p.source) === i);
  const how: Provenance =
    c.status === "unavailable"
      ? { kind: "assumption", source: "Neutral placeholder score (50)", note: "No data for this component, so it scores 50 and does not count toward data completeness." }
      : { kind: "inferred", source: "Griddy feasibility heuristic (initial product weights)", note: c.method };
  return [...data, how];
}

const pct = (share: number) => `${Math.round(share * 100)}%`;

function StatusBadge({ status }: { status: ComponentStatus }) {
  if (status === "observed") return null;
  return (
    <span
      className={`shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide ${
        status === "partial" ? "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300" : "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
      }`}
    >
      {status === "partial" ? "Partial data" : "No data · neutral"}
    </span>
  );
}

function ComponentRow({ c, sources }: { c: ComponentResult; sources: Provenance[] }) {
  return (
    <li className="py-1.5">
      <details className="group">
        <summary className="cursor-pointer list-none rounded focus-visible:outline-2 focus-visible:outline-sky-500 [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-1.5 text-xs">
            <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0 text-zinc-400 transition-transform group-open:rotate-90" aria-hidden>
              <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="min-w-0 flex-1 font-medium">{c.label}</span>
            <StatusBadge status={c.status} />
            <span className="w-7 shrink-0 text-right font-semibold tabular-nums">{Math.round(c.score)}</span>
          </span>
          <span className="mt-1 flex items-center gap-2 pl-[18px] text-[11px] text-zinc-500 dark:text-zinc-400">
            <span className="w-16 shrink-0">{pct(c.weight)} weight</span>
            <Meter value={c.score} status={c.status} />
            <span className="w-16 shrink-0 text-right tabular-nums">+{c.weightedContribution.toFixed(1)} pts</span>
          </span>
        </summary>
        <div className="mt-2 space-y-2 pl-[18px] text-[11px] leading-snug text-zinc-600 dark:text-zinc-400">
          <p className="text-zinc-800 dark:text-zinc-200">{c.explanation}</p>
          <ul className="space-y-1">
            {c.metrics.map((m) => (
              <li key={m.id}>
                <span className="block text-zinc-500">
                  {m.label}
                  {m.state === "observed" && c.metrics.length > 1 && ` · ${pct(m.effectiveWeight)} of this component`}
                </span>
                <span className="flex gap-2">
                  <span className="min-w-0 flex-1 break-words font-medium text-zinc-800 dark:text-zinc-200">{m.value}</span>
                  <span className="shrink-0 tabular-nums">{m.state === "observed" && m.score !== null ? `${Math.round(m.score)}/100` : m.state === "missing" ? "missing" : "n/a"}</span>
                </span>
              </li>
            ))}
            {c.context.map((f) => (
              <li key={`${f.label}:${f.value}`}>
                <span className="block text-zinc-500">{f.label}</span>
                <span className="block break-words text-zinc-800 dark:text-zinc-200">{f.value}</span>
              </li>
            ))}
          </ul>
          {c.missingFields.length > 0 && (
            <p className="text-amber-800 dark:text-amber-300">
              <span className="font-semibold">Missing:</span> {c.missingFields.join("; ")}
            </p>
          )}
          <p>
            <span className="font-semibold">Calculation:</span> {c.method}
          </p>
          <ul className="list-disc space-y-0.5 pl-4">
            {c.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <span className="inline-flex items-center gap-1 text-zinc-500">
            Sources and limits
            <ProvenanceTip label={c.label} provenance={sources}>
              {c.notes.join(" ")}
            </ProvenanceTip>
          </span>
        </div>
      </details>
    </li>
  );
}

const GROUPS: [ConsiderationGroup, string][] = [
  ["infrastructure", "Grid and infrastructure"],
  ["community", "Community and environment"],
  ["data", "Data gaps"],
];

const TONE: Record<ConsiderationTone, { icon: string; label: string; className: string }> = {
  advantage: { icon: "+", label: "Advantage", className: "text-emerald-700 dark:text-emerald-400" },
  neutral: { icon: "•", label: "Context", className: "text-zinc-400" },
  tradeoff: { icon: "−", label: "Tradeoff", className: "text-amber-700 dark:text-amber-400" },
  constraint: { icon: "!", label: "Serious constraint", className: "text-red-700 dark:text-red-400" },
  missing: { icon: "?", label: "Missing data", className: "text-zinc-500" },
  caveat: { icon: "!", label: "Caveat", className: "text-amber-700 dark:text-amber-400" },
};

function KeyConsiderations({ r }: { r: FeasibilityResult }) {
  const caveats = r.considerations.filter((c) => c.tone === "caveat");
  return (
    <section className="mt-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Key considerations</h3>
      {GROUPS.map(([group, title]) => {
        const items = r.considerations.filter((c) => c.group === group && c.tone !== "caveat");
        if (!items.length) return null;
        return (
          <div key={group} className="mt-2">
            <h4 className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">{title}</h4>
            <ul className="mt-1 space-y-1">
              {items.map((c) => (
                <li key={c.text} className="flex gap-1.5 text-xs">
                  <span aria-hidden className={`w-3 shrink-0 text-center font-bold ${TONE[c.tone].className}`}>
                    {TONE[c.tone].icon}
                  </span>
                  <span className="min-w-0 break-words">
                    <span className="sr-only">{TONE[c.tone].label}: </span>
                    {c.text}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {caveats.map((c) => (
        <p
          key={c.text}
          className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          {c.text}
        </p>
      ))}
    </section>
  );
}

export function GriddyGradeBreakdown() {
  const { result: r, provenance } = useGriddyGrade();
  if (!r) return null; // the headline card shows loading and errors
  return (
    <Panel title="GriddyGrade breakdown" owner="E · Site intel">
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        How the GriddyGrade of <span className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{r.overallScore}</span> is built, at{" "}
        <span className="tabular-nums">{Math.round(r.targetLoadMw).toLocaleString()} MW</span> average load. Open a row for its inputs and calculation.
      </p>
      <section className="mt-3">
        <h3 className="flex items-baseline text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Components
          <span className="ml-auto font-normal normal-case tracking-normal">score × weight = points</span>
        </h3>
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {r.components.map((c) => (
            <ComponentRow key={c.key} c={c} sources={sourcesFor(c, provenance)} />
          ))}
        </ul>
        <p className="mt-1 text-right text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
          Total {r.overallScoreRaw.toFixed(1)} points → GriddyGrade {r.overallScore}
        </p>
      </section>

      <KeyConsiderations r={r} />

      <details className="mt-3 text-[11px] text-zinc-500">
        <summary className="cursor-pointer">Method and limitations</summary>
        <p className="mt-1 tabular-nums">GriddyGrade = 0.30 G + 0.20 P + 0.15 C + 0.15 A + 0.10 L + 0.10 I, each component 0–100.</p>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          {r.explanatoryNotes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </details>
    </Panel>
  );
}
