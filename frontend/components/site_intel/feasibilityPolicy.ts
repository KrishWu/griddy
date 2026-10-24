// Power plant site feasibility: the versioned scoring policy (weights, thresholds, reference
// ranges, mappings).  OWNER: workstream E (Site Intelligence).
//
// Data only, no imports, so Node runs this file as-is in the tests. feasibility.ts takes it as a
// parameter (calculatePowerPlantFeasibility(siteData, project, policy)), so tests can vary it.
// Every number here is an initial product heuristic, not an empirically optimized weight or a
// validated prediction of project success; anything not marked with a source needs domain review.
// Bump `version` whenever a number changes, then rebuild gradePercentiles.json
// (python -m app.site_intel.prep.grade_percentiles, from backend/).

export type GenerationTechnology = "solar_pv" | "onshore_wind" | "natural_gas" | "geothermal" | "hydroelectric" | "biomass" | "nuclear";
export type ComponentKey = "grid" | "resource" | "environment" | "community" | "administrative";
/** How a dataset answered for this site. Each consumer interprets it by the dataset's semantics. */
export type SourceState = "available" | "confirmed_absent" | "outside_coverage" | "unavailable" | "loading" | "error";
export type CoolingConfig = "not_specified" | "wet" | "dry";

/** Inputs a resource submetric can be scored from. Griddy exposes some of them (feasibilityInput.ts). */
export type ResourceInputKey =
  | "pv_capacity_factor"
  | "ghi_annual_mean"
  | "wind_capacity_factor"
  | "wind_speed_hub"
  | "siting_similarity"
  | "fuel_delivery"
  | "cooling_water"
  | "geothermal_resource"
  | "reservoir_evidence"
  | "fluid_management"
  | "hydrologic_head"
  | "water_use"
  | "feedstock"
  | "fuel_logistics"
  | "nuclear_siting";

export interface ReferenceRange {
  /** Method 1: R = 100 x clamp((x - low) / (high - low), 0, 1); larger is better. */
  low: number;
  high: number;
  unit: string;
  /** Measurement height the range applies to (m); an input at another height is incompatible. */
  heightM?: number;
  /** Coarsest input grid (km) the range is meaningful for; a coarser input is incompatible. */
  maxGridKm?: number;
  source: string;
  url?: string;
  rationale: string;
}

export interface InputMethod {
  input: ResourceInputKey;
  label: string;
  /** "continuous": Method 1 on `reference`. "classification": Method 2 on `classes`. */
  kind: "continuous" | "classification";
  /** null: no defensible range in this policy version, so the input is shown but never scored. */
  reference?: ReferenceRange | null;
  /** Source label (lower case) -> score. Unknown, unstudied or out-of-coverage labels are never scored. */
  classes?: Record<string, number>;
}

export interface SubmetricSpec {
  id: string;
  label: string;
  /** Weight within the resource component; renormalized over the submetrics that can be scored. */
  weight: number;
  /** Inputs in order of preference: the first usable one is scored. Empty: no method is supported yet. */
  methods: InputMethod[];
  /** What evidence would satisfy it, for the missing-evidence list. */
  needs: string;
  /** A configured cooling design that removes this prerequisite (it still isn't zero water demand). */
  notApplicableWithCooling?: CoolingConfig;
}

export interface TechnologySpec {
  label: string;
  /** Combustion source: EPA nonattainment is scored (60% of the environmental component). */
  combustion: boolean;
  /** Cooling configuration applies. */
  thermal: boolean;
  /** Kind in B's site-location artifact whose siting similarity applies; absent: no model for it. */
  mlKind?: string;
  submetrics: SubmetricSpec[];
  /** What the resource component cannot tell for this technology, shown with it. */
  limits: string[];
}

export interface VoltageTier {
  /** Largest nameplate (MW, inclusive) this tier covers; the last tier is unbounded. */
  maxMw: number;
  minKv: number;
}

export interface StatuteSpec {
  id: string;
  technologies: GenerationTechnology[];
  title: string;
  evidence: string;
  source: string;
  url: string;
  date: string;
}

export interface ConstraintCheckSpec {
  id: string;
  label: string;
  technologies: GenerationTechnology[] | "all";
  /** "critical": a finding overrides favorable headlines. "screening": listed, never decisive. */
  tier: "critical" | "screening";
  /** Where the evidence comes from. "none": Griddy has no such dataset, so the check is not assessed. */
  dataset: "statute" | "protected_areas" | "none";
  description: string;
}

