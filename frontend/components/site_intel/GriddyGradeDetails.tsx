"use client";
// The GriddyGrade's details, shown when its card is expanded: the overall result (score, category,
// data completeness, site, policy version), the critical-constraints assessment, the project's
// advanced settings, the five components with their calculations, key considerations, the land
// exclusion and the method and limits.  OWNER: workstream E (Site Intelligence).
import { ProvenanceTip } from "@/components/evaluate/ProvenanceTip";
import type { Provenance } from "@/lib/contract";

import {
  COMPLETENESS_SCOPE,
  formulaFor,
  fmtMw,
  tierLabel,
  type ComponentResult,
  type ComponentStatus,
  type ConsiderationGroup,
  type ConsiderationTone,
  type ConstraintAssessment,
  type FeasibilityResult,
  type MetricResult,
} from "./feasibility";
import type { ComponentKey } from "./feasibilityPolicy";
import { ProjectControls } from "./ProjectControls";
import type { GriddyGrade } from "./useGriddyGrade";

const FILL: Record<ComponentStatus, string> = {
  observed: "bg-sky-600 dark:bg-sky-400",
  partial: "bg-sky-600/60 dark:bg-sky-400/60",
  unavailable: "bg-zinc-400 dark:bg-zinc-600",
};

/** Score bar on a 0-100 track. `bands` marks the category boundaries (20/40/60/80) as gaps. */
export function Meter({ value, status = "observed", label, bands = false }: { value: number; status?: ComponentStatus; label?: string; bands?: boolean }) {
  const now = Math.round(value); // spoken as displayed
  const a11y = label
    ? { role: "meter", "aria-label": label, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": now, "aria-valuetext": String(now) }
    : { "aria-hidden": true };
  return (
    <span {...a11y} className={`relative block w-full min-w-0 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800 ${bands ? "h-3" : "h-1.5"}`}>
      <span className={`block h-full rounded-full ${FILL[status]}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      {bands &&
        [20, 40, 60, 80].map((b) => <span key={b} className="absolute inset-y-0 w-0.5 bg-white dark:bg-zinc-950" style={{ left: `calc(${b}% - 1px)` }} />)}
    </span>
  );
}

// Which of the summary's and intel's provenance entries feed each component.
const SOURCES: Record<ComponentKey, RegExp> = {
  grid: /substation|transmission|straight-line|Queued Up/i,
  resource: /site-location model|ERA5|reanalysis|EIA-860/i,
  environment: /Green Book|AirNow/i,
  community: /population/i,
  administrative: /Load Serving|Balancing Authority/i,
};

function sourcesFor(c: ComponentResult, provenance: Provenance[]): Provenance[] {
  const data = provenance.filter((p, i) => SOURCES[c.key].test(p.source) && provenance.findIndex((q) => q.source === p.source) === i);
  const how: Provenance =
    c.status === "unavailable"
      ? { kind: "assumption", source: `Neutral placeholder score (${c.score})`, note: "No usable data for this component, so it scores the neutral value and does not count toward data completeness." }
      : { kind: "inferred", source: "Griddy power plant feasibility heuristic (initial product weights)", note: c.method };
  return [...data, how];
}

const pct = (share: number) => `${Math.round(share * 100)}%`;

const STATUS_TEXT: Record<ComponentStatus, string> = { observed: "Observed", partial: "Partially observed", unavailable: "Unavailable · neutral" };

function StatusBadge({ status }: { status: ComponentStatus }) {
  return (
    <span
      className={`shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide ${
        status === "observed"
          ? "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-300"
          : status === "partial"
            ? "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300"
            : "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
      }`}
    >
      {STATUS_TEXT[status]}
    </span>
  );
}

function MetricRow({ m, many }: { m: MetricResult; many: boolean }) {
  const share = m.state === "observed" && m.effectiveWeight > 0 && many ? ` · ${pct(m.effectiveWeight)} of this component` : "";
  const right = m.state === "observed" ? (m.score !== null ? `${Math.round(m.score)}/100` : "") : m.state === "missing" ? "missing" : "n/a";
  return (
    <li>
      <span className="flex flex-wrap items-center gap-x-1.5 text-zinc-500">
        {m.label}
        {share}
        {m.source && (
          <span
            className={`rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide ${
              m.source.kind === "inferred" ? "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-300" : "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            }`}
          >
            {m.source.tag}
          </span>
        )}
      </span>
      <span className="flex gap-2">
        <span className="min-w-0 flex-1 break-words font-medium text-zinc-800 dark:text-zinc-200">{m.value}</span>
        {right && <span className="shrink-0 tabular-nums">{right}</span>}
      </span>
      {m.method && m.state === "observed" && <span className="block text-[10px] text-zinc-500">Method: {m.method}</span>}
      {m.source && <span className="block text-[10px] text-zinc-500">{m.source.detail}</span>}
    </li>
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
            <span className="w-12 shrink-0 text-right font-semibold tabular-nums">
              {Math.round(c.score)}
              <span className="font-normal text-zinc-400">/100</span>
            </span>
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
              <MetricRow key={m.id} m={m} many={c.metrics.length > 1} />
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
              <span className="font-semibold">Missing evidence:</span> {c.missingFields.join("; ")}
            </p>
          )}
          <p>
            <span className="font-semibold">Calculation:</span> {c.method} {Math.round(c.score)} × {c.weight.toFixed(2)} = {c.weightedContribution.toFixed(2)} points.
          </p>
          {c.assumptions.length > 0 && (
            <div>
              <span className="font-semibold">Assumptions:</span>
              <ul className="list-disc space-y-0.5 pl-4">
                {c.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </div>
          )}
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
  ["grid", "Grid interconnection"],
  ["resource", "Resource and operating prerequisites"],
  ["environment", "Environment and permitting"],
  ["community", "Community"],
  ["constraints", "Documented constraints"],
  ["data", "Missing critical evidence"],
];

const TONE: Record<ConsiderationTone, { icon: string; label: string; className: string }> = {
  advantage: { icon: "+", label: "Advantage", className: "text-emerald-700 dark:text-emerald-400" },
  neutral: { icon: "•", label: "Context", className: "text-zinc-400" },
  tradeoff: { icon: "−", label: "Tradeoff", className: "text-amber-700 dark:text-amber-400" },
  constraint: { icon: "!", label: "Critical constraint", className: "text-red-700 dark:text-red-400" },
  missing: { icon: "?", label: "Missing data", className: "text-zinc-500" },
  caveat: { icon: "!", label: "Caveat", className: "text-amber-700 dark:text-amber-400" },
};

function KeyConsiderations({ r }: { r: FeasibilityResult }) {
  const caveats = r.considerations.filter((c) => c.tone === "caveat");
  return (
    <section className="mt-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Key considerations</h3>
      {caveats.map((c) => (
        <p key={c.text} className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {c.text}
        </p>
      ))}
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
    </section>
  );
}

const ASSESSMENT_TEXT: Record<ConstraintAssessment, string> = {
  identified: "Identified",
  none_identified_in_available_data: "None identified in available data",
  not_assessed: "Not assessed",
};

function Constraints({ r }: { r: FeasibilityResult }) {
  const c = r.constraints;
  const box =
    c.assessment === "identified"
      ? "border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
      : "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300";
  return (
    <section aria-label="Critical constraints" className={`mt-3 rounded border px-2 py-1.5 text-[11px] ${box}`}>
      <p className="font-semibold">Critical constraints: {ASSESSMENT_TEXT[c.assessment]}</p>
      <p className="mt-0.5">{c.summary}</p>
      {c.critical.map((f) => (
        <div key={f.title} className="mt-1.5">
          <p className="font-semibold">
            {f.title} <span className="font-normal">({f.basis === "documented_prohibition" ? "documented prohibition" : "screening concern"})</span>
          </p>
          <p>{f.evidence}</p>
          <p>
            Source:{" "}
            {f.url ? (
              <a className="underline" href={f.url} target="_blank" rel="noreferrer">
                {f.source}
              </a>
            ) : (
              f.source
            )}
            {f.date ? ` (${f.date})` : ""}. Applies to: {f.technologies === "all" ? "all technologies" : f.technologies.join(", ").replace(/_/g, " ")}.
          </p>
        </div>
      ))}
      {c.screening.map((f) => (
        <p key={f.title} className="mt-1.5">
          <span className="font-semibold">Screening concern (not a prohibition):</span> {f.evidence} ({f.source})
        </p>
      ))}
      <details className="mt-1">
        <summary className="cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-sky-500">Checks ({c.checks.length})</summary>
        <ul className="mt-1 space-y-0.5">
          {c.checks.map((k) => (
            <li key={k.id}>
              <span className="font-medium">{k.label}</span> ({k.tier}): {ASSESSMENT_TEXT[k.status]}. <span className="text-zinc-500">{k.detail}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

const PERCENTILE_NOTES = [
  "A percentile is relative: the 50th means typical for plausible California sites for this technology and size class, not a 50% chance the project works.",
  "It magnifies small differences where many sites score alike (neutral components tie many sites): read it with the score and its components.",
];

function PercentileHeader({ g, r }: { g: GriddyGrade; r: FeasibilityResult }) {
  const p = g.percentile;
  if (!p) return null;
  const mlMissing = r.components.some((c) => c.key === "resource" && c.metrics.some((m) => m.id === "siting_similarity" && m.state === "missing"));
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{p.display.toFixed(1)} percentile</span>
          <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">
            among {p.count.toLocaleString()} plausible California sites for {r.technologyNoun} {tierLabel(r.voltageTier, g.policy).replace(/^≥/, "at ≥")}: {p.reference}
          </span>
        </span>
        <ProvenanceTip
          label="GriddyGrade percentile"
          provenance={{
            kind: "inferred",
            source: "Every 5 km cell of California scored with this policy (prep/grade_percentiles.py)",
            note: `Cut-offs of ${p.table.generated}, policy ${p.table.policy_version}${p.table.site_artifact ? `, site artifact ${p.table.site_artifact}` : ""}.`,
          }}
        >
          {PERCENTILE_NOTES.join(" ")}
        </ProvenanceTip>
      </div>
      <div className="mt-2">
        <Meter value={p.value} label="GriddyGrade percentile, 0 to 100" />
      </div>
      {p.table.policy_version !== r.policyVersion && (
        <p className="mt-1 text-[11px] text-amber-800 dark:text-amber-300">The percentile table was built with policy {p.table.policy_version}, not {r.policyVersion}: rebuild it before relying on the rank.</p>
      )}
      {mlMissing && <p className="mt-1 text-[11px] text-amber-800 dark:text-amber-300">Model signals are missing here but the reference sites had them, so compare this percentile with care.</p>}
    </div>
  );
}

export function GriddyGradeDetails({ grade: g, result: r }: { grade: GriddyGrade; result: FeasibilityResult }) {
  const storage = r.project.storageMw;
  return (
    <>
      <PercentileHeader g={g} r={r} />

      <h3 className="text-sm font-semibold">Power Plant Site Feasibility</h3>
      <div className="mt-1 flex items-center gap-2">
        <span className="min-w-0 flex-1">
          <span className="block text-sm">
            <span className="font-semibold tabular-nums">{r.overallScore}</span>/100 · {r.category}
          </span>
          <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">
            {r.technologyLabel}, {fmtMw(r.project.capacityMw)} proposed nameplate · preliminary screening
          </span>
        </span>
        <ProvenanceTip label="GriddyGrade" provenance={{ kind: "inferred", source: `Griddy power plant feasibility heuristic, policy ${r.policyVersion}` }}>
          S = {formulaFor(g.policy)}, each component 0–100. A screening heuristic, not an approval decision or a prediction of interconnection, permitting or cost.
        </ProvenanceTip>
      </div>
      <div className="mt-2">
        <Meter value={r.overallScoreRaw} label={`Score, ${r.overallScore} out of 100`} bands />
      </div>

      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 text-xs">
        <dt className="text-[11px] text-zinc-500 dark:text-zinc-400">Data completeness</dt>
        <dd className="flex flex-wrap items-center gap-x-1">
          <span className="font-semibold tabular-nums">{Math.round(r.dataCompletenessPercent)}%</span>
          <span>· {r.completenessLabel}</span>
          <ProvenanceTip label="Data completeness" provenance={{ kind: "inferred", source: "Weight of the fully observed components" }}>
            High 80–100%, Moderate 50–79%, Low under 50%. Not a probability of success or statistical confidence. {COMPLETENESS_SCOPE}
          </ProvenanceTip>
        </dd>
        <dt className="text-[11px] text-zinc-500 dark:text-zinc-400">Site</dt>
        <dd className="min-w-0 break-words">
          {g.siteName}
          {g.location && (
            <span className="block tabular-nums text-zinc-500">
              {g.location.lat.toFixed(4)}, {g.location.lon.toFixed(4)}
            </span>
          )}
        </dd>
        <dt className="text-[11px] text-zinc-500 dark:text-zinc-400">Grid search</dt>
        <dd>{tierLabel(r.voltageTier, g.policy)}</dd>
        {storage !== null && storage !== undefined && storage > 0 && (
          <>
            <dt className="text-[11px] text-zinc-500 dark:text-zinc-400">Storage</dt>
            <dd>{fmtMw(storage)} co-located, shown separately: not counted as generation and not scored</dd>
          </>
        )}
        <dt className="text-[11px] text-zinc-500 dark:text-zinc-400">Scoring policy</dt>
        <dd>
          {r.policyVersion} ({g.policy.date})
        </dd>
      </dl>
      <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">{COMPLETENESS_SCOPE}</p>

      <Constraints r={r} />

      <details className="mt-3 rounded border border-zinc-200 px-2 py-1.5 dark:border-zinc-800">
        <summary className="cursor-pointer rounded text-[11px] font-medium text-zinc-600 focus-visible:outline-2 focus-visible:outline-sky-500 dark:text-zinc-300">More project settings</summary>
        <div className="mt-2">
          <ProjectControls draft={g.draft} errors={g.projectErrors} advanced />
        </div>
      </details>

      <section className="mt-4">
        <h3 className="flex items-baseline text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Components
          <span className="ml-auto font-normal normal-case tracking-normal">score × weight = points</span>
        </h3>
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {r.components.map((c) => (
            <ComponentRow key={c.key} c={c} sources={sourcesFor(c, g.provenance)} />
          ))}
        </ul>
        <p className="mt-1 text-right text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
          Total {r.pointsTotal.toFixed(1)} points → score {r.overallScore}
          {g.percentile && ` → ${g.percentile.display.toFixed(1)} percentile`}
        </p>
      </section>

      <section aria-label="Excluded from this score" className="mt-3 rounded border border-zinc-300 bg-zinc-50 px-2 py-1.5 text-[11px] text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
        {r.exclusions.map((x) => (
          <p key={x.id} className="mt-0.5 first:mt-0">
            <span className="font-semibold">{x.label}: not assessed — excluded from this score.</span> {x.text}
          </p>
        ))}
      </section>

      <KeyConsiderations r={r} />

      <p className="mt-3 rounded border border-zinc-200 px-2 py-1 text-[11px] text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">{r.explanatoryNotes[0]}</p>
      <details className="mt-2 text-[11px] text-zinc-500">
        <summary className="cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-sky-500">Method and limitations</summary>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          {[...r.explanatoryNotes.slice(1), ...(g.percentile ? [`Percentile: ranked against ${g.percentile.reference}.`, ...PERCENTILE_NOTES] : [])].map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </details>
    </>
  );
}
