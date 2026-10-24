"use client";
// The GriddyGrade's details, shown when its card is expanded: category, data completeness, load,
// serious constraints, the five components, key considerations, method and limits. The headline
// score and category come from B's site-location model when it covers the site (MlGradeDetails).
// OWNER: workstream E (Site Intelligence).
import { ProvenanceTip } from "@/components/evaluate/ProvenanceTip";
import { MlGradeDetails } from "@/components/sites/MlGradeDetails";
import { fmtGrade, mlScore, type MlGradeState } from "@/components/sites/useMlGrade";
import type { Provenance } from "@/lib/contract";

import {
  CATEGORIES,
  DEFAULT_LOAD_MW,
  FORMULA,
  type ComponentKey,
  type ComponentResult,
  type ComponentStatus,
  type ConsiderationGroup,
  type ConsiderationTone,
  type FeasibilityResult,
} from "./feasibility";
import { setLoadBasis, type GriddyGrade } from "./useGriddyGrade";

/** E's category bands, applied to whichever score is the headline. */
function categoryFor(score: number): string {
  return CATEGORIES.find((c) => score >= c.min)?.label ?? CATEGORIES[CATEGORIES.length - 1].label;
}

const FILL: Record<ComponentStatus, string> = {
  observed: "bg-sky-600 dark:bg-sky-400",
  partial: "bg-sky-600/60 dark:bg-sky-400/60",
  unavailable: "bg-zinc-400 dark:bg-zinc-600",
};