export interface ScoringPolicy {
  version: string;
  date: string;
  weights: Record<ComponentKey, number>;
  neutralScore: number;
  defaults: { technology: GenerationTechnology; capacityMw: number };
  grid: {
    zeroKm: number;
    substationWeight: number;
    lineWeight: number;
    /** Ascending by maxMw; the minimum nominal voltage to search for, by project size. */
    tiers: VoltageTier[];
    /** A confirmed absence counts as 0 only when the search covered at least this radius. */
    minAbsentSearchKm: number;
  };
  technologies: Record<GenerationTechnology, TechnologySpec>;
  environment: {
    epaWeight: number;
    otherWeight: number;
    attainmentScore: number;
    /** First word of the EPA classification (lower case) -> score. Anything else is unresolved. */
    designationScores: Record<string, number>;
    coverage: string;
  };
  community: { radiusKm: number; scale: number };
  administrative: { both: number; one: number; neither: number };
  categories: { min: number; label: string }[];
  completeness: { high: number; moderate: number };
  protectedShareConcern: number;
  statutes: StatuteSpec[];
  constraints: ConstraintCheckSpec[];
}

const ML_SIMILARITY = (what: string): InputMethod => ({
  input: "siting_similarity",
  label: `Siting similarity to operating ${what} plants (site-location model)`,
  kind: "continuous",
  reference: {
    low: 0,
    high: 1,
    unit: "model score (0-1)",
    source: "Griddy site-location model (workstream B, ml/site_location)",
    rationale:
      "The model's own scale: 0 = unlike every place such plants were built (EIA-860, 5 MW and up, online since 2000), 1 = indistinguishable. Its inputs include grid distance, population, demand, resource and air quality, so it partly repeats the grid and community components; it is not a resource measurement or a probability of success.",
  },
});

const NOT_EXPOSED: InputMethod[] = [];

