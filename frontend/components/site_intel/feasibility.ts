// Power plant site feasibility: a preliminary 0-100 screening score for a proposed generation
// project (technology + nameplate MW) at the selected site.  OWNER: workstream E (Site Intelligence).
//
// Pure and deterministic: no React, no fetching and only `import type`, so Node runs this file
// as-is in the tests (feasibility.test.mjs). Layers: feasibilityInput.ts adapts A's site summary
// and E's site intel into SiteData; feasibilityPolicy.ts holds the versioned numbers; this file
// is the math; GriddyGradeCard.tsx / GriddyGradeDetails.tsx render it as the GriddyGrade, led by
// its percentile among plausible California sites (percentile.ts, gradePercentiles.json).
//
//   S = 0.30 G + 0.30 R + 0.20 E + 0.15 C + 0.05 I          (each component 0-100)
//
// G grid interconnection proximity, R technology-specific resource and operating prerequisites,
// E environmental and permitting screening, C community exposure proxy, I administrative context.
// The overall weights never move: a component with no data scores a neutral 50 and lowers data
// completeness; inside a component, missing metrics drop out and the rest are reweighted. Missing
// data never becomes 0 km, 0 people, attainment or favorable resource evidence. Land suitability is
// excluded from both the score and data completeness. Critical constraints are assessed apart from
// the score, so a high weighted score can't average them away.
import type {
  ComponentKey,
  CoolingConfig,
  GenerationTechnology,
  InputMethod,
  ResourceInputKey,
  ScoringPolicy,
  SourceState,
  SubmetricSpec,
  TechnologySpec,
  VoltageTier,
} from "./feasibilityPolicy";

export type ComponentStatus = "observed" | "partial" | "unavailable";
export type CompletenessLabel = "High" | "Moderate" | "Low";
export type ConstraintAssessment = "identified" | "none_identified_in_available_data" | "not_assessed";

export const COMPONENT_KEYS: ComponentKey[] = ["grid", "resource", "environment", "community", "administrative"];

export const COMPONENT_LABEL: Record<ComponentKey, string> = {
  grid: "Grid interconnection proximity",
  resource: "Resource and operating prerequisites",
  environment: "Environmental and permitting screening",
  community: "Community exposure proxy",
  administrative: "Administrative and infrastructure context",
};

const SYMBOL: Record<ComponentKey, string> = { grid: "G", resource: "R", environment: "E", community: "C", administrative: "I" };

/** "0.30 G + 0.30 R + ...", built from the policy so the displayed formula always matches the math. */
export function formulaFor(policy: ScoringPolicy): string {
  return COMPONENT_KEYS.map((k) => `${policy.weights[k].toFixed(2)} ${SYMBOL[k]}`).join(" + ");
}

export const LAND_DISCLOSURE =
  "Land suitability is not assessed and is excluded from this score. Parcel availability, ownership, zoning, usable area, terrain, and site-specific constructability require separate investigation.";
export const LAND_NOT_CLEARED = "Removing land from the score does not establish that land conditions are acceptable.";
export const COMPLETENESS_SCOPE =
  "Data completeness measures coverage of the five scored components only. It does not include land suitability or indicate that development due diligence is complete.";
export const CRITICAL_HEADLINE = "Critical constraint identified — the weighted score does not override this finding.";
export const NOT_FULLY_ASSESSED = "Critical constraints not fully assessed.";
export const LIMITED_EVIDENCE = "Limited evidence — score relies on missing-data assumptions.";
export const GRID_NOT_VERIFIED = "Actual grid export capacity has not been verified.";
export const PRELIMINARY =
  "Preliminary screening heuristic. Results reflect available data and stated assumptions—not verified construction feasibility, interconnection capability, permitting eligibility, or economic viability. Land suitability is not assessed.";
export const NOT_A_SUBSTITUTE = [
  "interconnection and transmission studies",
  "resource measurement campaigns",
  "reservoir and hydrologic investigations",
  "fuel and water agreements",
  "parcel, title, zoning, terrain and geotechnical review",
  "environmental and cultural-resource surveys",
  "engineering design",
  "permitting advice",
  "community and Tribal engagement",
  "financial feasibility and revenue modeling",
];

// ---------------------------------------------------------------------------
// Project scenario
// ---------------------------------------------------------------------------

export interface ProjectScenario {
  technology: GenerationTechnology;
  /** Proposed nameplate capacity of the generation, MW (finite, > 0). */
  capacityMw: number;
  /** Thermal technologies only. "dry" removes the cooling-water prerequisite, not all water demand. */
  cooling?: CoolingConfig;
  /** Co-located storage, MW: shown separately, never counted as generation and never scored. */
  storageMw?: number | null;
}

/** Unvalidated project settings, e.g. straight from form fields. */
export interface ProjectInput {
  technology?: unknown;
  capacityMw?: unknown;
  cooling?: unknown;
  storageMw?: unknown;
}

export type ProjectValidation = { ok: true; project: ProjectScenario } | { ok: false; errors: string[] };

const COOLING: CoolingConfig[] = ["not_specified", "wet", "dry"];
const STORAGE_ONLY = ["battery", "storage", "battery_storage"];

/** Checks a project configuration. Invalid settings are reported, never replaced by a default. */
export function validateProject(input: ProjectInput, policy: ScoringPolicy): ProjectValidation {
  const errors: string[] = [];
  const tech = typeof input.technology === "string" ? input.technology : "";
  const spec = Object.hasOwn(policy.technologies, tech) ? policy.technologies[tech as GenerationTechnology] : null;
  if (!spec) {
    errors.push(
      STORAGE_ONLY.includes(tech)
        ? "Battery storage is not primary generation, so a storage-only project is not scored by this model."
        : `Choose a generation technology (${Object.values(policy.technologies)
            .map((t) => t.label)
            .join(", ")}).`,
    );
  }
  const mw = input.capacityMw;
  if (typeof mw !== "number" || !Number.isFinite(mw) || mw <= 0) errors.push("Proposed nameplate capacity must be a finite number of MW greater than 0.");
  const cooling = input.cooling ?? "not_specified";
  if (!COOLING.includes(cooling as CoolingConfig)) errors.push("Cooling must be not specified, wet or dry.");
  const storage = input.storageMw ?? null;
  if (storage !== null && (typeof storage !== "number" || !Number.isFinite(storage) || storage < 0)) errors.push("Co-located storage must be 0 MW or more, or left empty.");
  if (errors.length || !spec) return { ok: false, errors };
  return {
    ok: true,
    project: { technology: tech as GenerationTechnology, capacityMw: mw as number, cooling: spec.thermal ? (cooling as CoolingConfig) : "not_specified", storageMw: storage as number | null },
  };
}

// ---------------------------------------------------------------------------
// Site data: every input carries how its dataset answered (null never means zero)
// ---------------------------------------------------------------------------

export interface Observation<T> {
  state: SourceState;
  value: T | null;
  /** Why it is missing, or a short coverage note. */
  reason?: string;
}

export interface GridAsset {
  name: string | null;
  voltageKv: number | null;
  distanceKm: number | null;
  /** Operating status established (a CEC "Operational" line; a substation OSM maps as existing). */
  operatingEstablished: boolean;
  /** A substation with no voltage tag lies closer, km: it can't qualify, but say so. */
  closerUntaggedKm?: number | null;
}

export interface GridAssetObservation extends Observation<GridAsset> {
  /** For confirmed_absent: the radius the search covered, km. */
  searchedKm?: number;
}

export interface GridTierInput {
  substation: GridAssetObservation;
  line: GridAssetObservation;
}