/** Score bar on a 0-100 track. `bands` marks the category boundaries (20/40/60/80) as gaps. */
function Meter({
  value,
  status = "observed",
  label,
  valueText,
  bands = false,
}: {
  value: number;
  status?: ComponentStatus;
  label?: string;
  /** Spoken value, e.g. the headline's "97.8" (defaults to the value rounded to one decimal). */
  valueText?: string;
  bands?: boolean;
}) {
  const now = Math.round(value * 10) / 10;
  const a11y = label
    ? { role: "meter", "aria-label": label, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": now, "aria-valuetext": valueText ?? String(now) }
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
  grid: /substation|transmission|straight-line/i,
  generation: /EIA-860/i,
  community: /population/i,
  air: /Green Book|AirNow/i,
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
const mwText = (v: number) => `${Math.round(v).toLocaleString()} MW`;

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

export function GriddyGradeDetails({ grade: g, result: r, ml }: { grade: GriddyGrade; result: FeasibilityResult | null; ml: MlGradeState }) {
  const load = g.scenarioLoad;
  const modelScore = mlScore(ml.grade);
  // Until the model answers, no number is called the GriddyGrade; after a failed request the
  // heuristic stands in, labelled as the site checks.
  const headline = modelScore ?? (ml.loading ? null : (r?.overallScore ?? null));
  const category = ml.loading ? "Loading the model score…" : modelScore !== null ? categoryFor(modelScore) : (r?.category ?? "No score for this site");
  const basis =
    modelScore !== null
      ? "projected by the site-location model"
      : ml.loading
        ? "waiting for the site-location model"
        : ml.error
          ? "site checks shown: the model score failed to load"
          : "site checks (model has no score here)";
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{category}</span>
          <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">out of 100 · data center site feasibility, {basis}</span>
        </span>
        {ml.error && (
          <button
            type="button"
            onClick={ml.retry}
            className="shrink-0 rounded-md border border-zinc-300 px-2 py-0.5 text-[11px] text-zinc-700 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300"
          >
            Retry
          </button>
        )}
        {modelScore === null && !ml.loading && r && (
          <ProvenanceTip label="Site checks" provenance={{ kind: "inferred", source: "Griddy feasibility heuristic (initial product weights)" }}>
            Site checks = {FORMULA}. A screening heuristic, not an approval decision or a prediction of interconnection, permitting or cost.
          </ProvenanceTip>
        )}
      </div>
      {headline !== null && (
        <div className="mt-2">
          <Meter value={headline} label="GriddyGrade, 1 to 100" valueText={fmtGrade(headline)} bands />
        </div>
      )}
      {ml.grade && (
        <div className="mt-3">
          <MlGradeDetails grade={ml.grade} />
        </div>
      )}
      {!r ? (
        <p className="mt-4 text-[11px] text-zinc-500 dark:text-zinc-400">Site checks unavailable: the site summary failed to load.</p>
      ) : (
        <SiteChecks g={g} r={r} load={load} />
      )}
    </>
  );
}

function SiteChecks({ g, r, load }: { g: GriddyGrade; r: FeasibilityResult; load: GriddyGrade["scenarioLoad"] }) {
  return (
    <>
      <h3 className="mt-4 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Site checks · {r.overallScore}
        <ProvenanceTip label="Site checks" provenance={{ kind: "inferred", source: "Griddy feasibility heuristic (initial product weights)" }}>
          Site checks = {FORMULA}. A transparent screening heuristic on the site summary and site intel, shown alongside the model score.
        </ProvenanceTip>
      </h3>

      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 text-xs">
        <dt className="text-[11px] text-zinc-500 dark:text-zinc-400">Data completeness</dt>
        <dd className="flex flex-wrap items-center gap-x-1">
          <span className="font-semibold tabular-nums">{r.dataCompletenessPercent}%</span>
          <span>· {r.completenessLabel}</span>
          {r.partialPercent > 0 && <span className="text-zinc-500">(+{r.partialPercent}% partial)</span>}
          <ProvenanceTip label="Data completeness" provenance={{ kind: "inferred", source: "Share of the score's weight from fully observed components" }}>
            High 80–100%, Moderate 50–79%, Low under 50%. It measures data coverage, not statistical confidence or the probability of success.
          </ProvenanceTip>
        </dd>
        <dt className="text-[11px] text-zinc-500 dark:text-zinc-400">Site</dt>
        <dd className="min-w-0 break-words">
          {g.siteName}
          {g.location && (
            <span className="block tabular-nums text-zinc-500">
              {g.location.lat.toFixed(3)}, {g.location.lon.toFixed(3)}
            </span>
          )}
        </dd>
        <dt className="text-[11px] text-zinc-500 dark:text-zinc-400">Assumed load</dt>
        <dd className="min-w-0">
          <span className="block">
            <span className="font-semibold tabular-nums">{mwText(g.loadMw)}</span> average
            <span className="text-zinc-500">
              {g.usingScenarioLoad && load
                ? ` · scenario: ${mwText(load.peakMw)} peak × ${load.loadFactor.toFixed(2)} load factor`
                : ` · default assumption${load ? "" : " (this scenario is not a data center)"}`}
            </span>
          </span>
          <span role="group" aria-label="Load used for the site checks" className="mt-1 inline-flex rounded-md border border-zinc-300 p-0.5 text-[11px] dark:border-zinc-700">
            {(
              [
                ["scenario", "Scenario load"],
                ["default", `${DEFAULT_LOAD_MW} MW default`],
              ] as const
            ).map(([value, label]) => {
              const active = value === "scenario" ? g.usingScenarioLoad : !g.usingScenarioLoad;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={active}
                  disabled={value === "scenario" && !load}
                  onClick={() => setLoadBasis(value)}
                  className={`rounded px-1.5 py-0.5 focus-visible:outline-2 focus-visible:outline-sky-500 disabled:cursor-not-allowed disabled:opacity-40 ${
                    active ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black" : "text-zinc-600 dark:text-zinc-400"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </span>
        </dd>
      </dl>

      {g.intelPending && <p className="mt-2 text-[11px] text-zinc-400">Waiting for site screening (air quality); it counts as missing until it arrives.</p>}
      {r.qualification && (
        <p
          className={`mt-3 rounded border px-2 py-1 text-[11px] ${
            r.completenessLabel === "Low"
              ? "border-amber-400 bg-amber-50 font-medium text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
              : "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
          }`}
        >
          {r.qualification}
        </p>
      )}
      {r.seriousConstraints.length > 0 && (
        <div className="mt-3 rounded border border-red-300 bg-red-50 px-2 py-1 text-[11px] text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <p className="font-semibold">Serious constraints (no score offsets these)</p>
          <ul className="mt-0.5 list-disc pl-4">
            {r.seriousConstraints.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      )}

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
          Total {r.overallScoreRaw.toFixed(1)} points → site checks {r.overallScore}
        </p>
      </section>

      <KeyConsiderations r={r} />

      <details className="mt-3 text-[11px] text-zinc-500">
        <summary className="cursor-pointer">Method and limitations</summary>
        <p className="mt-1 tabular-nums">Site checks = {FORMULA}, each component 0–100. The GriddyGrade itself is the site-location model score above.</p>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          {r.explanatoryNotes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </details>
    </>
  );
}