export const POWER_PLANT_POLICY: ScoringPolicy = {
  version: "griddy-pp-1.0",
  date: "2026-10-24",
  // Grid and resource prerequisites lead: a project needs both a resource (or operating supply)
  // and a path to export. Administrative context is weak evidence of technical feasibility.
  weights: { grid: 0.3, resource: 0.3, environment: 0.2, community: 0.15, administrative: 0.05 },
  neutralScore: 50,
  defaults: { technology: "solar_pv", capacityMw: 100 }, // editable product defaults, not plant characteristics
  grid: {
    zeroKm: 50,
    substationWeight: 0.6,
    lineWeight: 0.4,
    // Asset-search heuristics (no documented Griddy policy existed), not electrical design
    // requirements or proof of an acceptable point of interconnection. 220 kV is Griddy's 220 kV+
    // class (the 230 kV class incl. SCE's 220 kV system). SCE's 66 kV and PG&E's 60 kV
    // subtransmission fall below the 69 kV floor.
    tiers: [
      { maxMw: 20, minKv: 69 },
      { maxMw: 100, minKv: 115 },
      { maxMw: Number.POSITIVE_INFINITY, minKv: 220 },
    ],
    minAbsentSearchKm: 50,
  },
  technologies: {
    solar_pv: {
      label: "Solar PV",
      combustion: false,
      thermal: false,
      mlKind: "solar_pv",
      submetrics: [
        {
          id: "solar_resource",
          label: "Annual solar resource",
          weight: 0.6,
          needs: "location-specific modeled annual PV yield, or a long-term annual-mean GHI",
          methods: [
            // Preferred, but no reference range has been validated for it yet: shown, not scored.
            { input: "pv_capacity_factor", label: "Modeled annual PV capacity factor", kind: "continuous", reference: null },
            {
              input: "ghi_annual_mean",
              label: "Annual-mean global horizontal irradiance (GHI)",
              kind: "continuous",
              reference: {
                low: 3.75,
                high: 5.75,
                unit: "kWh/m2/day",
                source: "NLR ATB 2025, Utility-Scale PV resource classes (also data/evaluate/atb_2025_catalog.json)",
                url: "https://atb.nlr.gov/electricity/2025/utility-scale_pv",
                rationale:
                  "ATB bins US utility PV into 10 classes by mean GHI, from Class 10 (< 3.75) to Class 1 (> 5.75 kWh/m2/day). The range runs from the Class 10 ceiling (0) to the Class 1 floor (100). Annual-mean GHI varies smoothly away from coasts and mountains, so a coarse reanalysis is a usable screen; ATB's classes use multi-year NSRDB means.",
              },
            },
          ],
        },
        { id: "siting_similarity", label: "Siting similarity (ML)", weight: 0.4, needs: "the site-location model's solar score", methods: [ML_SIMILARITY("solar")] },
      ],
      limits: [
        "GHI is a resource screen, not modeled PV yield: no module, tracking, loss or curtailment assumptions.",
        "Coastal fog and terrain shading are finer than the resource grid.",
      ],
    },
    onshore_wind: {
      label: "Onshore wind",
      combustion: false,
      thermal: false,
      mlKind: "onshore_wind",
      submetrics: [
        {
          id: "wind_resource",
          label: "Long-term wind resource at hub height",
          weight: 0.6,
          needs: "a modeled annual wind capacity factor with turbine and hub-height assumptions, or a long-term mean wind speed at 110 m from a terrain-resolving (≤ 5 km) dataset",
          methods: [
            { input: "wind_capacity_factor", label: "Modeled annual wind capacity factor", kind: "continuous", reference: null },
            {
              input: "wind_speed_hub",
              label: "Mean wind speed at hub height",
              kind: "continuous",
              reference: {
                low: 5.9,
                high: 9.01,
                unit: "m/s",
                heightM: 110,
                maxGridKm: 5,
                source: "NLR ATB 2025, Land-Based Wind resource classes (also backend/app/evaluate/prep_atb.py)",
                url: "https://atb.nlr.gov/electricity/2025/land-based_wind",
                rationale:
                  "ATB bins US land-based wind into 10 classes by mean speed at 110 m, from Class 10 (< 5.90) to Class 1 (≥ 9.01 m/s). Wind at turbine height is shaped by ridges and passes a few km across, so an input coarser than 5 km (a judgment, needs review; ATB's resource comes from a 2 km dataset) averages them away.",
              },
            },
          ],
        },
        { id: "siting_similarity", label: "Siting similarity (ML)", weight: 0.4, needs: "the site-location model's wind score", methods: [ML_SIMILARITY("wind")] },
      ],
      limits: ["Current or surface wind speed is not utility-scale wind resource quality.", "No turbine, wake or curtailment assumptions are modeled."],
    },
    natural_gas: {
      label: "Natural gas",
      combustion: true,
      thermal: true,
      mlKind: "gas_cc",
      submetrics: [
        { id: "fuel_delivery", label: "Documented fuel-delivery screening", weight: 0.35, needs: "documented pipeline capacity, pressure and connection screening", methods: NOT_EXPOSED },
        {
          id: "cooling_water",
          label: "Cooling and water screening",
          weight: 0.25,
          needs: "a cooling-water availability screening for the configured cooling design",
          methods: NOT_EXPOSED,
          notApplicableWithCooling: "dry",
        },
        { id: "siting_similarity", label: "Siting similarity (ML)", weight: 0.4, needs: "the site-location model's gas score", methods: [ML_SIMILARITY("natural gas")] },
      ],
      limits: [
        "Pipeline proximity alone would not establish pressure, transport capacity, connection rights or fuel availability.",
        "An air-cooled design removes the cooling-water prerequisite, not all project water demand.",
      ],
    },
    geothermal: {
      label: "Geothermal",
      combustion: false,
      thermal: true,
      submetrics: [
        { id: "geothermal_resource", label: "Geothermal resource screening", weight: 0.5, needs: "an existing geothermal resource assessment or favorability classification", methods: NOT_EXPOSED },
        { id: "reservoir_evidence", label: "Reservoir evidence", weight: 0.3, needs: "well, temperature-gradient or reservoir data", methods: NOT_EXPOSED },
        { id: "fluid_management", label: "Fluid management and reinjection screening", weight: 0.2, needs: "a reinjection or fluid-disposal screening", methods: NOT_EXPOSED },
      ],
      limits: ["Nearby geothermal plants do not prove a developable reservoir at this location."],
    },
    hydroelectric: {
      label: "Hydroelectric",
      combustion: false,
      thermal: false,
      submetrics: [
        { id: "hydrologic_head", label: "Site-specific hydrologic and head screening", weight: 0.6, needs: "dependable-flow and usable-head data for the site", methods: NOT_EXPOSED },
        { id: "water_use", label: "Water-use and operating requirements", weight: 0.4, needs: "water-rights and operating-constraint screening", methods: NOT_EXPOSED },
      ],
      limits: ["River proximity would not establish dependable flow, usable head, water rights or authorization to build a dam."],
    },
    biomass: {
      label: "Biomass",
      combustion: true,
      thermal: true,
      submetrics: [
        { id: "feedstock", label: "Sustainable feedstock screening", weight: 0.5, needs: "a documented sustainable feedstock assessment within haul distance", methods: NOT_EXPOSED },
        { id: "fuel_logistics", label: "Fuel logistics", weight: 0.25, needs: "a road or rail haul screening", methods: NOT_EXPOSED },
        {
          id: "cooling_water",
          label: "Cooling and water screening",
          weight: 0.25,
          needs: "a cooling-water availability screening for the configured cooling design",
          methods: NOT_EXPOSED,
          notApplicableWithCooling: "dry",
        },
      ],
      limits: ["Nearby agricultural land would not establish available, sustainable or contracted feedstock."],
    },
    nuclear: {
      label: "Nuclear",
      combustion: false,
      thermal: true,
      submetrics: [
        {
          id: "nuclear_siting",
          label: "Technology-appropriate siting prerequisites",
          weight: 0.6,
          needs: "seismic, geologic, hydrologic and emergency-planning screening of the kind NRC siting review requires",
          methods: NOT_EXPOSED,
        },
        {
          id: "cooling_water",
          label: "Cooling and water screening",
          weight: 0.4,
          needs: "a cooling-water availability screening for the configured cooling design",
          methods: NOT_EXPOSED,
          notApplicableWithCooling: "dry",
        },
      ],
      limits: ["Transmission proximity and low population alone do not establish nuclear feasibility."],
    },
  },
  environment: {
    epaWeight: 0.6,
    otherWeight: 0.4,
    attainmentScore: 100,
    designationScores: { marginal: 70, moderate: 50, serious: 30, severe: 10, extreme: 10 },
    coverage: "EPA Green Book ozone and PM2.5 nonattainment areas loaded for California",
  },
  community: { radiusKm: 10, scale: 500_000 },
  administrative: { both: 100, one: 60, neither: 20 },
  categories: [
    { min: 80, label: "Favorable preliminary screening" },
    { min: 60, label: "Moderately favorable" },
    { min: 40, label: "Mixed constraints" },
    { min: 20, label: "Challenging" },
    { min: 0, label: "Highly constrained" },
  ],
  completeness: { high: 80, moderate: 50 },
  protectedShareConcern: 0.01, // E's land screening warns at 1% protected-area overlap (screening.py PROTECTED_WARN)
  statutes: [
    {
      id: "ca_nuclear_moratorium",
      technologies: ["nuclear"],
      title: "California moratorium on new nuclear fission power plants",
      evidence:
        "No new nuclear fission thermal power plant may be certified or permitted in California until the Energy Commission finds that the United States has approved a demonstrated technology or means for disposing of high-level nuclear waste, and reports that finding to the Legislature; the Commission has made no such finding. AB 2647 (2025-26 session) would exempt advanced reactors: verify the statute's current status before relying on this.",
      source: "California Public Resources Code § 25524.2 (Warren-Alquist Act)",
      url: "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=25524.2.&lawCode=PRC",
      date: "1976",
    },
  ],
  constraints: [
    {
      id: "statutory_restrictions",
      label: "Statewide statutory restrictions",
      technologies: "all",
      tier: "critical",
      dataset: "statute",
      description: "California statutes that restrict the proposed technology statewide, encoded in this policy with their citation.",
    },
    {
      id: "local_legal_restrictions",
      label: "Local legal restrictions (ordinances, moratoria, land-use designations)",
      technologies: "all",
      tier: "critical",
      dataset: "none",
      description: "County and city ordinances or moratoria that restrict the proposed use. Griddy has no such dataset.",
    },
    {
      id: "exclusion_classifications",
      label: "Authoritative technology-specific exclusion classifications",
      technologies: "all",
      tier: "critical",
      dataset: "none",
      description: "Official exclusion or avoidance areas for the technology (e.g. renewable-energy conservation plans, critical habitat). Griddy has no such dataset.",
    },
    {
      id: "essential_prerequisites",
      label: "Documented inability to meet an essential operating prerequisite",
      technologies: "all",
      tier: "critical",
      dataset: "none",
      description: "Documented evidence that the site cannot meet a prerequisite such as fuel, water or resource access. Griddy has no such dataset.",
    },
    {
      id: "protected_areas",
      label: "Protected-area overlap (2 km screening buffer)",
      technologies: "all",
      tier: "screening",
      dataset: "protected_areas",
      description: "Share of the 2 km buffer that overlaps a protected area, from E's land screening (demo areas only). Proximity is a screening concern, not a prohibition.",
    },
  ],
};

export const POLICY_TECHNOLOGIES = Object.keys(POWER_PLANT_POLICY.technologies) as GenerationTechnology[];
