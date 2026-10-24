// Data center site feasibility: a preliminary 0-100 screening score for the selected site.
// OWNER: workstream E (Site Intelligence).
//
// Pure and deterministic: no React, no fetching and only `import type`, so Node runs this file
// as-is in the tests (feasibility.test.mjs). feasibilityInput.ts builds the input from A's site
// summary and E's site intel; the app shows the result as the GriddyGrade (GriddyGradeCard.tsx,
// with GriddyGradeDetails.tsx when expanded), led by its percentile among plausible California
// sites (percentile.ts, cut-offs in gradePercentiles.json).
//
//   GriddyGrade = 0.36 G + 0.25 P + 0.17 C + 0.17 A + 0.05 I      (each component 0-100)
//
// capped at 35 when both the nearest 220 kV+ substation and line are more than 20 km away (a
// must-have that high community and air scores must not offset). Land is not scored. G and P
// also use model signals from E's site intel (extras.ml): the county's interconnection queue
// (a congestion penalty on G, up to 25% off) and how much nearby land looks like where clean
// plants were built (30% of P). Those are supplementary: without them the penalty doesn't apply,
// the other metrics keep their original proportions, and data completeness is unchanged. The weights and thresholds are initial product heuristics, not
// validated predictions of interconnection approval, cost or permitting. Missing data is never
// read as 0 km, 0 people or 0 MW: a metric without data drops out of its component (the others
// are reweighted), and a component with no data at all scores a neutral 50 and lowers data
// completeness.

export type ComponentKey = "grid" | "generation" | "community" | "air" | "infrastructure";
export type ComponentStatus = "observed" | "partial" | "unavailable";
export type CompletenessLabel = "High" | "Moderate" | "Low";

export const COMPONENT_KEYS: ComponentKey[] = ["grid", "generation", "community", "air", "infrastructure"];

// I barely varies among sites in a utility territory, so its share went to G and P.
export const WEIGHTS: Record<ComponentKey, number> = {
  grid: 0.36,
  generation: 0.25,
  community: 0.17,
  air: 0.17,
  infrastructure: 0.05,
};

export const COMPONENT_LABEL: Record<ComponentKey, string> = {
  grid: "Grid connection and queue",
  generation: "Nearby and buildable generation",
  community: "Community impact",
  air: "Air quality and permitting",
  infrastructure: "Local infrastructure support",
};

const SYMBOL: Record<ComponentKey, string> = { grid: "G", generation: "P", community: "C", air: "A", infrastructure: "I" };
/** "0.36 G + 0.25 P + ...", built from WEIGHTS so the displayed formula always matches the math. */
export const FORMULA = COMPONENT_KEYS.map((k) => `${WEIGHTS[k].toFixed(2)} ${SYMBOL[k]}`).join(" + ");

export const DEFAULT_LOAD_MW = 100; // product assumption for an average data center, not a typical value
export const NEUTRAL_SCORE = 50;
export const HV_KV = 220; // Griddy's 220 kV+ class (230 kV incl. SCE's 220 kV system), as in explore/service.py
export const GRID_ZERO_KM = 20; // D(d) reaches 0 here
export const GRID_REACH_KM = GRID_ZERO_KM; // both 220 kV+ assets beyond this: the grade is capped
export const MUST_HAVE_CAP = 35;
export const QUEUE_REF_MW = 100; // Q(q) is logarithmic in q / 100 MW
export const QUEUE_ZERO_MW = 30_000; // Q reaches 0 here (Kern, the largest county queue, has ~29 GW)
export const QUEUE_HIGH_MW = 10_000; // flagged as congested (the backend adds a needs_utility_study finding)
export const QUEUE_MAX_PENALTY = 0.25; // the most a full queue takes off G
export const GENERATION_RADIUS_KM = 25;
export const GENERATION_LOAD_MULTIPLE = 5; // full capacity marks at 5 x the load in nearby nameplate
export const CLEAN_BUILD_RADIUS_KM = 25;
export const ML_MAX_CELL_KM = 5; // model signals from a 5 km cell farther than this don't describe the site
export const POPULATION_RADIUS_KM = 10;
export const POPULATION_SCALE = 500_000; // C reaches 0 at 500,000 people
export const LOWER_CARBON_FUELS = ["solar", "wind", "hydro", "geothermal"];
const STORAGE_FUELS = ["battery"]; // storage, not primary generation
export const ATTAINMENT_SCORE = 100;
/** Score per EPA classification (first word, so "Severe 15" and "Marginal (Rural Transport)" match). */
export const NONATTAINMENT_SCORE = new Map<string, number>([
  ["marginal", 70],
  ["moderate", 50],
  ["serious", 30],
  ["severe", 10],
  ["extreme", 10],
]);
export const IDENTIFIED_SCORE = 100;
export const NOT_IDENTIFIED_SCORE = 20; // both 100 -> 100, one -> 60, neither -> 20
export const CATEGORIES: { min: number; label: string }[] = [
  { min: 80, label: "Favorable preliminary screening" },
  { min: 60, label: "Moderately favorable" },
  { min: 40, label: "Mixed constraints" },
  { min: 20, label: "Challenging" },
  { min: 0, label: "Highly constrained" },
];

// ---------------------------------------------------------------------------
// Input: null always means "not available", never zero
// ---------------------------------------------------------------------------

export interface AssetRef {
  name: string | null;
  voltageKv: number | null;
  distanceKm: number | null;
}

export interface GenerationInput {
  plantCount: number | null;
  /** Operating nameplate MW within 25 km by fuel, split per generator (hybrids counted once). null: no breakdown. */
  byFuelMw: Record<string, number> | null;
  /** Total nameplate MW within 25 km, all fuels incl. storage. Used only when byFuelMw is null. */
  totalMw: number | null;
  /** True when the totals come from a capped plant list, not the full 25 km aggregate. */
  incomplete?: boolean;
}

export interface Designation {
  pollutant: string | null;
  naaqs: string | null;
  area: string | null;
  classification: string | null;
}

export interface AqiContext {
  aqi: number | null;
  category: string | null;
  pollutant: string | null;
}