export interface ResourceObservation {
  state: SourceState;
  /** A number for continuous metrics, the source's label for a classification. */
  value: number | string | null;
  unit: string;
  heightM?: number;
  /** Spatial resolution of the source grid, km. */
  gridKm?: number;
  period?: string;
  kind: "observed" | "inferred" | "simulated";
  source: string;
  detail?: string;
  reason?: string;
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

/** An existing, documented environmental screening method for E_other (Griddy has none yet). */
export interface EnvironmentalScreen {
  score: number;
  method: string;
  source: string;
  technologies: GenerationTechnology[] | "all";
}

export interface QueueContext {
  county: string | null;
  activeMw: number | null;
  activeProjects: number | null;
  asOf: string | null;
}

export interface SiteData {
  location: { lon: number; lat: number } | null;
  /** Inside California data coverage: true, false (confirmed outside) or null (unknown). */
  inCoverage: boolean | null;
  /** Nearest qualifying assets per voltage threshold (kV). */
  grid: Partial<Record<number, GridTierInput>>;
  /** Technology-independent resource and prerequisite inputs. Absent: Griddy does not expose it. */
  resource: Partial<Record<ResourceInputKey, ResourceObservation>>;
  /** Siting similarity by model kind (solar_pv, onshore_wind, gas_cc, battery). */
  sitingSimilarity: Partial<Record<string, ResourceObservation>>;
  /** Estimated population within the policy radius (10 km). */
  population: Observation<number>;
  /** EPA nonattainment designations at the site; [] within coverage = none listed. */
  designations: Observation<Designation[]>;
  environmentalScreen: Observation<EnvironmentalScreen>;
  /** Current AQI: context only, never scored. */
  aqi: AqiContext | null;
  utility: Observation<string>;
  balancingAuthority: Observation<string>;
  /** Share (0-1) of the 2 km screening buffer overlapping a protected area. */
  protectedShare: Observation<number>;
  /** County interconnection queue (context only). */
  queue: Observation<QueueContext>;
  /** Operating nameplate MW within 25 km by fuel (context only, never resource evidence). */
  nearbyFuelMw: Observation<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface MetricSource {
  kind: "observed" | "inferred" | "simulated" | "assumption";
  /** Short label shown beside the metric, e.g. "inferred (ML)". */
  tag: string;
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
  /** The method that produced the score (or that would have). */
  method?: string;
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
  /** 0-100; the policy's neutral score when unavailable. */
  score: number;
  status: ComponentStatus;
  /** score x weight, in overall score points. */
  weightedContribution: number;
  /** The selected scoring method, in words. */
  method: string;
  metrics: MetricResult[];
  /** Inputs shown for context that do not change the score. */
  context: Fact[];
  missingFields: string[];
  assumptions: string[];
  explanation: string;
  notes: string[];
  /** Names of the datasets and models behind it. */
  sources: string[];
}

export type FindingBasis = "documented_prohibition" | "screening_concern";

export interface ConstraintFinding {
  checkId: string;
  type: string;
  title: string;
  evidence: string;
  source: string;
  url?: string;
  date?: string;
  technologies: GenerationTechnology[] | "all";
  basis: FindingBasis;
}

export interface ConstraintCheckResult {
  id: string;
  label: string;
  tier: "critical" | "screening";
  status: ConstraintAssessment;
  detail: string;
}

export interface ConstraintsResult {
  assessment: ConstraintAssessment;
  /** What to say about the assessment; never "no constraints". */
  summary: string;
  checks: ConstraintCheckResult[];
  critical: ConstraintFinding[];
  screening: ConstraintFinding[];
}

export type ConsiderationGroup = "grid" | "resource" | "environment" | "community" | "constraints" | "data";
export type ConsiderationTone = "advantage" | "neutral" | "tradeoff" | "constraint" | "missing" | "caveat";

export interface Consideration {
  group: ConsiderationGroup;
  tone: ConsiderationTone;
  text: string;
}

export interface Notice {
  tone: "constraint" | "warning" | "info";
  text: string;
}

export interface Exclusion {
  id: string;
  label: string;
  text: string;
}

export interface FeasibilityResult {
  valid: true;
  policyVersion: string;
  project: ProjectScenario;
  technologyLabel: string;
  /** The label as it reads mid-sentence ("solar PV", "onshore wind"). */
  technologyNoun: string;
  /** The voltage search tier for the project size. */
  voltageTier: VoltageTier;
  /** Clamped to 0-100, unrounded. */
  overallScoreRaw: number;
  /** The displayed score: overallScoreRaw rounded to the nearest integer. */
  overallScore: number;
  /** Sum of the weighted contributions (equals overallScoreRaw: every component is 0-100). */
  pointsTotal: number;
  /** From the displayed integer score. */
  category: string;
  /** The category, unless a critical constraint replaces it. */
  headline: string;
  /** 100 x the weight of fully observed components, unrounded. Not a probability of success. */
  dataCompletenessPercent: number;
  completenessLabel: CompletenessLabel;
  components: ComponentResult[];
  componentScores: Record<ComponentKey, number>;
  weightedContributions: Record<ComponentKey, number>;
  componentStatuses: Record<ComponentKey, ComponentStatus>;
  missingFields: string[];
  constraints: ConstraintsResult;
  considerations: Consideration[];
  /** Headline-level flags, most serious first. */
  notices: Notice[];
  explanatoryNotes: string[];
  exclusions: Exclusion[];
  /** Some input is still loading: the score may change. */
  provisional: boolean;
}

export interface InvalidProjectResult {
  valid: false;
  policyVersion: string;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));

/** A finite number >= 0, else null: negative, NaN, Infinity and non-numbers are invalid, never 0. */
export function validNonNegative(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

const en = (v: number) => v.toLocaleString("en-US");
const fmtKm = (v: number) => (v < 10 ? `${v.toFixed(1)} km` : `${en(Math.round(v))} km`);
export const fmtMw = (v: number) => (v >= 100 ? `${en(Math.round(v))} MW` : v >= 10 ? `${v.toFixed(0)} MW` : `${Number(v.toFixed(1))} MW`);
const fmtKv = (v: number | null) => (v !== null && v > 0 ? `${Math.round(v)} kV` : "voltage not tagged");
const fmtPeople = (n: number) => en(n >= 1000 ? Math.round(n / 100) * 100 : Math.round(n));
const fmtPct = (share: number) => `${Math.round(share * 100)}%`;
const fmtScore = (v: number) => String(Math.round(v));
const prettyUnit = (u: string) => u.replace("m2", "m²");
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const withReason = (what: string, reason: string | undefined) => (reason ? `${what} (${reason})` : what);
const listText = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** Why an observation has no usable value, in words, by its state. */
function stateReason(o: { state: SourceState; reason?: string } | undefined, fallback = "data unavailable"): string {
  if (!o) return fallback;
  if (o.reason) return o.reason;
  switch (o.state) {
    case "loading":
      return "still loading";
    case "error":
      return "lookup failed";
    case "outside_coverage":
      return "outside California data coverage";
    case "confirmed_absent":
      return "none found";
    case "unavailable":
      return fallback;
    default:
      return "no value";
  }
}

/** D(d) = 100 x max(0, 1 - d / zeroKm), d = straight-line km. */
export function distanceScore(km: number, zeroKm: number): number {
  return 100 * Math.max(0, 1 - km / zeroKm);
}

/** C = 100 x max(0, 1 - ln(1 + N) / ln(scale + 1)). */
export function communityScore(population: number, scale: number): number {
  return clamp(100 * Math.max(0, 1 - Math.log1p(population) / Math.log1p(scale)));
}

/** Score for one EPA classification (first word, so "Severe 15" matches), or null when unrecognized. */
export function designationScore(classification: string | null, policy: ScoringPolicy): number | null {
  const word = (classification ?? "").trim().toLowerCase().match(/^[a-z]+/)?.[0];
  return word && Object.hasOwn(policy.environment.designationScores, word) ? policy.environment.designationScores[word] : null;
}

export function categoryFor(displayScore: number, policy: ScoringPolicy): string {
  const cats = policy.categories;
  return (cats.find((c) => displayScore >= c.min) ?? cats[cats.length - 1]).label;
}

export function completenessLabelFor(percent: number, policy: ScoringPolicy): CompletenessLabel {
  return percent >= policy.completeness.high ? "High" : percent >= policy.completeness.moderate ? "Moderate" : "Low";
}

/** The voltage search tier for a project size: the first tier whose maxMw covers it. */
export function voltageTierFor(capacityMw: number, policy: ScoringPolicy): VoltageTier {
  const tiers = policy.grid.tiers;
  return tiers.find((t) => capacityMw <= t.maxMw) ?? tiers[tiers.length - 1];
}

export function tierLabel(tier: VoltageTier, policy: ScoringPolicy): string {
  const i = policy.grid.tiers.indexOf(tier);
  const lo = i > 0 ? policy.grid.tiers[i - 1].maxMw : 0;
  const size = Number.isFinite(tier.maxMw) ? (lo > 0 ? `over ${lo} through ${tier.maxMw} MW` : `up to ${tier.maxMw} MW`) : `over ${lo} MW`;
  return `≥ ${tier.minKv} kV for projects ${size}`;
}

/** Method 1 (continuous) or Method 2 (classification) for one input, or why it can't be scored. */
export function scoreInput(m: InputMethod, obs: ResourceObservation): { score: number } | { reason: string } {
  if (m.kind === "classification") {
    const label = typeof obs.value === "string" ? obs.value.trim().toLowerCase() : null;
    const s = label !== null && m.classes && Object.hasOwn(m.classes, label) ? m.classes[label] : undefined;
    if (s === undefined || !Number.isFinite(s)) return { reason: `the classification "${String(obs.value)}" has no documented mapping, so it is not scored (and not treated as unsuitable)` };
    return { score: clamp(s) };
  }
  const ref = m.reference;
  if (!ref) return { reason: "no reference range is validated for it in this policy version" };
  if (!Number.isFinite(ref.low) || !Number.isFinite(ref.high) || !(ref.high > ref.low)) return { reason: "the policy's reference bounds are invalid" };
  const incompatible = [
    obs.unit !== ref.unit ? `its unit (${prettyUnit(obs.unit)}) does not match the reference range's (${prettyUnit(ref.unit)})` : null,
    ref.heightM !== undefined && obs.heightM !== ref.heightM ? `it is measured at ${obs.heightM !== undefined ? `${obs.heightM} m` : "an unstated height"}, the reference range at ${ref.heightM} m` : null,
    ref.maxGridKm !== undefined && !(typeof obs.gridKm === "number" && obs.gridKm <= ref.maxGridKm)
      ? `its ${obs.gridKm !== undefined ? `~${obs.gridKm} km` : "unstated"} grid is coarser than the ${ref.maxGridKm} km the reference range needs`
      : null,
  ].filter((r): r is string => r !== null);
  if (incompatible.length) return { reason: listText(incompatible) };
  const x = validNonNegative(obs.value);
  if (x === null) return { reason: "its value is invalid (negative, NaN or infinite)" };
  return { score: 100 * clamp((x - ref.low) / (ref.high - ref.low), 0, 1) };
}

function fmtObservation(o: ResourceObservation): string {
  const v = typeof o.value === "number" ? (Math.abs(o.value) < 10 ? o.value.toFixed(2) : en(Math.round(o.value))) : String(o.value);
  const basis = [o.heightM !== undefined ? `at ${o.heightM} m` : null, o.period ? `${o.period} mean` : null, o.gridKm !== undefined ? `~${o.gridKm} km grid` : null].filter(Boolean);
  return `${v} ${prettyUnit(o.unit)}${basis.length ? ` (${basis.join(", ")})` : ""}`;
}

function metric(id: string, label: string, weight: number, score: number | null, value: string, state?: MetricResult["state"]): MetricResult {
  return { id, label, weight, effectiveWeight: 0, state: state ?? (score === null ? "missing" : "observed"), score: score === null ? null : clamp(score), value };
}

/** Weighted mean of the observed metrics, weights renormalized; null when none is observed. */
function renormalized(metrics: MetricResult[]): { mean: number | null; metrics: MetricResult[] } {
  const scored = metrics.filter((m) => m.state === "observed" && m.score !== null);
  const total = scored.reduce((a, m) => a + m.weight, 0);
  const mean = total > 0 ? scored.reduce((a, m) => a + m.weight * (m.score as number), 0) / total : null;
  return { mean, metrics: metrics.map((m) => ({ ...m, effectiveWeight: m.state === "observed" && m.score !== null && total > 0 ? m.weight / total : 0 })) };
}

interface Parts {
  score: number | null;
  status: ComponentStatus;
  method: string;
  metrics: MetricResult[];
  context?: Fact[];
  missingFields: string[];
  assumptions: string[];
  explanation: string;
  notes: string[];
  sources: string[];
}

function component(key: ComponentKey, policy: ScoringPolicy, p: Parts): ComponentResult {
  const score = p.score === null || p.status === "unavailable" ? policy.neutralScore : clamp(p.score);
  const weight = policy.weights[key];
  return {
    key,
    label: COMPONENT_LABEL[key],
    weight,
    score,
    status: p.score === null ? "unavailable" : p.status,
    weightedContribution: score * weight,
    method: p.method,
    metrics: p.metrics,
    context: p.context ?? [],
    missingFields: p.missingFields,
    assumptions: p.assumptions,
    explanation: p.explanation,
    notes: p.notes,
    sources: p.sources,
  };
}

// ---------------------------------------------------------------------------
// G: grid interconnection proximity
// ---------------------------------------------------------------------------

/** G = 0.60 D(substation km) + 0.40 D(line km), nearest qualifying assets at the project's voltage threshold. */
export function scoreGrid(site: SiteData, project: ProjectScenario, policy: ScoringPolicy): ComponentResult {
  const g = policy.grid;
  const tier = voltageTierFor(project.capacityMw, policy);
  const input = site.grid[tier.minKv];
  const missingFields: string[] = [];
  const context: Fact[] = [{ label: "Active voltage-search threshold", value: tierLabel(tier, policy) }];

  const side = (id: "substation" | "line", weight: number): MetricResult => {
    const what = id === "substation" ? `${tier.minKv} kV+ substation` : `${tier.minKv} kV+ operational AC line`;
    const label = `Nearest qualifying ${what}`;
    const miss = (reason: string) => {
      missingFields.push(`Distance to the nearest ${what} (${reason})`);
      return { ...metric(id, label, weight, null, "Not available"), method: "straight-line km to the nearest qualifying asset" };
    };
    if (site.inCoverage === false) return miss("outside California data coverage: out-of-state assets are not mapped");
    const obs = input?.[id];
    if (!obs) return miss(`no ${tier.minKv} kV search result`);
    if (obs.state === "confirmed_absent") {
      // Only a search that covered the whole scoring range, inside coverage, supports a 0.
      if (site.inCoverage === true && (obs.searchedKm ?? 0) >= g.minAbsentSearchKm) {
        const radius = Number.isFinite(obs.searchedKm) ? `within ${en(obs.searchedKm as number)} km` : "in the California layer";
        return { ...metric(id, label, weight, 0, `None mapped ${radius} (scores 0; no nearest distance is invented)`), method: "confirmed absence over the scoring range" };
      }
      return miss(`none found, but the search did not cover ${g.minAbsentSearchKm} km inside known coverage`);
    }
    if (obs.state !== "available" || !obs.value) return miss(stateReason(obs));
    const a = obs.value;
    if (a.voltageKv === null) return miss("its voltage can't be established, so it does not qualify");
    if (a.voltageKv < tier.minKv) return miss(`only a ${fmtKv(a.voltageKv)} asset was found; lower-voltage assets are not substituted`);
    if (!a.operatingEstablished) return miss("its operating status can't be established, so it does not qualify");
    const km = validNonNegative(a.distanceKm);
    if (km === null) return miss("invalid distance");
    if (id === "substation" && validNonNegative(a.closerUntaggedKm) !== null && (a.closerUntaggedKm as number) < km) {
      context.push({ label: "Closer substation without a voltage tag", value: `${fmtKm(a.closerUntaggedKm as number)}: its voltage can't be established, so it is not counted` });
    }
    return {
      ...metric(id, label, weight, distanceScore(km, g.zeroKm), `${fmtKm(km)} (${a.name ? `${a.name}, ` : ""}${fmtKv(a.voltageKv)})`),
      method: `D(d) = 100 × max(0, 1 − d / ${g.zeroKm})`,
    };
  };

  const { mean, metrics } = renormalized([side("substation", g.substationWeight), side("line", g.lineWeight)]);
  const observed = metrics.filter((m) => m.state === "observed");
  const status: ComponentStatus = observed.length === 2 ? "observed" : observed.length === 1 ? "partial" : "unavailable";

  const q = site.queue.state === "available" ? site.queue.value : null;
  if (q && validNonNegative(q.activeMw) !== null) {
    context.push({
      label: "County interconnection queue (context, not scored)",
      value: `${fmtMw(q.activeMw as number)} of active requests in ${q.county ? `${q.county} County` : "the county"}${q.asOf ? ` (LBNL, through ${q.asOf})` : " (LBNL)"}: queued projects compete for the same transmission access`,
    });
  }

  const explain = () => {
    if (status === "unavailable") return "No qualifying distance could be established, so this component uses a neutral 50 (not 0 km).";
    const parts = observed.map((m) => `${m.label.replace("Nearest qualifying ", "")} ${m.value.split(" (")[0]} → ${fmtScore(m.score as number)}`);
    const lead = status === "partial" ? `${parts[0]}; the other distance is unknown, so this one carries the full weight` : parts.join("; ");
    return `${lead}. Each distance scores 100 at the asset and 0 at ${g.zeroKm} km or more.`;
  };
  return component("grid", policy, {
    score: mean,
    status,
    method: `G = ${g.substationWeight.toFixed(2)} × D(substation km) + ${g.lineWeight.toFixed(2)} × D(line km), D(d) = 100 × max(0, 1 − d / ${g.zeroKm}); nearest qualifying assets ${tierLabel(tier, policy)}. One distance missing: it carries the full weight (partial); both missing: neutral ${policy.neutralScore}.`,
    metrics,
    context,
    missingFields,
    assumptions: [
      `Voltage-search tiers (${g.tiers.map((t) => `${Number.isFinite(t.maxMw) ? `≤ ${t.maxMw} MW` : "larger"}: ${t.minKv} kV`).join(", ")}) are asset-search heuristics, not electrical design requirements or proof of an acceptable point of interconnection.`,
      `Distances score 0 at ${g.zeroKm} km (policy heuristic).`,
      "Qualifying: a voltage tag at or above the threshold and an established operating status; untagged or lower-voltage assets never stand in.",
    ],
    explanation: explain(),
    notes: [
      "Straight-line distances underestimate actual route lengths, which follow terrain and rights-of-way.",
      "Proximity does not establish export or hosting capacity, spare capacity, system stability, interconnection approval, upgrade requirements or connection cost.",
      "Nearby existing generation is not counted as grid capacity: existing and queued generators may compete for the same transmission access.",
    ],
    sources: ["OpenStreetMap substations", "CEC California Electric Transmission Lines", "Straight-line distance in EPSG:3310"],
  });
}

// ---------------------------------------------------------------------------
// R: technology-specific resource and operating prerequisites
// ---------------------------------------------------------------------------

interface SubmetricOutcome {
  metric: MetricResult;
  missing: string | null;
  rejected: Fact[];
  method: string | null;
}

function scoreSubmetric(sub: SubmetricSpec, spec: TechnologySpec, site: SiteData, project: ProjectScenario): SubmetricOutcome {
  if (sub.notApplicableWithCooling && project.cooling === sub.notApplicableWithCooling) {
    return { metric: metric(sub.id, sub.label, sub.weight, null, `Not applicable: ${sub.notApplicableWithCooling} (air) cooling configured`, "not_applicable"), missing: null, rejected: [], method: null };
  }
  if (!sub.methods.length) {
    return { metric: metric(sub.id, sub.label, sub.weight, null, "Not exposed by Griddy"), missing: `${sub.label}: Griddy does not expose ${sub.needs}`, rejected: [], method: null };
  }
  const rejected: Fact[] = [];
  const why: string[] = [];
  for (const m of sub.methods) {
    const obs = m.input === "siting_similarity" ? (spec.mlKind ? site.sitingSimilarity[spec.mlKind] : undefined) : site.resource[m.input];
    if (!obs) {
      why.push(`${lowerFirst(m.label)} not exposed`);
      continue;
    }
    if (obs.state !== "available") {
      why.push(`${lowerFirst(m.label)} ${stateReason(obs)}`);
      continue;
    }
    const r = scoreInput(m, obs);
    if ("reason" in r) {
      rejected.push({ label: `${m.label} (shown, not scored)`, value: `${fmtObservation(obs)}: not scored because ${r.reason}. Source: ${obs.source}.` });
      why.push(`${lowerFirst(m.label)} not compatible`);
      continue;
    }
    const tag = obs.kind === "inferred" ? "inferred (ML)" : obs.kind;
    const ref = m.kind === "continuous" ? m.reference : null;
    const fallback = m !== sub.methods[0] ? `; fallback: ${listText(why)}` : "";
    return {
      metric: {
        ...metric(sub.id, sub.label, sub.weight, r.score, fmtObservation(obs)),
        method: `${ref ? `${m.label}: 100 × clamp((x − ${ref.low}) / (${ref.high} − ${ref.low}), 0, 1) [${prettyUnit(ref.unit)}${ref.heightM ? ` at ${ref.heightM} m` : ""}; ${ref.source}]` : m.label}${fallback}`,
        source: { kind: obs.kind, tag, detail: `${obs.source}${obs.detail ? `. ${obs.detail}` : ""}` },
      },
      missing: null,
      rejected,
      method: m.label,
    };
  }
  return {
    metric: metric(sub.id, sub.label, sub.weight, null, "Not available"),
    missing: `${sub.label}: needs ${sub.needs}${why.length ? ` (${why.join("; ")})` : ""}`,
    rejected,
    method: null,
  };
}

/** R: the technology's own prerequisites (Method 1/2 per input, Method 3 across submetrics), never nearby plants or weather. */
export function scoreResource(site: SiteData, project: ProjectScenario, policy: ScoringPolicy): ComponentResult {
  const spec = policy.technologies[project.technology];
  const outcomes = spec.submetrics.map((s) => scoreSubmetric(s, spec, site, project));
  const { mean, metrics } = renormalized(outcomes.map((o) => o.metric));
  const applicable = metrics.filter((m) => m.state !== "not_applicable");
  const observed = applicable.filter((m) => m.state === "observed");
  const status: ComponentStatus = !observed.length ? "unavailable" : observed.length < applicable.length ? "partial" : "observed";
  const missingFields = outcomes.map((o) => o.missing).filter((m): m is string => m !== null);
  const context = outcomes.flatMap((o) => o.rejected);

  // Nearby plants of the same fuel are context only: they never prove a resource here.
  const fuel = { solar_pv: "solar", onshore_wind: "wind", natural_gas: "gas", geothermal: "geothermal", hydroelectric: "hydro", biomass: null, nuclear: "nuclear" }[project.technology];
  const nearby = fuel && site.nearbyFuelMw.state === "available" ? validNonNegative(site.nearbyFuelMw.value?.[fuel]) : null;
  if (nearby !== null && nearby > 0) {
    context.push({ label: `Operating ${fuel} generation within 25 km (context, not scored)`, value: `${fmtMw(nearby)} (EIA-860): existing plants do not establish a developable resource or available supply at this site` });
  }

  const usesMl = metrics.some((m) => m.id === "siting_similarity" && m.state === "observed");
  const explain = () => {
    if (status === "unavailable") {
      return `Griddy exposes no supported screening for ${lowerFirst(spec.label)} prerequisites (${listText(applicable.map((m) => lowerFirst(m.label)))}), so this component uses a neutral ${policy.neutralScore}.`;
    }
    const parts = observed.map((m) => `${lowerFirst(m.label)} ${m.value.split(" (")[0]} → ${fmtScore(m.score as number)}`);
    const gap = applicable.filter((m) => m.state !== "observed").map((m) => lowerFirst(m.label));
    return `${parts.join("; ")}${gap.length ? `. Missing: ${listText(gap)}, so the available ${observed.length === 1 ? "screen carries" : "screens carry"} the full weight (partial)` : ""}.`;
  };
  const weights = spec.submetrics.map((s) => `${s.weight.toFixed(2)} ${lowerFirst(s.label)}`).join(" + ");
  return component("resource", policy, {
    score: mean,
    status,
    method: `R (${spec.label}) = ${weights}, renormalized over the submetrics with usable evidence. Each input uses the first compatible method in the policy's order of preference; nothing is scored without a documented reference range or mapping.`,
    metrics,
    context,
    missingFields,
    assumptions: [
      `Submetric weights for ${spec.label} are versioned product heuristics.`,
      ...spec.submetrics.flatMap((s) =>
        s.methods.filter((m) => m.kind === "continuous" && m.reference).map((m) => `${m.label}: ${m.reference?.low}–${m.reference?.high} ${prettyUnit(m.reference?.unit ?? "")} maps to 0–100 (${m.reference?.rationale})`),
      ),
    ],
    explanation: explain(),
    notes: [
      ...spec.limits,
      ...(usesMl
        ? ["Siting similarity is inferred: how much the site's 5 km cell resembles where operating plants of this technology were built. It is not a resource measurement, a permit or an interconnection finding, and its inputs partly repeat the grid and community components."]
        : []),
      "Nearby plant capacity, current weather and generic infrastructure density are never used as resource evidence.",
    ],
    sources: usesMl ? ["Griddy site-location model (B)", "ERA5 reanalysis via Open-Meteo", "NLR ATB 2025 resource classes"] : ["NLR ATB 2025 resource classes"],
  });
}

// ---------------------------------------------------------------------------
// E: environmental and permitting screening
// ---------------------------------------------------------------------------

export interface EpaSubscore {
  score: number | null;
  status: ComponentStatus;
  value: string;
  missing: string[];
  warnings: string[];
  /** Applicable designations with their pollutant, standard, area and classification. */
  designations: Designation[];
}

/** The lowest score across EPA designations; unresolved classifications are never guessed. */
export function epaSubscore(obs: Observation<Designation[]>, policy: ScoringPolicy): EpaSubscore {
  const none = (reason: string): EpaSubscore => ({ score: null, status: "unavailable", value: "Not available", missing: [`EPA nonattainment designations (${reason})`], warnings: [], designations: [] });
  if (obs.state === "confirmed_absent" || (obs.state === "available" && obs.value && !obs.value.length)) {
    return { score: policy.environment.attainmentScore, status: "observed", value: "No listed nonattainment (ozone, PM2.5)", missing: [], warnings: [], designations: [] };
  }
  if (obs.state !== "available" || !obs.value) return none(stateReason(obs, "EPA designation data did not load"));
  const list = obs.value;
  const label = (d: Designation) => `${d.naaqs ?? d.pollutant ?? "Unnamed standard"} (${d.classification ?? "classification unknown"})`;
  const scored = list.map((d) => ({ d, s: designationScore(d.classification, policy) }));
  const known = scored.filter((x): x is { d: Designation; s: number } => x.s !== null);
  const open = scored.filter((x) => x.s === null);
  const value = list.map(label).join("; ");
  if (!known.length) {
    return { score: null, status: "unavailable", value, missing: [`Score for ${listText(open.map((x) => label(x.d)))}: no documented mapping, so not guessed`], warnings: [], designations: list };
  }
  const lowest = Math.min(...known.map((x) => x.s));
  const warnings = open.length ? [`${open.length} designation${open.length === 1 ? " has an" : "s have an"} unresolved classification (${listText(open.map((x) => label(x.d)))}) that could lower this result: provisional.`] : [];
  return { score: lowest, status: open.length ? "partial" : "observed", value, missing: open.map((x) => `Classification of ${label(x.d)} (unresolved)`), warnings, designations: list };
}

/** E = 0.60 E_EPA + 0.40 E_other for combustion; E = E_other otherwise (EPA shown as context). */
export function scoreEnvironment(site: SiteData, project: ProjectScenario, policy: ScoringPolicy): ComponentResult {
  const spec = policy.technologies[project.technology];
  const env = policy.environment;
  const epa = epaSubscore(site.designations, policy);
  const screen = site.environmentalScreen.state === "available" ? site.environmentalScreen.value : null;
  const applies = screen !== null && (screen.technologies === "all" || screen.technologies.includes(project.technology));
  const otherScore = applies ? validNonNegative(screen?.score) : null;
  const otherReason = screen && !applies ? `the available screen does not apply to ${lowerFirst(spec.label)}` : stateReason(site.environmentalScreen, "Griddy has no documented, technology-applicable environmental screening method");
  const otherMetric: MetricResult = {
    ...metric("other", "Technology-applicable environmental screening (E_other)", spec.combustion ? env.otherWeight : 1, otherScore === null ? null : clamp(otherScore), otherScore === null ? "Not available" : `${fmtScore(otherScore)}/100`),
    method: screen?.method ?? "an existing, documented screening method (none in Griddy yet)",
    ...(screen && otherScore !== null ? { source: { kind: "observed" as const, tag: "observed", detail: screen.source } } : {}),
  };
  const context: Fact[] = [];
  const missingFields: string[] = [];
  if (otherScore === null) missingFields.push(`Environmental screening (${otherReason})`);
  const area = epa.designations.find((d) => d.area)?.area;
  if (area) context.push({ label: "Nonattainment area", value: area });
  const aqi = validNonNegative(site.aqi?.aqi);
  if (aqi !== null) context.push({ label: "Current AQI (context, not scored)", value: `${Math.round(aqi)}${site.aqi?.category ? ` ${site.aqi.category}` : ""}${site.aqi?.pollutant ? ` · ${site.aqi.pollutant}` : ""}` });
  for (const w of epa.warnings) context.push({ label: "Unresolved EPA classification", value: w });

  let metrics: MetricResult[];
  let score: number | null;
  let status: ComponentStatus;
  if (spec.combustion) {
    missingFields.push(...epa.missing);
    const epaMetric = { ...metric("epa", "EPA nonattainment (lowest applicable designation)", env.epaWeight, epa.score, epa.value), method: "lowest score across designations" };
    const r = renormalized([epaMetric, otherMetric]);
    metrics = r.metrics;
    score = r.mean;
    status = score === null ? "unavailable" : epa.status === "observed" && otherScore !== null ? "observed" : "partial";
  } else {
    // A noncombustion plant is not scored as an operational combustion source: EPA status is context.
    const shown = epa.score !== null && !epa.designations.length ? `${epa.value} (EPA Green Book)` : epa.designations.length ? epa.value : withReason("Not available", stateReason(site.designations, "EPA designation data did not load"));
    context.unshift({ label: `EPA status (context: not scored for ${lowerFirst(spec.label)})`, value: shown });
    const r = renormalized([otherMetric]);
    metrics = r.metrics;
    score = r.mean;
    status = score === null ? "unavailable" : "observed";
  }
  const explain = () => {
    if (status === "unavailable") {
      return spec.combustion
        ? "Neither EPA designations nor another environmental screen is available, so this component uses a neutral 50 (not attainment)."
        : `${spec.label} is not a combustion source, so EPA status is context only, and Griddy has no documented environmental screening for it: this component uses a neutral 50.`;
    }
    if (!spec.combustion) return `Environmental screening → ${fmtScore(score as number)}.`;
    const e = epa.score !== null ? (epa.designations.length ? `EPA: ${epa.value} → lowest ${fmtScore(epa.score)}` : `EPA: no listed ozone or PM2.5 nonattainment → ${fmtScore(epa.score)}`) : "EPA designations unavailable";
    return `${e}${otherScore === null ? "; no other documented environmental screen, so EPA carries the full weight (partial)" : `; environmental screening → ${fmtScore(otherScore)}`}.`;
  };
  const s = env.designationScores;
  return component("environment", policy, {
    score,
    status,
    method: spec.combustion
      ? `E = ${env.epaWeight.toFixed(2)} × E_EPA + ${env.otherWeight.toFixed(2)} × E_other (combustion source), renormalized over what is available. E_EPA = lowest across designations: attainment or none listed within coverage ${env.attainmentScore}, Marginal ${s.marginal}, Moderate ${s.moderate}, Serious ${s.serious}, Severe or Extreme ${s.severe}.`
      : `E = E_other (noncombustion source); EPA status is shown, not scored.`,
    metrics,
    context,
    missingFields,
    assumptions: [`EPA designation scores and the ${Math.round(env.epaWeight * 100)}/${Math.round(env.otherWeight * 100)} combustion split are policy heuristics.`, `Coverage: ${env.coverage}.`],
    explanation: explain(),
    notes: [
      "Nonattainment can increase permitting complexity, especially for new combustion sources, but does not automatically prohibit development.",
      "EPA attainment does not establish environmental clearance.",
      ...(spec.combustion ? [] : ["Construction emissions and emergency generators are not modeled here; they may still need air permits."]),
      "A current AQI snapshot never changes this score.",
      "Not legal or regulatory advice.",
    ],
    sources: ["US EPA Green Book nonattainment areas", "AirNow (context)"],
  });
}

// ---------------------------------------------------------------------------
// C: community exposure proxy
// ---------------------------------------------------------------------------

/** C from the estimated population within the policy radius. */
export function scoreCommunity(site: SiteData, policy: ScoringPolicy): ComponentResult {
  const { radiusKm, scale } = policy.community;
  const o = site.population;
  const n = o.state === "available" ? validNonNegative(o.value) : null;
  const reason = o.state === "available" && n === null ? "invalid value" : stateReason(o, "population data unavailable");
  const label = `Estimated population within ${radiusKm} km`;
  const metrics = [{ ...metric("population", label, 1, n === null ? null : communityScore(n, scale), n === null ? "Not available" : `≈ ${fmtPeople(n)} people`), method: `C = 100 × max(0, 1 − ln(1 + N) / ln(${en(scale + 1)}))` }];
  const score = n === null ? null : communityScore(n, scale);
  return component("community", policy, {
    score,
    status: score === null ? "unavailable" : "observed",
    method: `C = 100 × max(0, 1 − ln(1 + N) / ln(${en(scale + 1)})), N = estimated population within ${radiusKm} km (2020 Census block groups).`,
    metrics: metrics.map((m) => ({ ...m, effectiveWeight: m.state === "observed" ? 1 : 0 })),
    missingFields: n === null ? [`${label} (${reason})`] : [],
    assumptions: [`Log scale reaching 0 at ${en(scale)} people within ${radiusKm} km (policy heuristic).`],
    explanation:
      n === null
        ? `No usable population estimate (${reason}), so this component uses a neutral 50 (not zero people).`
        : `About ${fmtPeople(n)} people live within ${radiusKm} km (→ ${fmtScore(score as number)}). The proxy falls on a log scale as nearby residents increase.`,
    notes: [
      "An exposure proxy only. It does not measure community consent, environmental justice, demographic vulnerability, Tribal rights or interests, water stress, noise, visual impacts or shadow flicker, or benefits and their distribution.",
      "A lower population does not make a community inherently preferable, and it does not eliminate impacts.",
    ],
    sources: ["US Census 2020 block-group population"],
  });
}

// ---------------------------------------------------------------------------
// I: administrative and infrastructure context
// ---------------------------------------------------------------------------

type Resolution = "identified" | "not_identified" | "unresolved";

function resolve(o: Observation<string>): Resolution {
  if (o.state === "available" && o.value) return "identified";
  if (o.state === "confirmed_absent" || o.state === "outside_coverage") return "not_identified"; // definitive for this context metric
  return "unresolved";
}

/** I: both identified 100, one 60, neither 20; any unresolved lookup: neutral 50. */
export function scoreAdministrative(site: SiteData, policy: ScoringPolicy): ComponentResult {
  const a = policy.administrative;
  const sides: [string, string, Observation<string>][] = [
    ["utility", "Utility service territory", site.utility],
    ["ba", "Balancing authority", site.balancingAuthority],
  ];
  const res = sides.map(([, , o]) => resolve(o));
  const missingFields: string[] = [];
  // Each lookup is shown as found / not found; the component score comes from the policy's table, not a mean.
  const metrics = sides.map(([id, label, o], i): MetricResult => {
    if (res[i] === "unresolved") {
      missingFields.push(`${label} (${stateReason(o, "territory data unavailable")})`);
      return metric(id, label, 0.5, null, "Could not be determined");
    }
    const value = res[i] === "identified" ? (o.value as string) : o.state === "outside_coverage" ? "None: outside California coverage" : "None identified";
    return { ...metric(id, label, 0.5, null, value, "observed"), method: "lookup" };
  });
  const resolvedCount = res.filter((r) => r !== "unresolved").length;
  const found = res.filter((r) => r === "identified").length;
  const score = resolvedCount === 2 ? (found === 2 ? a.both : found === 1 ? a.one : a.neither) : resolvedCount === 1 ? policy.neutralScore : null;
  const status: ComponentStatus = resolvedCount === 2 ? "observed" : resolvedCount === 1 ? "partial" : "unavailable";
  return component("administrative", policy, {
    score,
    status,
    method: `Both identified ${a.both}, exactly one ${a.one}, neither ${a.neither}; any unresolved lookup: neutral ${policy.neutralScore}. Contributes at most ${en(Math.round(policy.weights.administrative * 100))} points.`,
    metrics,
    missingFields,
    assumptions: ["A confirmed outside-coverage result counts as a definitive non-identification for this limited context metric, not as evidence that no real-world authority exists."],
    explanation:
      status === "unavailable"
        ? "Neither lookup could run, so this component uses a neutral 50 (not 20)."
        : status === "partial"
          ? "One lookup is unresolved (missing data or a failed lookup), so this component uses a neutral 50 rather than reading the gap as absence."
          : `${found === 2 ? "Both utility and balancing authority are identified" : found === 1 ? "One of utility and balancing authority is identified" : "Neither utility nor balancing authority is identified"} (→ ${fmtScore(score as number)}).`,
    notes: [
      "Administrative context and source coverage only: not capacity, interconnection eligibility, purchase agreements or the identity of every required counterparty.",
    ],
    sources: ["CEC Electric Load Serving Entities", "CEC Balancing Authority Areas"],
  });
}

// ---------------------------------------------------------------------------
// Critical constraints: assessed apart from the score
// ---------------------------------------------------------------------------

export function assessConstraints(site: SiteData, project: ProjectScenario, policy: ScoringPolicy): ConstraintsResult {
  const tech = project.technology;
  const applies = (t: GenerationTechnology[] | "all") => t === "all" || t.includes(tech);
  const checks: ConstraintCheckResult[] = [];
  const critical: ConstraintFinding[] = [];
  const screening: ConstraintFinding[] = [];

  for (const c of policy.constraints.filter((x) => applies(x.technologies))) {
    const add = (status: ConstraintAssessment, detail: string) => checks.push({ id: c.id, label: c.label, tier: c.tier, status, detail });
    if (c.dataset === "statute") {
      if (site.inCoverage !== true) {
        add("not_assessed", site.inCoverage === false ? "Outside California: California statutes are the only ones encoded." : "Whether the site is in California is unknown.");
        continue;
      }
      const hits = policy.statutes.filter((s) => s.technologies.includes(tech));
      for (const s of hits) {
        const f: ConstraintFinding = { checkId: c.id, type: "documented_legal_restriction", title: s.title, evidence: s.evidence, source: s.source, url: s.url, date: s.date, technologies: s.technologies, basis: "documented_prohibition" };
        (c.tier === "critical" ? critical : screening).push(f);
      }
      add(hits.length ? "identified" : "none_identified_in_available_data", hits.length ? hits.map((s) => s.source).join("; ") : "None among the statutes encoded in this policy (not a legal review).");
    } else if (c.dataset === "protected_areas") {
      const o = site.protectedShare;
      const share = o.state === "available" ? validNonNegative(o.value) : null;
      if (share === null) {
        add("not_assessed", stateReason(o, "land screening covers the demo areas only"));
        continue;
      }
      if (share >= policy.protectedShareConcern) {
        const f: ConstraintFinding = {
          checkId: c.id,
          type: "protected_area_proximity",
          title: "Protected area within the 2 km screening buffer",
          evidence: `${fmtPct(share)} of the 2 km buffer overlaps a protected area. Proximity is a screening concern, not a prohibition: check the boundary against the project footprint.`,
          source: "E's land screening (protected-area overlap)",
          technologies: "all",
          basis: "screening_concern",
        };
        (c.tier === "critical" ? critical : screening).push(f);
        add("identified", f.evidence);
      } else add("none_identified_in_available_data", `${fmtPct(share)} of the 2 km buffer overlaps a protected area.`);
    } else add("not_assessed", c.description);
  }

  const criticalChecks = checks.filter((c) => c.tier === "critical");
  const assessment: ConstraintAssessment = critical.length ? "identified" : criticalChecks.some((c) => c.status === "not_assessed") ? "not_assessed" : "none_identified_in_available_data";
  const notAssessed = criticalChecks.filter((c) => c.status === "not_assessed").length;
  const summary =
    assessment === "identified"
      ? `${CRITICAL_HEADLINE}${notAssessed ? ` ${notAssessed} other critical check${notAssessed === 1 ? " was" : "s were"} not assessed.` : ""}`
      : assessment === "not_assessed"
        ? `${NOT_FULLY_ASSESSED} ${notAssessed} of ${criticalChecks.length} critical checks have no data in Griddy; none identified does not mean none exist.`
        : "None identified in the available data. This is not a finding that no constraints exist.";
  return { assessment, summary, checks, critical, screening };
}

// ---------------------------------------------------------------------------
// Overall score
// ---------------------------------------------------------------------------

const POLICY_WEIGHT_TOLERANCE = 1e-9;

export function calculatePowerPlantFeasibility(site: SiteData, projectInput: ProjectInput, policy: ScoringPolicy): FeasibilityResult | InvalidProjectResult {
  const sum = COMPONENT_KEYS.reduce((a, k) => a + policy.weights[k], 0);
  if (Math.abs(sum - 1) > POLICY_WEIGHT_TOLERANCE || COMPONENT_KEYS.some((k) => !(policy.weights[k] >= 0))) {
    return { valid: false, policyVersion: policy.version, errors: [`Scoring policy ${policy.version}: component weights must be non-negative and sum to 1 (they sum to ${sum}).`] };
  }
  const v = validateProject(projectInput, policy);
  if (!v.ok) return { valid: false, policyVersion: policy.version, errors: v.errors };
  const project = v.project;
  const spec = policy.technologies[project.technology];
  const tier = voltageTierFor(project.capacityMw, policy);

  const components = [scoreGrid(site, project, policy), scoreResource(site, project, policy), scoreEnvironment(site, project, policy), scoreCommunity(site, policy), scoreAdministrative(site, policy)];
  const byKey = <T>(f: (c: ComponentResult) => T) => Object.fromEntries(components.map((c) => [c.key, f(c)])) as Record<ComponentKey, T>;
  const get = (k: ComponentKey) => components.find((c) => c.key === k) as ComponentResult;

  const pointsTotal = components.reduce((a, c) => a + c.weightedContribution, 0);
  const raw = clamp(pointsTotal);
  const overallScore = Math.round(raw);
  const category = categoryFor(overallScore, policy);
  // Unrounded for the label boundaries, but without float noise: 0.30 + 0.15 + 0.05 is 50%, not 49.999…%.
  const completeness = Number((100 * components.reduce((a, c) => a + (c.status === "observed" ? c.weight : 0), 0)).toFixed(9));
  const label = completenessLabelFor(completeness, policy);
  const constraints = assessConstraints(site, project, policy);
  const provisional = isProvisional(site, tier);

  const notices: Notice[] = [];
  for (const f of constraints.critical) notices.push({ tone: "constraint", text: `${f.title} (${f.source}).` });
  const r = get("resource");
  if (r.status === "unavailable") notices.push({ tone: "warning", text: `Technology-specific resource screening unavailable: Griddy does not expose ${listText(spec.submetrics.filter((s) => s.methods.length === 0 || r.metrics.find((m) => m.id === s.id)?.state === "missing").map((s) => lowerFirst(s.label)))} for ${lowerFirst(spec.label)}, so R is a neutral ${policy.neutralScore}.` });
  else if (r.status === "partial") notices.push({ tone: "warning", text: `Resource screening incomplete for ${lowerFirst(spec.label)}: ${listText(r.metrics.filter((m) => m.state === "missing").map((m) => lowerFirst(m.label)))} not available.` });
  if (label === "Low") notices.push({ tone: "warning", text: LIMITED_EVIDENCE });
  if (constraints.assessment === "not_assessed") notices.push({ tone: "info", text: NOT_FULLY_ASSESSED });
  if (provisional) notices.push({ tone: "info", text: "Some site data is still loading: the score is provisional and may change." });

  const storage = validNonNegative(project.storageMw);
  const explanatoryNotes = [
    PRELIMINARY,
    `Scoring policy ${policy.version} (${policy.date}): S = ${formulaFor(policy)}. Weights, thresholds, reference ranges and mappings are versioned initial product heuristics, not empirically optimized weights or validated predictions of project success.`,
    "The overall weights are fixed: missing data never moves weight between components. A component with no usable data scores a neutral 50; inside a component, missing metrics drop out and the rest are reweighted.",
    "Missing inputs never count as 0 km, 0 people, attainment or favorable resource evidence, and unknown coverage is never read as confirmed absence.",
    `${COMPLETENESS_SCOPE} It is not a probability of success or statistical confidence, and a fully observed component can still rest on a limited method.`,
    `Defaults (${policy.technologies[policy.defaults.technology].label}, ${fmtMw(policy.defaults.capacityMw)}) are editable product defaults, not universal plant characteristics.`,
    ...(storage !== null && storage > 0 ? [`Co-located storage (${fmtMw(storage)}) is shown separately: it is not primary generation, is not counted as additional generation and is not scored. No export limit is assumed.`] : []),
    "Economic viability is not scored: Griddy has no compatible financial inputs for this screen.",
    `Not a substitute for ${listText(NOT_A_SUBSTITUTE)}.`,
  ];

  return {
    valid: true,
    policyVersion: policy.version,
    project,
    technologyLabel: spec.label,
    technologyNoun: lowerFirst(spec.label),
    voltageTier: tier,
    overallScoreRaw: raw,
    overallScore,
    pointsTotal,
    category,
    headline: constraints.assessment === "identified" ? CRITICAL_HEADLINE : category,
    dataCompletenessPercent: completeness,
    completenessLabel: label,
    components,
    componentScores: byKey((c) => c.score),
    weightedContributions: byKey((c) => c.weightedContribution),
    componentStatuses: byKey((c) => c.status),
    missingFields: components.flatMap((c) => c.missingFields.map((f) => `${c.label}: ${f}`)),
    constraints,
    considerations: considerationsFor(site, project, policy, components, constraints),
    notices,
    explanatoryNotes,
    exclusions: [
      { id: "land_suitability", label: "Land suitability", text: `${LAND_DISCLOSURE} ${LAND_NOT_CLEARED}` },
      { id: "economics", label: "Economic and financial viability", text: "Not scored: no compatible financial inputs. Costs, revenue and financing need their own analysis." },
    ],
    provisional,
  };
}

/** Any input the score reads is still loading. */
function isProvisional(site: SiteData, tier: VoltageTier): boolean {
  const grid = site.grid[tier.minKv];
  const states = [grid?.substation.state, grid?.line.state, site.population.state, site.designations.state, site.utility.state, site.balancingAuthority.state, ...Object.values(site.sitingSimilarity).map((o) => o?.state)];
  return states.includes("loading");
}

/** Key considerations: grid and resource findings apart from community and environmental ones. */
function considerationsFor(site: SiteData, project: ProjectScenario, policy: ScoringPolicy, components: ComponentResult[], constraints: ConstraintsResult): Consideration[] {
  const out: Consideration[] = [];
  const add = (group: ConsiderationGroup, tone: ConsiderationTone, text: string) => out.push({ group, tone, text });
  const get = (k: ComponentKey) => components.find((c) => c.key === k) as ComponentResult;
  const spec = policy.technologies[project.technology];
  const tier = voltageTierFor(project.capacityMw, policy);

  const grid = get("grid");
  add("grid", "neutral", `Voltage-search threshold: ${tierLabel(tier, policy)} (${fmtMw(project.capacityMw)} proposed)`);
  for (const m of grid.metrics) {
    if (m.state !== "observed" || m.score === null) {
      add("grid", "missing", `${m.label}: not available`);
      continue;
    }
    const km = Number.parseFloat(m.value);
    const tone: ConsiderationTone = m.score === 0 ? "tradeoff" : km <= 5 ? "advantage" : km > 20 ? "tradeoff" : "neutral";
    add("grid", tone, `${m.label}: ${m.value}${m.score === 0 && Number.isFinite(km) ? `, beyond the ${policy.grid.zeroKm} km scoring range` : ""}`);
  }
  const q = site.queue.state === "available" ? site.queue.value : null;
  if (q && validNonNegative(q.activeMw) !== null && (q.activeMw as number) >= 10_000) {
    add("grid", "tradeoff", `Congested county queue: ${fmtMw(q.activeMw as number)} of active requests in ${q.county ?? "the county"} (LBNL). Queued projects compete for transmission access; expect long study timelines.`);
  }
  add("grid", "caveat", `${GRID_NOT_VERIFIED} Distances do not show hosting capacity or upgrade needs; exporting from a new plant needs a utility interconnection study.`);

  const r = get("resource");
  for (const m of r.metrics) {
    if (m.state === "observed" && m.score !== null) add("resource", m.score >= 70 ? "advantage" : m.score < 30 ? "tradeoff" : "neutral", `${m.label}: ${m.value} → ${fmtScore(m.score)}${m.source?.kind === "inferred" ? " (inferred, not a resource measurement)" : ""}`);
    else if (m.state === "not_applicable") add("resource", "neutral", `${m.label}: ${lowerFirst(m.value)}`);
  }
  for (const f of r.missingFields) add("resource", "missing", `Missing operating prerequisite: ${f}`);
  for (const f of r.context.filter((x) => x.label.includes("shown, not scored"))) add("resource", "missing", `${f.label}: ${f.value}`);

  const pop = site.population.state === "available" ? validNonNegative(site.population.value) : null;
  if (pop !== null) add("community", "neutral", `≈ ${fmtPeople(pop)} people within ${policy.community.radiusKm} km (Census estimate): an exposure proxy, not a measure of impacts or support`);
  else add("community", "missing", `Population within ${policy.community.radiusKm} km: not available`);

  const epa = epaSubscore(site.designations, policy);
  const relevance = spec.combustion ? "scored: nonattainment adds permitting steps for a new combustion source" : `context only: ${lowerFirst(spec.label)} is not a combustion source, though construction equipment and backup generators may need air permits`;
  if (epa.score === null && !epa.designations.length) add("environment", "missing", `EPA nonattainment status: not available (${epa.missing[0] ?? "no data"})`);
  else if (epa.designations.length) add("environment", spec.combustion && (epa.score ?? 100) <= 30 ? "tradeoff" : "neutral", `EPA nonattainment: ${epa.value} (${relevance})`);
  else add("environment", "neutral", `No listed ozone or PM2.5 nonattainment (EPA Green Book; ${relevance})`);
  if (get("environment").metrics.some((m) => m.id === "other" && m.state === "missing")) add("environment", "missing", "No documented, technology-applicable environmental screening (habitat, wetlands, cultural resources, coastal zone) in Griddy");

  for (const f of constraints.critical) add("constraints", "constraint", `${f.title}: ${f.evidence} (${f.source}${f.date ? `, ${f.date}` : ""})`);
  for (const f of constraints.screening) add("constraints", "tradeoff", `${f.title}: ${f.evidence}`);
  for (const c of constraints.checks.filter((x) => x.status === "not_assessed" && x.tier === "critical")) add("constraints", "missing", `${c.label}: not assessed`);

  for (const c of components) {
    if (c.status === "unavailable") add("data", "missing", `${c.label}: no usable data, scored as a neutral ${policy.neutralScore}`);
    else if (c.status === "partial") add("data", "missing", `${c.label}: partially observed (${c.missingFields.join("; ")})`);
  }
  add("data", "missing", "Land suitability: Not assessed — excluded from this score.");
  return out;
}