/** A territory lookup: found by name, looked and found none, or could not look (data missing). */
export type Lookup = { status: "identified"; name: string } | { status: "none" } | { status: "unknown" };

export type CleanKind = "solar_pv" | "onshore_wind" | "battery";
export const CLEAN_KIND_LABEL: Record<CleanKind, string> = { solar_pv: "solar", onshore_wind: "wind", battery: "battery" };

/** A's demand forecast for the site's region (P50: the P10-P90 band is too narrow to lean on). */
export interface DemandSignal {
  forecastId: string;
  scenario: string;
  year: number;
  baseYear: number;
  regionName: string;
  basePeakP50Mw: number;
  peakP50Mw: number;
  mapeP50Pct: number | null;
  /** Share of test hours inside the P10-P90 band (the runbook asks for 0.6-0.95). */
  coverage: number | null;
}

/** Model signals for the site's nearest 5 km cell (E's site intel extras.ml). */
export interface MlSignals {
  /** B's site-location artifact and its spatial-CV ROC-AUC per technology. */
  artifactId: string;
  rocAuc: Partial<Record<CleanKind, number>>;
  /** Site to the center of the cell the signals describe. */
  cellKm: number;
  county: string | null;
  /** Active interconnection requests in the county, MW (LBNL Queued Up). null: not available. */
  queueMw: number | null;
  /** Best suitability (0-1) among cells within 25 km per technology; null: not available. */
  cleanBuild: Record<CleanKind, number | null> | null;
  demand: DemandSignal | null;
}

export interface FeasibilityInput {
  /** Nearest 220 kV+ substation; null when unknown. */
  substation: AssetRef | null;
  /** Nearest operational AC 220 kV+ transmission line; null when unknown. */
  line: AssetRef | null;
  /** null: plant data unavailable (not "no plants"). */
  generation: GenerationInput | null;
  /** Estimated population within 10 km; null when unknown. */
  population: number | null;
  /** EPA nonattainment designations at the site: [] = none listed, null = designation data unavailable. */
  designations: Designation[] | null;
  /** Current AQI: context only, never scored. */
  aqi: AqiContext | null;
  utility: Lookup;
  balancingAuthority: Lookup;
  /** True only when the site is confirmed outside the supported (California) coverage. */
  outsideCoverage: boolean;
  /** Why a component's inputs are missing, e.g. "outside California data coverage". */
  reasons?: Partial<Record<ComponentKey, string>>;
  /** Model signals; null or absent: not available (the grade then uses the rules alone). */
  ml?: MlSignals | null;
  /** Why the model signals are missing. */
  mlReason?: string;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Where a metric's number comes from, when it isn't one of A's or E's rule inputs. */
export interface MetricSource {
  kind: "observed" | "inferred";
  /** Short label shown beside the metric, e.g. "inferred (ML)". */
  tag: string;
  /** Artifact id, accuracy and caveats. */
  detail: string;
}

export interface MetricResult {
  id: string;
  label: string;
  /** Weight within the component as designed. */
  weight: number;
  /** Weight after renormalizing over the metrics that have data (0 when missing / not applicable). */
  effectiveWeight: number;
  state: "observed" | "missing" | "not_applicable";
  score: number | null;
  value: string;
  /** Supplementary (model signals): when missing it drops out without making the component partial. */
  optional?: boolean;
  /** Multiplies instead of averaging: weight is the most it can take off (at score 0); effectiveWeight what it took. */
  penalty?: boolean;
  source?: MetricSource;
}

export interface Fact {
  label: string;
  value: string;
}

export interface ComponentResult {
  key: ComponentKey;
  label: string;
  weight: number;
  /** 0-100; NEUTRAL_SCORE when unavailable. */
  score: number;
  status: ComponentStatus;
  /** score x weight, in overall score points. */
  weightedContribution: number;
  metrics: MetricResult[];
  /** Observed inputs shown for context that do not change the score. */
  context: Fact[];
  missingFields: string[];
  explanation: string;
  method: string;
  notes: string[];
}

export type ConsiderationGroup = "infrastructure" | "community" | "data";
export type ConsiderationTone = "advantage" | "neutral" | "tradeoff" | "constraint" | "missing" | "caveat";

export interface Consideration {
  group: ConsiderationGroup;
  tone: ConsiderationTone;
  text: string;
}

export interface GradeCap {
  limit: number;
  reason: string;
}

export interface FeasibilityResult {
  /** Rounded to the nearest tenth for display. */
  overallScore: number;
  /** Clamped to 0-100 and capped, unrounded. */
  overallScoreRaw: number;
  /** Sum of the weighted contributions before the cap. */
  pointsTotal: number;
  /** Set when a missing must-have capped the grade below pointsTotal. */
  cap: GradeCap | null;
  category: string;
  targetLoadMw: number;
  /** 100 x the weight of fully observed components. Data completeness, not a probability of success. */
  dataCompletenessPercent: number;
  /** 100 x the weight of partially observed components. */
  partialPercent: number;
  completenessLabel: CompletenessLabel;
  components: ComponentResult[];
  componentScores: Record<ComponentKey, number>;
  weightedContributions: Record<ComponentKey, number>;
  componentStatuses: Record<ComponentKey, ComponentStatus>;
  missingFields: string[];
  considerations: Consideration[];
  /** Constraints a high overall score must not hide. */
  seriousConstraints: string[];
  /** Shown beside the score whenever data completeness is not High. */
  qualification: string | null;
  explanatoryNotes: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));

/** A finite number >= 0, else null: negative, NaN, Infinity and non-numbers are invalid, never 0. */
export function validNonNegative(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

const validPositive = (v: unknown): number | null => {
  const n = validNonNegative(v);
  return n !== null && n > 0 ? n : null;
};

const en = (v: number) => v.toLocaleString("en-US");
const fmtKm = (v: number) => (v < 10 ? `${v.toFixed(1)} km` : `${en(Math.round(v))} km`);
const fmtMw = (v: number) => (v >= 100 ? `${en(Math.round(v))} MW` : v >= 10 ? `${v.toFixed(0)} MW` : `${v.toFixed(1)} MW`);
const fmtKv = (v: number | null) => (v !== null && v > 0 ? `${Math.round(v)} kV` : "voltage not tagged");
const fmtPeople = (n: number) => en(n >= 1000 ? Math.round(n / 100) * 100 : Math.round(n));
const fmtPct = (share: number) => `${Math.round(share * 100)}%`;
const fmtScore = (v: number) => String(Math.round(v));
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const withReason = (what: string, reason: string | undefined) => (reason ? `${what} (${reason})` : what);

/** D(d) = 100 x max(0, 1 - d / 20), d = straight-line km. */
export function distanceScore(km: number): number {
  return 100 * Math.max(0, 1 - km / GRID_ZERO_KM);
}

/** Q(q) = 100 x max(0, 1 - ln(1 + q / 100) / ln(1 + 30,000 / 100)), q = county queue MW. Never rises with q. */
export function queueScore(mw: number): number {
  return clamp(100 * Math.max(0, 1 - Math.log1p(mw / QUEUE_REF_MW) / Math.log1p(QUEUE_ZERO_MW / QUEUE_REF_MW)));
}

/** B = 100 x (0.75 max(solar, wind) + 0.25 battery), each the best suitability within 25 km; a missing part drops out. */
export function cleanBuildScore(best: Record<CleanKind, number | null>): number | null {
  const gen = [best.solar_pv, best.onshore_wind].map(validNonNegative).filter((v): v is number => v !== null);
  const parts: [number, number][] = [];
  if (gen.length) parts.push([0.75, Math.min(1, Math.max(...gen))]);
  const battery = validNonNegative(best.battery);
  if (battery !== null) parts.push([0.25, Math.min(1, battery)]);
  if (!parts.length) return null;
  const w = parts.reduce((a, [wt]) => a + wt, 0);
  return (100 * parts.reduce((a, [wt, v]) => a + wt * v, 0)) / w;
}

/** (2035 P50 regional peak growth + this site's load) / base P50 peak: context only, never scored. */
export function demandPressure(d: DemandSignal, loadMw: number): number | null {
  const base = validPositive(d.basePeakP50Mw);
  const peak = validNonNegative(d.peakP50Mw);
  return base === null || peak === null ? null : (peak - base + loadMw) / base;
}

/** C = 100 x max(0, 1 - ln(1 + N) / ln(500001)). */
export function communityScore(population: number): number {
  return clamp(100 * Math.max(0, 1 - Math.log1p(population) / Math.log1p(POPULATION_SCALE)));
}

/** Score for one EPA classification, or null when it isn't recognized. */
export function designationScore(classification: string | null): number | null {
  const word = (classification ?? "").trim().toLowerCase().match(/^[a-z]+/)?.[0];
  return word ? (NONATTAINMENT_SCORE.get(word) ?? null) : null;
}

export function categoryFor(score: number): string {
  return (CATEGORIES.find((c) => score >= c.min) ?? CATEGORIES[CATEGORIES.length - 1]).label;
}

export function completenessLabelFor(percent: number): CompletenessLabel {
  return percent >= 80 ? "High" : percent >= 50 ? "Moderate" : "Low";
}

function metric(id: string, label: string, weight: number, score: number | null, value: string, state?: MetricResult["state"]): MetricResult {
  return { id, label, weight, effectiveWeight: 0, state: state ?? (score === null ? "missing" : "observed"), score: score === null ? null : clamp(score), value };
}

const ML_TAG = "inferred (ML)";
const fmtAuc = (ml: MlSignals, kinds: CleanKind[]) =>
  kinds
    .filter((k) => ml.rocAuc[k] !== undefined)
    .map((k) => `${CLEAN_KIND_LABEL[k]} ${(ml.rocAuc[k] as number).toFixed(2)}`)
    .join(", ");

function queueMetric(ml: MlSignals | null, weight: number, missingFields: string[], mlReason?: string): MetricResult {
  const q = validNonNegative(ml?.queueMw);
  if (!ml || q === null) {
    missingFields.push(withReason("County interconnection queue (model signal)", ml ? "not in the site artifact" : mlReason));
    return { ...metric("queue", "Interconnection queue congestion", weight, null, "Not available"), optional: true, penalty: true };
  }
  return {
    ...metric("queue", "Interconnection queue congestion", weight, queueScore(q), `${fmtMw(q)} of active requests in ${ml.county ? `${ml.county} County` : "the county"}`),
    optional: true,
    penalty: true,
    source: {
      kind: "observed",
      tag: "observed (LBNL)",
      detail: `LBNL Queued Up county total, read from B's site artifact ${ml.artifactId}. A county-wide congestion signal, not the queue at a specific substation.`,
    },
  };
}

function cleanBuildMetric(ml: MlSignals | null, weight: number, missingFields: string[], mlReason?: string): MetricResult {
  const label = `Clean-build similarity within ${CLEAN_BUILD_RADIUS_KM} km`;
  const score = ml?.cleanBuild ? cleanBuildScore(ml.cleanBuild) : null;
  if (!ml || !ml.cleanBuild || score === null) {
    missingFields.push(withReason("Clean-build similarity (model signal)", ml ? "not in the site artifact" : mlReason));
    return { ...metric("clean_build", label, weight, null, "Not available"), optional: true };
  }
  const best = ml.cleanBuild;
  const value = (Object.keys(CLEAN_KIND_LABEL) as CleanKind[])
    .filter((k) => validNonNegative(best[k]) !== null)
    .map((k) => `${capitalize(CLEAN_KIND_LABEL[k])} ${(best[k] as number).toFixed(2)}`)
    .join(" · ");
  return {
    ...metric("clean_build", label, weight, score, `${value} (best cell within ${CLEAN_BUILD_RADIUS_KM} km, 0-1)`),
    optional: true,
    source: {
      kind: "inferred",
      tag: ML_TAG,
      detail: `B's site-location model ${ml.artifactId} (spatial-CV ROC-AUC ${fmtAuc(ml, ["solar_pv", "onshore_wind", "battery"])}). A similarity score: how much nearby land looks like where these plants were built, not a feasibility or permitting finding.`,
    },
  };
}

function pressureFact(ml: MlSignals | null, loadMw: number): Fact | null {
  const d = ml?.demand;
  const share = d ? demandPressure(d, loadMw) : null;
  if (!d || share === null) return null;
  const growth = d.peakP50Mw - d.basePeakP50Mw;
  const acc = [d.mapeP50Pct !== null ? `P50 MAPE ${d.mapeP50Pct.toFixed(1)}%` : null, d.coverage !== null ? `P10-P90 band held ${fmtPct(d.coverage)} of test hours` : null].filter(Boolean).join("; ");
  return {
    label: `Regional demand pressure, ${d.year} (${ML_TAG}, context only)`,
    value: `${fmtPct(share)} of the ${d.regionName} ${d.baseYear} peak: ${growth >= 0 ? "+" : "−"}${fmtMw(Math.abs(growth))} P50 growth + ${fmtMw(loadMw)} this site (forecast ${d.forecastId}, scenario '${d.scenario}'${acc ? `; ${acc}` : ""})`,
  };
}

interface Parts {
  metrics: MetricResult[];
  missingFields: string[];
  explain: (score: number, status: ComponentStatus) => string;
  method: string;
  notes: string[];
  context?: Fact[];
  /** Force "partial" even when every metric has a value (e.g. totals from a capped list). */
  partial?: boolean;
}

/** Share of the component a penalty metric takes off: its weight at score 0, nothing at 100. */
const penaltyShare = (m: MetricResult) => m.weight * (1 - (m.score as number) / 100);

/**
 * Weighted mean of the metrics that have data, weights renormalized; neutral 50 when none do.
 * Penalty metrics then scale that mean down. Optional metrics (model signals) only supplement:
 * they never stand in for missing required ones.
 */
function component(key: ComponentKey, p: Parts): ComponentResult {
  const required = p.metrics.filter((m) => !m.optional);
  const supplementOnly = required.length > 0 && required.every((m) => m.state === "missing");
  const counts = (m: MetricResult) => m.state === "observed" && m.score !== null && !supplementOnly;
  const scored = p.metrics.filter((m) => counts(m) && !m.penalty);
  const total = scored.reduce((a, m) => a + m.weight, 0);
  const mean = total > 0 ? scored.reduce((a, m) => a + m.weight * (m.score as number), 0) / total : null;
  const raw = mean === null ? null : p.metrics.filter((m) => m.penalty && counts(m)).reduce((a, m) => a * (1 - penaltyShare(m)), mean);
  const effective = (m: MetricResult) => (!counts(m) || mean === null ? 0 : m.penalty ? penaltyShare(m) : total > 0 ? m.weight / total : 0);
  const metrics = p.metrics.map((m) => ({ ...m, effectiveWeight: effective(m) }));
  const status: ComponentStatus = raw === null ? "unavailable" : p.partial || required.some((m) => m.state === "missing") ? "partial" : "observed";
  const score = raw === null ? NEUTRAL_SCORE : clamp(raw);
  return {
    key,
    label: COMPONENT_LABEL[key],
    weight: WEIGHTS[key],
    score,
    status,
    weightedContribution: score * WEIGHTS[key],
    metrics,
    context: p.context ?? [],
    missingFields: p.missingFields,
    explanation: p.explain(score, status),
    method: p.method,
    notes: p.notes,
  };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/**
 * G = (0.60 D(substation km) + 0.40 D(line km)) x (1 - 0.25 (1 - Q / 100)), 220 kV+ assets only:
 * the county queue is a congestion penalty, so an empty queue can't lift a site far from the grid.
 */
export function scoreGridProximity(
  substation: AssetRef | null,
  line: AssetRef | null,
  reason?: string,
  ml: MlSignals | null = null,
  targetLoadMw: number = DEFAULT_LOAD_MW,
  mlReason?: string,
): ComponentResult {
  const missingFields: string[] = [];
  const side = (id: string, what: string, weight: number, a: AssetRef | null): MetricResult => {
    // Never substitute a lower-voltage asset: a known voltage under 220 kV does not qualify.
    const qualifies = a !== null && (a.voltageKv === null || a.voltageKv >= HV_KV);
    const km = qualifies ? validNonNegative(a?.distanceKm) : null;
    if (km === null) {
      missingFields.push(withReason(`Distance to the nearest ${what}`, a && !qualifies ? `only a ${fmtKv(a.voltageKv)} asset was found` : reason));
      return metric(id, `Nearest ${what}`, weight, null, "Not available");
    }
    const named = a?.name ? `${a.name}, ` : "";
    return metric(id, `Nearest ${what}`, weight, distanceScore(km), `${fmtKm(km)} (${named}${fmtKv(a?.voltageKv ?? null)})`);
  };
  const metrics = [
    side("substation", "220 kV+ substation", 0.6, substation),
    side("line", "220 kV+ AC line", 0.4, line),
    queueMetric(ml, QUEUE_MAX_PENALTY, missingFields, mlReason),
  ];
  const pressure = pressureFact(ml, validPositive(targetLoadMw) ?? DEFAULT_LOAD_MW);
  return component("grid", {
    metrics,
    missingFields,
    context: pressure ? [pressure] : [],
    explain: (_score, status) => {
      if (status === "unavailable") return withReason("No 220 kV+ distance data, so this component uses a neutral 50", reason) + ".";
      const [sub, ln, queue] = metrics;
      const known = [sub, ln].filter((m) => m.state === "observed").map((m) => `${m.label.replace("Nearest ", "")} ${m.value.split(" (")[0]} → ${fmtScore(m.score as number)}`);
      const lead = known.length < 2 ? `${known[0]}; the other distance is unknown, so this one carries the full weight` : known.join("; ");
      const q = queue.state === "observed" ? `; a ${queue.value.split(" of ")[0]} county queue (Q ${fmtScore(queue.score as number)}) takes ${fmtPct(penaltyShare(queue))} off` : "";
      return `${lead}${q}. Each distance scores 100 at the asset and 0 at ${GRID_ZERO_KM} km or more; the queue takes nothing off when empty and up to ${fmtPct(QUEUE_MAX_PENALTY)} at ${en(QUEUE_ZERO_MW)} MW.`;
    },
    method: `G = (0.60 × D(substation km) + 0.40 × D(line km)) × (1 − ${QUEUE_MAX_PENALTY} × (1 − Q / 100)), D(d) = 100 × max(0, 1 − d / ${GRID_ZERO_KM}), Q(q) = 100 × max(0, 1 − ln(1 + q / ${QUEUE_REF_MW}) / ln(1 + ${en(QUEUE_ZERO_MW)} / ${QUEUE_REF_MW})) for the county's queued MW. Operational AC assets of ${HV_KV} kV and up only; a missing distance drops out and the other carries its weight. Without the queue signal there is no penalty. Regional demand pressure is shown for context and not scored.`,
    notes: [
      "Straight-line distances underestimate real connection routes, which follow terrain and rights-of-way.",
      "Proximity does not establish spare capacity, interconnection approval or connection cost.",
      "The queue is the county's total of active interconnection requests (mostly generation and storage): a congestion signal for the area, not the queue position or study status at any one substation.",
    ],
  });
}

/**
 * P = 0.56 capacity + 0.14 lower-carbon mix + 0.30 clean-build similarity (B), plants and cells within 25 km.
 * Without the similarity signal capacity and mix keep their 80/20 split.
 */
export function scoreGeneration(
  gen: GenerationInput | null,
  targetLoadMw: number = DEFAULT_LOAD_MW,
  reason?: string,
  ml: MlSignals | null = null,
  mlReason?: string,
): ComponentResult {
  const load = validPositive(targetLoadMw) ?? DEFAULT_LOAD_MW;
  const needed = GENERATION_LOAD_MULTIPLE * load;
  const missingFields: string[] = [];
  const context: Fact[] = [];
  let capacityMw: number | null = null;
  let mixShare: number | null = null;
  let mixState: MetricResult["state"] = "missing";
  let partial = false;

  if (gen?.byFuelMw) {
    let eligible = 0;
    let lower = 0;
    let storage = 0;
    const parts: [string, number][] = [];
    for (const [fuel, v] of Object.entries(gen.byFuelMw)) {
      const mw = validNonNegative(v);
      if (mw === null) {
        partial = true;
        missingFields.push(`Capacity of ${fuel} plants (invalid value skipped)`);
        continue;
      }
      parts.push([fuel, mw]);
      if (STORAGE_FUELS.includes(fuel)) storage += mw;
      else {
        eligible += mw;
        if (LOWER_CARBON_FUELS.includes(fuel)) lower += mw;
      }
    }
    capacityMw = eligible;
    if (eligible > 0) {
      mixShare = lower / eligible;
      mixState = "observed";
    } else mixState = "not_applicable";
    const mix = parts.filter(([, mw]) => mw > 0).sort((a, b) => b[1] - a[1]);
    if (mix.length) context.push({ label: "Fuel mix (nameplate)", value: mix.map(([f, mw]) => `${capitalize(f)} ${fmtMw(mw)}`).join(" · ") });
    if (storage > 0) context.push({ label: "Battery storage", value: `${fmtMw(storage)}, not counted as generation` });
  } else if (gen) {
    const total = validNonNegative(gen.totalMw);
    if (total !== null) {
      capacityMw = total;
      mixState = total > 0 ? "missing" : "not_applicable";
      if (total > 0) missingFields.push("Fuel mix (so storage could not be separated from generation)");
    }
  }
  if (capacityMw !== null && gen?.incomplete) {
    partial = true;
    missingFields.push("Full 25 km plant total (only the nearest listed plants were summed)");
  }
  if (capacityMw === null) missingFields.push(withReason(`Operating plant capacity within ${GENERATION_RADIUS_KM} km`, reason));

  const count = validNonNegative(gen?.plantCount);
  if (count !== null) context.unshift({ label: "Operating plants (≥ 1 MW)", value: `${en(count)} within ${GENERATION_RADIUS_KM} km` });

  const cap = capacityMw;
  const metrics = [
    metric(
      "capacity",
      `Nameplate generation within ${GENERATION_RADIUS_KM} km vs ${GENERATION_LOAD_MULTIPLE} × load`,
      0.56,
      cap === null ? null : 100 * Math.min(1, cap / needed),
      cap === null ? "Not available" : `${fmtMw(cap)} vs ${fmtMw(needed)} (${GENERATION_LOAD_MULTIPLE} × the ${fmtMw(load)} load)`,
    ),
    metric(
      "mix",
      "Lower-carbon share (solar, wind, hydro, geothermal)",
      0.14,
      mixShare === null ? null : 100 * mixShare,
      mixState === "observed" ? fmtPct(mixShare as number) : mixState === "not_applicable" ? "Not applicable: no generation nearby" : "Not available",
      cap === null ? "missing" : mixState,
    ),
    cleanBuildMetric(ml, 0.3, missingFields, mlReason),
  ];
  return component("generation", {
    metrics,
    missingFields,
    context,
    partial,
    explain: (_score, status) => {
      if (status === "unavailable" || cap === null) return withReason("No operating-plant data, so this component uses a neutral 50", reason) + ".";
      const clean = metrics[2].state === "observed" ? `; clean-build similarity nearby → ${fmtScore(metrics[2].score as number)}` : "";
      if (cap === 0) return `No operating generation within ${GENERATION_RADIUS_KM} km, so the capacity proxy scores 0${clean}.`;
      const share = cap >= needed ? "at least" : `${fmtPct(cap / needed)} of`;
      const ratio = `${fmtMw(cap)} of nameplate generation is ${share} ${GENERATION_LOAD_MULTIPLE} × the ${fmtMw(load)} load (→ ${fmtScore(metrics[0].score as number)})`;
      const mix = metrics[1].state === "observed" ? `; ${metrics[1].value} of it is lower-carbon (→ ${fmtScore(metrics[1].score as number)})` : "";
      return `${ratio}${mix}${clean}.`;
    },
    method: `P = 0.56 × 100 × min(1, nearby MW / (${GENERATION_LOAD_MULTIPLE} × load MW)) + 0.14 × 100 × lower-carbon MW / eligible MW + 0.30 × B. Operating EIA-860 plants ≥ 1 MW within ${GENERATION_RADIUS_KM} km, hybrids split by generator. Batteries are storage and excluded; nuclear, gas and other fuels count as not lower-carbon. Without generation or a fuel mix, the mix term drops out. B = 100 × (0.75 × max(solar, wind) + 0.25 × battery), each the best suitability among 5 km cells within ${CLEAN_BUILD_RADIUS_KM} km (gas left out: its scores are optimistic and repeat the grid distance). Without B, capacity and mix keep their 80/20 split.`,
    notes: [
      "Nameplate capacity is not available or uncommitted electricity: nearby generation does not establish deliverable capacity.",
      `Full capacity marks need ${GENERATION_LOAD_MULTIPLE} × the load in nameplate, since solar and wind deliver a fraction of nameplate and nearby plants already serve other loads.`,
      "Clean-build similarity says how much nearby land resembles where solar, wind and batteries were built. It is not a feasibility, land or permitting finding.",
    ],
  });
}

/** C from the estimated population within 10 km (community exposure proxy). */
export function scoreCommunity(population: number | null, reason?: string): ComponentResult {
  const n = validNonNegative(population);
  const invalid = population !== null && n === null;
  const missingFields = n === null ? [withReason(`Estimated population within ${POPULATION_RADIUS_KM} km`, invalid ? "invalid value" : reason)] : [];
  const metrics = [
    metric("population", `Community exposure proxy (people within ${POPULATION_RADIUS_KM} km)`, 1, n === null ? null : communityScore(n), n === null ? "Not available" : `≈ ${fmtPeople(n)} people`),
  ];
  return component("community", {
    metrics,
    missingFields,
    explain: (score, status) =>
      status === "unavailable"
        ? withReason("No population estimate, so this component uses a neutral 50 (not zero people)", invalid ? "invalid value" : reason) + "."
        : `About ${fmtPeople(n as number)} people live within ${POPULATION_RADIUS_KM} km (→ ${fmtScore(score)}). More nearby residents lower this proxy on a log scale, so very large differences don't dominate the total.`,
    method: `C = 100 × max(0, 1 − ln(1 + N) / ln(${en(POPULATION_SCALE + 1)})), N = estimated population within ${POPULATION_RADIUS_KM} km (2020 Census block groups).`,
    notes: [
      "An exposure proxy only: it does not measure community consent, environmental justice, demographic vulnerability, water stress, noise, or how benefits and burdens are shared.",
      "Fewer residents does not mean a better community or no community impact, and the score is no substitute for engagement.",
    ],
  });
}

/** A = the lowest score across the site's EPA nonattainment designations (100 when none are listed). */
export function scoreAirPermitting(designations: Designation[] | null, aqi: AqiContext | null, reason?: string): ComponentResult {
  const missingFields: string[] = [];
  const context: Fact[] = [];
  let score: number | null = null;
  let value = "Not available";
  let partial = false;
  let worst: string | null = null;

  if (designations) {
    if (!designations.length) {
      score = ATTAINMENT_SCORE;
      value = "No listed nonattainment";
    } else {
      const scored = designations.map((d) => {
        const s = designationScore(d.classification);
        const label = d.naaqs ?? d.pollutant ?? "Unnamed standard";
        if (s === null) {
          partial = true;
          missingFields.push(`Classification of the ${label} nonattainment area (scored as a neutral ${NEUTRAL_SCORE})`);
        }
        return { label: `${label} (${d.classification ?? "classification unknown"})`, score: s ?? NEUTRAL_SCORE };
      });
      const lowest = scored.reduce((a, b) => (b.score < a.score ? b : a));
      score = lowest.score;
      worst = lowest.label;
      value = scored.map((d) => d.label).join("; ");
      const area = designations.find((d) => d.area)?.area;
      if (area) context.push({ label: "Nonattainment area", value: area });
    }
  } else missingFields.push(withReason("EPA nonattainment designations", reason));

  const aqiValue = validNonNegative(aqi?.aqi);
  if (aqiValue !== null) {
    context.push({ label: "Current AQI (context, not scored)", value: `${Math.round(aqiValue)}${aqi?.category ? ` ${aqi.category}` : ""}${aqi?.pollutant ? ` · ${aqi.pollutant}` : ""}` });
  }

  const metrics = [metric("designation", "Lowest-scoring EPA designation", 1, score, value)];
  return component("air", {
    metrics,
    missingFields,
    context,
    partial,
    explain: (s, status) => {
      if (status === "unavailable") return withReason("No EPA designation data, so this component uses a neutral 50 (not attainment)", reason) + ".";
      if (!worst) return "No ozone or PM2.5 nonattainment area is listed at this site (→ 100).";
      const n = designations?.length ?? 0;
      return `${n > 1 ? `${n} designations; the lowest-scoring is` : "Designated"} ${worst} (→ ${fmtScore(s)}). Multiple designations count once, at the lowest score.`;
    },
    method:
      "A = lowest score across designations: attainment / none listed 100, Marginal 70, Moderate 50, Serious 30, Severe or Extreme 10 (EPA Green Book, ozone and PM2.5). Current AQI is shown for context only.",
    notes: [
      "Nonattainment can add permitting steps, especially for new combustion sources such as gas turbines or diesel backup generators, but does not by itself prohibit a data center.",
      "A current AQI snapshot says nothing about regulatory attainment, so it never changes this score.",
      "Not legal or regulatory advice.",
    ],
  });
}

/** I from the utility territory and balancing authority: both 100, one 60, neither 20. */
export function scoreInfrastructure(utility: Lookup, balancingAuthority: Lookup, outsideCoverage: boolean, reason?: string): ComponentResult {
  const missingFields: string[] = [];
  const side = (id: string, what: string, l: Lookup): MetricResult => {
    if (l.status === "unknown") {
      missingFields.push(withReason(what, reason));
      return metric(id, what, 0.5, null, "Could not be determined");
    }
    if (l.status === "identified") return metric(id, what, 0.5, IDENTIFIED_SCORE, l.name);
    return metric(id, what, 0.5, NOT_IDENTIFIED_SCORE, outsideCoverage ? "None: outside California coverage" : "None identified");
  };
  const metrics = [side("utility", "Utility service territory", utility), side("ba", "Balancing authority", balancingAuthority)];
  return component("infrastructure", {
    metrics,
    missingFields,
    explain: (score, status) => {
      if (status === "unavailable") return withReason("Territory data could not be read, so this component uses a neutral 50 (not 20)", reason) + ".";
      const found = metrics.filter((m) => m.score === IDENTIFIED_SCORE).length;
      const known = metrics.filter((m) => m.state === "observed").length;
      if (known < 2) return `Only one lookup could run (${found ? "identified" : "none found"}), so it carries the full weight (→ ${fmtScore(score)}).`;
      const what = found === 2 ? "Both utility and balancing authority are identified" : found === 1 ? "One of utility and balancing authority is identified" : outsideCoverage ? "Outside the supported California coverage" : "Neither utility nor balancing authority is identified";
      return `${what} (→ ${fmtScore(score)}).`;
    },
    method: "I = mean of utility and balancing authority, each 100 when identified and 20 when not (both 100, one 60, neither 20). A lookup that could not run drops out; neither → neutral 50.",
    notes: ["An identified service territory is administrative context, not available electrical capacity."],
  });
}

// ---------------------------------------------------------------------------
// Overall score
// ---------------------------------------------------------------------------

/** Model signals from a cell farther than 5 km describe somewhere else: treat them as missing. */
function usableMl(input: FeasibilityInput): MlSignals | null {
  const ml = input.ml ?? null;
  const km = validNonNegative(ml?.cellKm);
  return ml && km !== null && km <= ML_MAX_CELL_KM && !input.outsideCoverage ? ml : null;
}

/** Both 220 kV+ distances known and beyond reach: no community or air score may lift the grade past the cap. */
export function mustHaveCap(grid: ComponentResult): GradeCap | null {
  const dist = grid.metrics.filter((m) => m.id === "substation" || m.id === "line");
  if (dist.some((m) => m.state !== "observed" || m.score === null) || dist.some((m) => (m.score as number) > 0)) return null;
  return { limit: MUST_HAVE_CAP, reason: `No ${HV_KV} kV+ substation or line within ${GRID_REACH_KM} km` };
}

export function calculateFeasibilityScore(input: FeasibilityInput, targetLoadMW: number = DEFAULT_LOAD_MW): FeasibilityResult {
  const loadValid = validPositive(targetLoadMW) !== null;
  const load = loadValid ? targetLoadMW : DEFAULT_LOAD_MW;
  const why = input.reasons ?? {};
  const ml = usableMl(input);
  const mlReason = ml ? undefined : input.ml ? `nearest model cell is over ${ML_MAX_CELL_KM} km away` : (input.mlReason ?? "model signals unavailable");
  const components = [
    scoreGridProximity(input.substation, input.line, why.grid, ml, load, mlReason),
    scoreGeneration(input.generation, load, why.generation, ml, mlReason),
    scoreCommunity(input.population, why.community),
    scoreAirPermitting(input.designations, input.aqi, why.air),
    scoreInfrastructure(input.utility, input.balancingAuthority, input.outsideCoverage, why.infrastructure),
  ];
  const byKey = <T>(f: (c: ComponentResult) => T) => Object.fromEntries(components.map((c) => [c.key, f(c)])) as Record<ComponentKey, T>;

  const pointsTotal = clamp(components.reduce((a, c) => a + c.weightedContribution, 0));
  const limit = mustHaveCap(components[0]);
  const cap = limit && pointsTotal > limit.limit ? limit : null;
  const raw = cap ? cap.limit : pointsTotal;
  const overallScore = Math.round(raw * 10) / 10;
  const share = (status: ComponentStatus) => Math.round(1000 * components.filter((c) => c.status === status).reduce((a, c) => a + c.weight, 0)) / 10;
  const completeness = share("observed");
  const label = completenessLabelFor(completeness);
  const placeholders = components.filter((c) => c.status !== "observed").length;

  let qualification: string | null = null;
  if (label !== "High") {
    qualification = `${label} data completeness (${completeness}%): ${placeholders} of ${components.length} components use a neutral 50 or partial data.`;
    if (label === "Low") qualification += ` Treat this score as provisional${overallScore >= 60 ? ": a favorable score resting on this little data is not reliable" : ""}.`;
  }

  const considerations = considerationsFor(input, components, ml, mlReason, cap);
  const explanatoryNotes = [
    "Preliminary screening heuristic: the weights and thresholds are initial product assumptions, not validated predictions of interconnection approval, cost, permitting, construction feasibility or economic viability.",
    `Assumed average data center load: ${fmtMw(load)}${loadValid ? "" : ` (the configured load was invalid, so the ${DEFAULT_LOAD_MW} MW default is used)`}. Only the nearby-generation capacity term and the regional demand pressure (context) depend on it.`,
    `Must-have: when both the nearest ${HV_KV} kV+ substation and line are more than ${GRID_REACH_KM} km away, the grade is capped at ${MUST_HAVE_CAP}, so high community or air scores can't offset a site without grid access.`,
    "Land is not scored: slope, land cover, zoning, parcels and flood risk need their own review (see Site intelligence for land screening).",
    "Missing inputs never count as 0 km, 0 people or 0 MW: a missing metric drops out of its component and the others are reweighted; a component with no data scores a neutral 50.",
    `Model signals (county interconnection queue, clean-build similarity, demand forecast) come from the nearest 5 km cell of Griddy's site-location artifact, within ${ML_MAX_CELL_KM} km. They supplement the rules: when missing they drop out and don't change data completeness, and they never stand in for a component's own data. EPA nonattainment and grid distances are not taken from the model cells, so nothing is counted twice.`,
    "Data completeness is the share of the score's weight that comes from fully observed components. It measures data coverage, not statistical confidence or the probability of success.",
    "Use it to guide further investigation. It does not replace utility interconnection studies, site engineering, permitting review or community engagement.",
  ];

  return {
    overallScore,
    overallScoreRaw: raw,
    pointsTotal,
    cap,
    category: categoryFor(overallScore),
    targetLoadMw: load,
    dataCompletenessPercent: completeness,
    partialPercent: share("partial"),
    completenessLabel: label,
    components,
    componentScores: byKey((c) => c.score),
    weightedContributions: byKey((c) => c.weightedContribution),
    componentStatuses: byKey((c) => c.status),
    missingFields: components.flatMap((c) => c.missingFields.map((f) => `${c.label}: ${f}`)),
    considerations,
    seriousConstraints: considerations.filter((c) => c.tone === "constraint").map((c) => c.text),
    qualification,
    explanatoryNotes,
  };
}

/** Key considerations: infrastructure advantages apart from community and environmental tradeoffs. */
function considerationsFor(input: FeasibilityInput, components: ComponentResult[], ml: MlSignals | null, mlReason: string | undefined, gradeCap: GradeCap | null): Consideration[] {
  const out: Consideration[] = [];
  const get = (k: ComponentKey) => components.find((c) => c.key === k) as ComponentResult;
  const add = (group: ConsiderationGroup, tone: ConsiderationTone, text: string) => out.push({ group, tone, text });

  const grid = get("grid");
  for (const m of grid.metrics.filter((x) => x.id === "substation" || x.id === "line")) {
    const what = m.label.replace("Nearest ", "");
    if (m.state !== "observed" || m.score === null) {
      add("infrastructure", "missing", `Nearest ${what}: not available`);
      continue;
    }
    const km = validNonNegative((m.id === "substation" ? input.substation : input.line)?.distanceKm) as number;
    const tone: ConsiderationTone = km >= GRID_ZERO_KM ? "constraint" : km > 10 ? "tradeoff" : km <= 5 ? "advantage" : "neutral";
    add("infrastructure", tone, `Nearest ${what}: ${m.value}${km >= GRID_ZERO_KM ? `, ${GRID_ZERO_KM} km or more away` : ""}`);
  }
  if (gradeCap) add("infrastructure", "constraint", `GriddyGrade capped at ${gradeCap.limit}: ${gradeCap.reason.charAt(0).toLowerCase()}${gradeCap.reason.slice(1)}, a must-have for a data center load`);
  const queue = grid.metrics.find((m) => m.id === "queue");
  const q = validNonNegative(ml?.queueMw);
  if (queue?.state === "observed" && q !== null) {
    add(
      "infrastructure",
      q >= QUEUE_HIGH_MW ? "tradeoff" : q < 1000 ? "advantage" : "neutral",
      q >= QUEUE_HIGH_MW
        ? `Congested interconnection queue: ${queue.value} (LBNL). Expect long study timelines; needs a utility interconnection study`
        : `Interconnection queue: ${queue.value} (LBNL)`,
    );
  }

  const gen = get("generation");
  const cap = gen.metrics[0];
  if (cap.state === "observed" && cap.score !== null) {
    const plants = validNonNegative(input.generation?.plantCount);
    const text = `${cap.value.split(" vs ")[0]} operating nameplate generation within ${GENERATION_RADIUS_KM} km${plants !== null ? ` (${en(plants)} plant${plants === 1 ? "" : "s"})` : ""}`;
    add("infrastructure", cap.score >= 100 ? "advantage" : cap.score === 0 ? "tradeoff" : "neutral", cap.score === 0 ? `No operating generation within ${GENERATION_RADIUS_KM} km` : text);
  } else add("infrastructure", "missing", `Operating generation within ${GENERATION_RADIUS_KM} km: not available`);
  const clean = gen.metrics.find((m) => m.id === "clean_build");
  if (clean?.state === "observed" && clean.score !== null) {
    const tone: ConsiderationTone = clean.score >= 80 ? "advantage" : clean.score < 20 ? "tradeoff" : "neutral";
    add("infrastructure", tone, `Clean-build similarity within ${CLEAN_BUILD_RADIUS_KM} km: ${clean.value.split(" (")[0]} (${ML_TAG}; resembles where plants were built, not a feasibility finding)`);
  }

  const infra = get("infrastructure");
  const names = infra.metrics.map((m) => `${m.label}: ${m.value}`).join(" · ");
  add("infrastructure", infra.status === "unavailable" ? "missing" : infra.score >= 100 ? "neutral" : "tradeoff", names);

  const community = get("community");
  const pop = validNonNegative(input.population);
  if (pop !== null) {
    add("community", community.score < 25 ? "tradeoff" : "neutral", `≈ ${fmtPeople(pop)} people within ${POPULATION_RADIUS_KM} km (Census estimate)${community.score < 25 ? ": plan early, substantive community engagement" : ""}`);
  } else add("community", "missing", `Population within ${POPULATION_RADIUS_KM} km: not available`);

  const air = get("air");
  if (air.status === "unavailable") add("community", "missing", "EPA nonattainment status: not available");
  else if (input.designations && input.designations.length) {
    add("community", air.score <= 30 ? "constraint" : "tradeoff", `EPA nonattainment: ${air.metrics[0].value}`);
  } else add("community", "neutral", "No listed ozone or PM2.5 nonattainment (EPA Green Book)");


  for (const c of components) {
    const own = c.missingFields.filter((f) => !f.includes("(model signal)"));
    if (c.status === "unavailable") add("data", "missing", `${c.label}: no data, scored as a neutral ${NEUTRAL_SCORE}`);
    else if (c.status === "partial") add("data", "missing", `${c.label}: partial data (${own.join("; ")})`);
  }
  if (!ml) add("data", "missing", `Model signals (interconnection queue, clean-build similarity, demand forecast): not available${mlReason ? ` (${mlReason})` : ""}; the grade uses the rules alone`);
  add(
    "data",
    "caveat",
    "Actual grid capacity has not been verified. Distances and nearby generation do not show spare capacity; serving a data center load needs a utility interconnection / large-load study.",
  );
  return out;
}
