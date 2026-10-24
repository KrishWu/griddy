// Tests for the power plant site feasibility score (feasibility.ts, feasibilityPolicy.ts) and its
// input adapter (feasibilityInput.ts).  OWNER: workstream E (Site Intelligence).
// Run from frontend/:  node --test components/site_intel/feasibility.test.mjs
// Node >= 22.18 runs the .ts modules directly (type stripping), so there is no test framework or
// build step to install. backend/tests/test_site_intel_feasibility.py runs this file inside pytest.
// Assertions check ranges, invariants and component behavior, not exact totals.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  COMPONENT_KEYS,
  CRITICAL_HEADLINE,
  LAND_DISCLOSURE,
  LIMITED_EVIDENCE,
  NOT_FULLY_ASSESSED,
  assessConstraints,
  calculatePowerPlantFeasibility,
  categoryFor,
  communityScore,
  completenessLabelFor,
  distanceScore,
  epaSubscore,
  formulaFor,
  scoreAdministrative,
  scoreCommunity,
  scoreEnvironment,
  scoreGrid,
  scoreInput,
  scoreResource,
  validateProject,
  voltageTierFor,
} from "./feasibility.ts";
import { feasibilityInput, intelFor } from "./feasibilityInput.ts";
import { POLICY_TECHNOLOGIES, POWER_PLANT_POLICY as POLICY } from "./feasibilityPolicy.ts";

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
const ok = (value) => ({ state: "available", value });
const absent = (state = "unavailable", reason) => ({ state, value: null, ...(reason ? { reason } : {}) });
const asset = (distanceKm, voltageKv, name = "Asset", extra = {}) => ok({ name, voltageKv, distanceKm, operatingEstablished: true, ...extra });
const tier = (subKm, lineKm, kv) => ({ substation: asset(subKm, kv, `Sub ${kv}`), line: asset(lineKm, kv, `Line ${kv}`) });
const ghi = (value, over = {}) => ({ state: "available", value, unit: "kWh/m2/day", gridKm: 50, period: "2024", kind: "observed", source: "ERA5 test", ...over });
const era5Wind = (value) => ({ state: "available", value, unit: "m/s", heightM: 100, gridKm: 50, period: "2024", kind: "observed", source: "ERA5 test" });
const ml = (value) => ({ state: "available", value, unit: "model score (0-1)", kind: "inferred", source: "Griddy site-location model test" });

/** A California site with every dataset Griddy exposes observed; override pieces per test. */
function site(over = {}) {
  return {
    location: { lon: -119.5, lat: 35.4 },
    inCoverage: true,
    grid: { 69: tier(2, 1, 69), 115: tier(4, 2, 115), 220: tier(8, 3, 230) },
    resource: { ghi_annual_mean: ghi(5.25), wind_speed_hub: era5Wind(4.2) },
    sitingSimilarity: { solar_pv: ml(0.9), onshore_wind: ml(0.8), gas_cc: ml(0.7), battery: ml(0.95) },
    population: ok(1000),
    designations: ok([]),
    environmentalScreen: absent("unavailable", "no documented method"),
    aqi: { aqi: 42, category: "Good", pollutant: "PM2.5" },
    utility: ok("PG&E"),
    balancingAuthority: ok("CAISO"),
    protectedShare: absent(),
    queue: absent(),
    nearbyFuelMw: absent(),
    ...over,
  };
}

/** Nothing usable anywhere (but inside coverage, so missing is not "outside"). */
const NOTHING = {
  location: null,
  inCoverage: null,
  grid: {},
  resource: {},
  sitingSimilarity: {},
  population: absent(),
  designations: absent(),
  environmentalScreen: absent(),
  aqi: null,
  utility: absent(),
  balancingAuthority: absent(),
  protectedShare: absent(),
  queue: absent(),
  nearbyFuelMw: absent(),
};

const project = (over = {}) => ({ technology: "solar_pv", capacityMw: 100, ...over });
const grade = (s = site(), p = project(), policy = POLICY) => {
  const r = calculatePowerPlantFeasibility(s, p, policy);
  assert.equal(r.valid, true, r.valid ? "" : r.errors.join("; "));
  invariants(r);
  return r;
};
const comp = (r, key) => r.components.find((c) => c.key === key);

/** Must hold for every valid result. */
function invariants(r) {
  assert.ok(Number.isFinite(r.overallScoreRaw) && r.overallScoreRaw >= 0 && r.overallScoreRaw <= 100, `score ${r.overallScoreRaw} in 0-100`);
  assert.equal(r.overallScore, Math.round(r.overallScoreRaw)); // displayed as an integer
  assert.equal(r.category, categoryFor(r.overallScore, POLICY)); // from the displayed score: no contradiction
  assert.deepEqual(
    r.components.map((c) => c.key),
    COMPONENT_KEYS,
  ); // exactly the five components: no land row
  close(
    r.components.reduce((a, c) => a + c.weightedContribution, 0),
    r.pointsTotal,
  );
  close(r.pointsTotal, r.overallScoreRaw); // contributions sum to the unrounded score
  for (const c of r.components) {
    assert.ok(Number.isFinite(c.score) && c.score >= 0 && c.score <= 100, `${c.key} ${c.score}`);
    close(c.weightedContribution, c.score * c.weight);
    if (c.status === "unavailable") assert.equal(c.score, POLICY.neutralScore);
  }
  const observed = r.components.filter((c) => c.status === "observed").reduce((a, c) => a + c.weight, 0);
  close(r.dataCompletenessPercent, 100 * observed); // partial components get no completeness
  assert.equal(r.completenessLabel, completenessLabelFor(r.dataCompletenessPercent, POLICY));
  assert.ok(comp(r, "administrative").weightedContribution <= 5 + 1e-9, "administrative context adds at most 5 points");
  assert.ok(!r.components.some((c) => /land/i.test(c.label)), "no land component");
  if (r.constraints.assessment === "identified") assert.equal(r.headline, CRITICAL_HEADLINE);
  else assert.equal(r.headline, r.category);
  assert.ok(!/no constraints/i.test(r.constraints.summary));
}

describe("policy and formula", () => {
  test("weights are 0.30 + 0.30 + 0.20 + 0.15 + 0.05 = 1, with no land weight", () => {
    assert.deepEqual(POLICY.weights, { grid: 0.3, resource: 0.3, environment: 0.2, community: 0.15, administrative: 0.05 });
    close(
      Object.values(POLICY.weights).reduce((a, b) => a + b, 0),
      1,
    );
    assert.equal(formulaFor(POLICY), "0.30 G + 0.30 R + 0.20 E + 0.15 C + 0.05 I");
    assert.ok(!Object.keys(POLICY.weights).some((k) => /land/i.test(k)));
  });

  test("a policy whose weights don't sum to 1 is refused, not silently rescaled", () => {
    const bad = { ...POLICY, weights: { ...POLICY.weights, grid: 0.4 } };
    const r = calculatePowerPlantFeasibility(site(), project(), bad);
    assert.equal(r.valid, false);
    assert.match(r.errors[0], /sum to 1/);
  });

  test("categories follow the displayed integer score", () => {
    assert.equal(categoryFor(80, POLICY), "Favorable preliminary screening");
    assert.equal(categoryFor(79, POLICY), "Moderately favorable");
    assert.equal(categoryFor(60, POLICY), "Moderately favorable");
    assert.equal(categoryFor(59, POLICY), "Mixed constraints");
    assert.equal(categoryFor(40, POLICY), "Mixed constraints");
    assert.equal(categoryFor(20, POLICY), "Challenging");
    assert.equal(categoryFor(19, POLICY), "Highly constrained");
    assert.equal(categoryFor(0, POLICY), "Highly constrained");
  });

  test("completeness labels use the unrounded percentage", () => {
    assert.equal(completenessLabelFor(80, POLICY), "High");
    assert.equal(completenessLabelFor(79.999, POLICY), "Moderate");
    assert.equal(completenessLabelFor(50, POLICY), "Moderate");
    assert.equal(completenessLabelFor(49.999, POLICY), "Low");
  });
});

describe("project validation", () => {
  test("defaults are solar PV at 100 MW", () => {
    assert.deepEqual(POLICY.defaults, { technology: "solar_pv", capacityMw: 100 });
  });

  for (const capacityMw of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "100", null, undefined]) {
    test(`capacity ${String(capacityMw)} is a validation error, not a substituted default`, () => {
      const r = calculatePowerPlantFeasibility(site(), { technology: "solar_pv", capacityMw }, POLICY);
      assert.equal(r.valid, false);
      assert.match(r.errors.join(" "), /capacity must be a finite number of MW greater than 0/);
    });
  }

  test("a battery-only project is not scored", () => {
    const r = calculatePowerPlantFeasibility(site(), { technology: "battery", capacityMw: 100 }, POLICY);
    assert.equal(r.valid, false);
    assert.match(r.errors[0], /not primary generation/);
  });

  test("an unknown technology or invalid optional setting is reported", () => {
    assert.equal(validateProject({ technology: "fusion", capacityMw: 10 }, POLICY).ok, false);
    assert.equal(validateProject({ technology: "natural_gas", capacityMw: 10, cooling: "ice" }, POLICY).ok, false);
    assert.equal(validateProject({ technology: "solar_pv", capacityMw: 10, storageMw: -1 }, POLICY).ok, false);
    assert.equal(validateProject({ technology: "solar_pv", capacityMw: 10, storageMw: Number.NaN }, POLICY).ok, false);
    assert.equal(validateProject({ technology: "solar_pv", capacityMw: 0.5 }, POLICY).ok, true);
  });

  test("co-located storage is shown separately and never changes the score", () => {
    const plain = grade(site(), project());
    const hybrid = grade(site(), project({ storageMw: 50 }));
    assert.equal(hybrid.overallScoreRaw, plain.overallScoreRaw);
    assert.ok(hybrid.explanatoryNotes.some((n) => /storage \(50 MW\) is shown separately/.test(n)));
  });
});

describe("grid interconnection proximity (G)", () => {
  test("D(d) = 100 × max(0, 1 − d / 50)", () => {
    assert.equal(distanceScore(0, 50), 100);
    assert.equal(distanceScore(25, 50), 50);
    assert.equal(distanceScore(50, 50), 0);
    assert.equal(distanceScore(80, 50), 0);
  });

  test("nearby qualifying assets score high and fully observed", () => {
    const g = scoreGrid(site(), project(), POLICY);
    assert.equal(g.status, "observed");
    close(g.score, 0.6 * distanceScore(4, 50) + 0.4 * distanceScore(2, 50)); // 100 MW: the 115 kV tier
    assert.ok(g.context.some((f) => f.label === "Active voltage-search threshold" && /115 kV/.test(f.value)));
  });

  test("qualifying assets farther than 50 km score 0 (observed, not missing)", () => {
    const g = scoreGrid(site({ grid: { 115: tier(60, 75, 115) } }), project(), POLICY);
    assert.equal(g.score, 0);
    assert.equal(g.status, "observed");
  });

  test("capacity changes crossing the voltage thresholds switch the searched assets", () => {
    assert.equal(voltageTierFor(20, POLICY).minKv, 69);
    assert.equal(voltageTierFor(20.01, POLICY).minKv, 115);
    assert.equal(voltageTierFor(100, POLICY).minKv, 115);
    assert.equal(voltageTierFor(100.01, POLICY).minKv, 220);
    assert.equal(voltageTierFor(5000, POLICY).minKv, 220);
    const s = site();
    const small = scoreGrid(s, project({ capacityMw: 20 }), POLICY);
    const mid = scoreGrid(s, project({ capacityMw: 50 }), POLICY);
    const big = scoreGrid(s, project({ capacityMw: 300 }), POLICY);
    assert.ok(small.score > mid.score && mid.score > big.score, `${small.score} > ${mid.score} > ${big.score}`);
    assert.match(big.metrics[0].value, /230 kV/);
  });

  test("one missing distance carries the other's full weight and is partial", () => {
    const g = scoreGrid(site({ grid: { 115: { substation: absent("unavailable", "layer did not load"), line: asset(10, 115) } } }), project(), POLICY);
    close(g.score, distanceScore(10, 50));
    assert.equal(g.status, "partial");
    assert.ok(g.missingFields.some((f) => /substation/.test(f)));
  });

  test("both distances missing: neutral 50, unavailable, never 0 km", () => {
    const g = scoreGrid(site({ grid: {} }), project(), POLICY);
    assert.equal(g.score, 50);
    assert.equal(g.status, "unavailable");
  });

  test("unknown voltage, lower voltage or unknown operating status never qualifies", () => {
    for (const bad of [asset(1, null), asset(1, 66), ok({ name: "x", voltageKv: 230, distanceKm: 1, operatingEstablished: false })]) {
      const g = scoreGrid(site({ grid: { 115: { substation: bad, line: asset(30, 115) } } }), project(), POLICY);
      close(g.score, distanceScore(30, 50)); // the bad substation never stands in
      assert.equal(g.status, "partial");
    }
  });

  test("negative, NaN and infinite distances are missing, not 0 km", () => {
    for (const km of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const g = scoreGrid(site({ grid: { 115: { substation: asset(km, 115), line: asset(km, 115) } } }), project(), POLICY);
      assert.equal(g.status, "unavailable");
      assert.equal(g.score, 50);
    }
  });

  test("a confirmed absence counts as 0 only over a ≥ 50 km search inside coverage", () => {
    const none = { state: "confirmed_absent", value: null, searchedKm: Number.POSITIVE_INFINITY };
    const covered = scoreGrid(site({ grid: { 115: { substation: none, line: asset(10, 115) } } }), project(), POLICY);
    close(covered.score, 0.6 * 0 + 0.4 * distanceScore(10, 50));
    assert.equal(covered.status, "observed");
    const short = scoreGrid(site({ grid: { 115: { substation: { ...none, searchedKm: 20 }, line: asset(10, 115) } } }), project(), POLICY);
    assert.equal(short.status, "partial"); // a 20 km search can't support a 0
    const unknown = scoreGrid(site({ inCoverage: null, grid: { 115: { substation: none, line: asset(10, 115) } } }), project(), POLICY);
    assert.equal(unknown.status, "partial"); // unknown coverage is not confirmed absence
  });

  test("outside California nothing is read as a distance", () => {
    const g = scoreGrid(site({ inCoverage: false }), project(), POLICY);
    assert.equal(g.status, "unavailable");
    assert.ok(g.missingFields.every((f) => /outside California/.test(f)));
  });

  test("a closer untagged substation is disclosed, not counted", () => {
    const g = scoreGrid(site({ grid: { 115: { substation: asset(9, 115, "S", { closerUntaggedKm: 1.5 }), line: asset(3, 115) } } }), project(), POLICY);
    close(g.score, 0.6 * distanceScore(9, 50) + 0.4 * distanceScore(3, 50));
    assert.ok(g.context.some((f) => /without a voltage tag/.test(f.label)));
  });

  test("the county queue is context only", () => {
    const busy = site({ queue: ok({ county: "Kern", activeMw: 29_000, activeProjects: 300, asOf: "2025" }) });
    assert.equal(scoreGrid(busy, project(), POLICY).score, scoreGrid(site(), project(), POLICY).score);
    assert.ok(grade(busy).considerations.some((c) => /Congested county queue/.test(c.text)));
  });
});

describe("resource and operating prerequisites (R)", () => {
  test("solar: ATB-range GHI and siting similarity, fully observed", () => {
    const r = scoreResource(site({ resource: { ghi_annual_mean: ghi(4.75) } }), project(), POLICY);
    assert.equal(r.status, "observed");
    close(r.score, 0.6 * 50 + 0.4 * 90); // GHI 4.75 is halfway between 3.75 and 5.75
    const top = scoreResource(site({ resource: { ghi_annual_mean: ghi(6.5) }, sitingSimilarity: { solar_pv: ml(1) } }), project(), POLICY);
    close(top.score, 100);
    const low = scoreResource(site({ resource: { ghi_annual_mean: ghi(3) }, sitingSimilarity: { solar_pv: ml(0) } }), project(), POLICY);
    close(low.score, 0);
  });

  test("wind: a compatible hub-height speed is scored on ATB's 110 m classes", () => {
    const hub = { state: "available", value: (5.9 + 9.01) / 2, unit: "m/s", heightM: 110, gridKm: 2, kind: "observed", source: "WIND Toolkit test" };
    const r = scoreResource(site({ resource: { wind_speed_hub: hub } }), project({ technology: "onshore_wind" }), POLICY);
    assert.equal(r.status, "observed");
    close(r.score, 0.6 * 50 + 0.4 * 80);
  });

  test("wind: ERA5 at 100 m on a ~50 km grid is shown but not scored", () => {
    const r = scoreResource(site(), project({ technology: "onshore_wind" }), POLICY);
    assert.equal(r.status, "partial");
    close(r.score, 80); // siting similarity alone, renormalized
    const shown = r.context.find((f) => /shown, not scored/.test(f.label));
    assert.ok(shown && /110 m/.test(shown.value) && /5 km/.test(shown.value), shown?.value);
  });

  test("missing resource data never reads as favorable", () => {
    const r = scoreResource(site({ resource: {}, sitingSimilarity: {} }), project(), POLICY);
    assert.equal(r.status, "unavailable");
    assert.equal(r.score, 50);
    const loading = scoreResource(site({ resource: { ghi_annual_mean: { ...ghi(5.5), state: "loading" } }, sitingSimilarity: {} }), project(), POLICY);
    assert.equal(loading.status, "unavailable");
  });

  test("invalid reference bounds or incompatible units are not scored", () => {
    const m = POLICY.technologies.solar_pv.submetrics[0].methods[1];
    assert.ok("reason" in scoreInput({ ...m, reference: { ...m.reference, low: 6, high: 4 } }, ghi(5)));
    assert.ok("reason" in scoreInput({ ...m, reference: { ...m.reference, high: Number.NaN } }, ghi(5)));
    assert.ok("reason" in scoreInput(m, ghi(5, { unit: "W/m2" })));
    assert.ok("reason" in scoreInput(m, ghi(-1)));
    assert.ok("reason" in scoreInput(m, ghi(Number.NaN)));
    assert.ok("reason" in scoreInput({ ...m, reference: null }, ghi(5)));
    assert.ok("score" in scoreInput(m, ghi(5)));
  });

  test("classifications: documented labels map, unknown ones are never unsuitable", () => {
    const m = { input: "geothermal_resource", label: "Favorability", kind: "classification", classes: { high: 100, moderate: 70, low: 30, unsuitable: 0 } };
    const at = (value) => scoreInput(m, { state: "available", value, unit: "class", kind: "observed", source: "t" });
    assert.deepEqual(at("High"), { score: 100 });
    assert.deepEqual(at("unsuitable"), { score: 0 });
    for (const label of ["unknown", "unstudied", "outside coverage"]) assert.ok("reason" in at(label));
  });

  test("natural gas: pipeline or water proximity is not fuel or water evidence", () => {
    const near = site({ resource: { ...site().resource, fuel_delivery: { state: "available", value: 0.5, unit: "km", kind: "observed", source: "pipeline distance" }, cooling_water: { state: "available", value: 0.2, unit: "km", kind: "observed", source: "river distance" } } });
    const r = scoreResource(near, project({ technology: "natural_gas" }), POLICY);
    assert.equal(r.status, "partial");
    close(r.score, 70); // siting similarity only: proximity inputs have no supported method
    assert.ok(r.missingFields.some((f) => /fuel-delivery/.test(f)));
    assert.ok(r.missingFields.some((f) => /cooling/i.test(f)));
  });

  test("dry cooling removes the cooling-water prerequisite but not the fuel one", () => {
    const r = scoreResource(site(), project({ technology: "natural_gas", cooling: "dry" }), POLICY);
    assert.equal(r.metrics.find((m) => m.id === "cooling_water").state, "not_applicable");
    assert.equal(r.status, "partial");
    assert.ok(!r.missingFields.some((f) => /cooling/i.test(f)));
  });

  for (const technology of ["geothermal", "hydroelectric", "biomass", "nuclear"]) {
    test(`${technology}: no supported method, so neutral 50 with the missing prerequisites listed`, () => {
      const r = grade(site({ nearbyFuelMw: ok({ geothermal: 900, hydro: 300, nuclear: 2200 }) }), project({ technology }));
      const res = comp(r, "resource");
      assert.equal(res.status, "unavailable");
      assert.equal(res.score, 50);
      assert.ok(res.missingFields.length >= 2);
      assert.ok(r.notices.some((n) => /resource screening unavailable/i.test(n.text)));
      // Nearby plants are context, never resource evidence.
      if (technology !== "biomass") assert.ok(res.context.some((f) => /context, not scored/.test(f.label)));
    });
  }
});

describe("environmental and permitting screening (E)", () => {
  const severe = ok([{ pollutant: "Ozone", naaqs: "2015 8-hour ozone", area: "SJV", classification: "Extreme" }]);

  test("EPA: lowest score across designations", () => {
    assert.equal(epaSubscore(ok([]), POLICY).score, 100);
    assert.equal(epaSubscore(ok([{ classification: "Marginal" }]), POLICY).score, 70);
    const both = epaSubscore(ok([{ naaqs: "ozone", classification: "Moderate" }, { naaqs: "PM2.5", classification: "Serious" }]), POLICY);
    assert.equal(both.score, 30);
    assert.equal(both.status, "observed");
    assert.equal(epaSubscore(ok([{ classification: "Severe 15" }]), POLICY).score, 10);
  });

  test("EPA: unresolved classifications are never guessed", () => {
    const mixed = epaSubscore(ok([{ naaqs: "PM2.5", classification: "Serious" }, { naaqs: "ozone", classification: "Section 185A" }]), POLICY);
    assert.equal(mixed.score, 30);
    assert.equal(mixed.status, "partial");
    assert.equal(mixed.warnings.length, 1);
    const only = epaSubscore(ok([{ naaqs: "ozone", classification: null }]), POLICY);
    assert.equal(only.score, null);
    assert.equal(only.status, "unavailable");
  });

  test("EPA: confirmed attainment differs from failed, missing or outside-coverage queries", () => {
    assert.equal(epaSubscore(ok([]), POLICY).score, 100);
    for (const state of ["error", "unavailable", "outside_coverage", "loading"]) assert.equal(epaSubscore(absent(state), POLICY).score, null);
    const gas = project({ technology: "natural_gas" });
    assert.equal(scoreEnvironment(site({ designations: absent("error") }), gas, POLICY).score, 50);
    assert.equal(scoreEnvironment(site(), gas, POLICY).score, 100);
  });

  test("combustion sources score EPA; noncombustion ones show it as context", () => {
    const gas = scoreEnvironment(site({ designations: severe }), project({ technology: "natural_gas" }), POLICY);
    assert.equal(gas.score, 10);
    assert.equal(gas.status, "partial"); // no other documented screen
    const solar = scoreEnvironment(site({ designations: severe }), project(), POLICY);
    assert.equal(solar.score, 50);
    assert.equal(solar.status, "unavailable"); // regardless of EPA availability
    assert.ok(solar.context.some((f) => /not scored for solar/.test(f.label)));
    assert.equal(scoreEnvironment(site(), project(), POLICY).score, solar.score);
  });

  test("an available technology-applicable screen is used: 60/40 for combustion, alone otherwise", () => {
    const screen = ok({ score: 40, method: "test screen", source: "test", technologies: "all" });
    close(scoreEnvironment(site({ environmentalScreen: screen }), project({ technology: "natural_gas" }), POLICY).score, 0.6 * 100 + 0.4 * 40);
    assert.equal(scoreEnvironment(site({ environmentalScreen: screen }), project({ technology: "natural_gas" }), POLICY).status, "observed");
    assert.equal(scoreEnvironment(site({ environmentalScreen: screen }), project(), POLICY).score, 40);
    const notForSolar = ok({ score: 40, method: "t", source: "t", technologies: ["natural_gas"] });
    assert.equal(scoreEnvironment(site({ environmentalScreen: notForSolar }), project(), POLICY).status, "unavailable");
  });

  test("AQI changes never change the score", () => {
    const base = grade(site(), project({ technology: "natural_gas" })).overallScoreRaw;
    for (const aqi of [null, { aqi: 0, category: "Good", pollutant: "O3" }, { aqi: 300, category: "Hazardous", pollutant: "PM2.5" }]) {
      assert.equal(grade(site({ aqi }), project({ technology: "natural_gas" })).overallScoreRaw, base);
    }
  });
});

describe("community exposure proxy (C)", () => {
  test("log scale: zero is valid, large populations reach 0", () => {
    assert.equal(communityScore(0, 500_000), 100);
    close(communityScore(500_000, 500_000), 0);
    assert.equal(communityScore(5_000_000, 500_000), 0);
    assert.ok(communityScore(1000, 500_000) > communityScore(10_000, 500_000));
  });

  test("missing, negative and invalid populations are neutral 50, not zero people", () => {
    for (const population of [absent(), absent("error"), ok(-5), ok(Number.NaN), ok(Number.POSITIVE_INFINITY), ok("1000")]) {
      const c = scoreCommunity(site({ population }), POLICY);
      assert.equal(c.score, 50);
      assert.equal(c.status, "unavailable");
    }
    assert.equal(scoreCommunity(site({ population: ok(0) }), POLICY).score, 100);
  });

  test("the radius is shown and the limits are stated", () => {
    const c = scoreCommunity(site(), POLICY);
    assert.match(c.metrics[0].label, /10 km/);
    assert.ok(c.notes.some((n) => /consent/.test(n) && /Tribal/.test(n)));
  });
});

describe("administrative and infrastructure context (I)", () => {
  const admin = (utility, balancingAuthority) => scoreAdministrative(site({ utility, balancingAuthority }), POLICY);

  test("definitive outcomes: both 100, one 60, neither 20", () => {
    assert.equal(admin(ok("PG&E"), ok("CAISO")).score, 100);
    assert.equal(admin(ok("PG&E"), absent("confirmed_absent")).score, 60);
    assert.equal(admin(absent("confirmed_absent"), absent("confirmed_absent")).score, 20);
    assert.equal(admin(absent("outside_coverage"), absent("outside_coverage")).score, 20); // definitive for this metric
  });

  test("unresolved lookups: neutral 50, partial or unavailable", () => {
    const one = admin(ok("PG&E"), absent("error"));
    assert.equal(one.score, 50);
    assert.equal(one.status, "partial");
    const neither = admin(absent("unavailable"), absent("loading"));
    assert.equal(neither.score, 50);
    assert.equal(neither.status, "unavailable");
  });

  test("contributes at most 5 points", () => {
    for (const s of [site(), site({ utility: absent("confirmed_absent") }), NOTHING]) assert.ok(scoreAdministrative(s, POLICY).weightedContribution <= 5 + 1e-9);
  });
});

describe("critical constraints", () => {
  test("missing constraint datasets are not assessed, never 'no constraints'", () => {
    const c = assessConstraints(site(), project(), POLICY);
    assert.equal(c.assessment, "not_assessed");
    assert.ok(c.summary.startsWith(NOT_FULLY_ASSESSED));
    assert.ok(c.checks.some((k) => k.status === "not_assessed"));
    assert.ok(grade().notices.some((n) => n.text === NOT_FULLY_ASSESSED));
  });

  test("a critical constraint keeps the number but replaces a favorable headline", () => {
    const strong = site({ population: ok(0), designations: ok([]) });
    const r = grade(strong, project({ technology: "nuclear", capacityMw: 1000 }));
    assert.equal(r.constraints.assessment, "identified");
    assert.equal(r.headline, CRITICAL_HEADLINE);
    assert.notEqual(r.headline, r.category);
    assert.ok(r.overallScore > 0); // the weighted score is retained
    const f = r.constraints.critical[0];
    assert.equal(f.basis, "documented_prohibition");
    assert.match(f.source, /25524\.2/);
    assert.deepEqual(f.technologies, ["nuclear"]);
    assert.equal(grade(strong, project({ technology: "solar_pv" })).constraints.assessment, "not_assessed"); // technology-specific
  });

  test("protected-area proximity is a screening concern, never a prohibition", () => {
    const c = assessConstraints(site({ protectedShare: ok(0.4) }), project(), POLICY);
    assert.equal(c.critical.length, 0);
    assert.equal(c.screening[0].basis, "screening_concern");
    assert.notEqual(c.assessment, "identified");
  });

  test("outside California the statewide statute check is not assessed", () => {
    const c = assessConstraints(site({ inCoverage: false }), project({ technology: "nuclear" }), POLICY);
    assert.equal(c.critical.length, 0);
    assert.equal(c.assessment, "not_assessed");
  });
});

describe("overall score", () => {
  test("all five components unavailable: 50 with 0% completeness", () => {
    const r = grade(NOTHING);
    close(r.overallScoreRaw, 50);
    assert.equal(r.dataCompletenessPercent, 0);
    assert.equal(r.completenessLabel, "Low");
    assert.ok(r.notices.some((n) => n.text === LIMITED_EVIDENCE));
    assert.ok(r.components.every((c) => c.status === "unavailable"));
  });

  test("missing observations never become 0 km, 0 people, attainment or favorable resource", () => {
    const r = grade(NOTHING, project({ technology: "natural_gas" }));
    for (const k of COMPONENT_KEYS) assert.equal(comp(r, k).score, 50, k);
  });

  test("completeness: solar with every exposed dataset is 80% (E has no documented method)", () => {
    const r = grade();
    close(r.dataCompletenessPercent, 80);
    assert.equal(r.completenessLabel, "High");
    assert.equal(comp(r, "environment").status, "unavailable");
  });

  test("partially observed components get no completeness", () => {
    const r = grade(site(), project({ technology: "onshore_wind" }));
    assert.equal(comp(r, "resource").status, "partial");
    assert.equal(r.dataCompletenessPercent, 50); // exactly: 0.30 + 0.15 + 0.05 must not round down to Low
    assert.equal(r.completenessLabel, "Moderate");
    assert.ok(!r.notices.some((n) => n.text === LIMITED_EVIDENCE));
  });

  test("text keeps the technology's own capitalization mid-sentence", () => {
    const r = grade(site({ designations: ok([{ naaqs: "ozone", classification: "Marginal" }]) }));
    assert.equal(r.technologyNoun, "solar PV");
    assert.ok(comp(r, "environment").context.some((f) => f.label.includes("not scored for solar PV")));
  });

  test("land data neither changes the score nor completeness, and its exclusion is disclosed", () => {
    const base = grade();
    const withLand = grade({ ...site(), land: { slope: 30, usableAreaKm2: 0, parcelAvailable: false }, mean_slope_deg: 25 });
    assert.equal(withLand.overallScoreRaw, base.overallScoreRaw);
    assert.equal(withLand.dataCompletenessPercent, base.dataCompletenessPercent);
    assert.ok(base.exclusions.some((x) => x.id === "land_suitability" && x.text.includes(LAND_DISCLOSURE)));
    assert.ok(base.considerations.some((c) => c.text === "Land suitability: Not assessed — excluded from this score."));
    assert.ok(base.explanatoryNotes.some((n) => /does not include land suitability/.test(n)));
  });

  test("results are deterministic", () => {
    assert.deepEqual(grade(), grade());
  });

  test("technology and capacity changes update the affected components only", () => {
    const s = site();
    const solar = grade(s, project());
    const gas = grade(s, project({ technology: "natural_gas" }));
    assert.notEqual(comp(solar, "resource").score, comp(gas, "resource").score);
    assert.equal(comp(solar, "community").score, comp(gas, "community").score);
    const big = grade(s, project({ capacityMw: 500 }));
    assert.notEqual(comp(solar, "grid").score, comp(big, "grid").score);
    assert.equal(comp(solar, "resource").score, comp(big, "resource").score);
  });

  test("display rounding and category agree at a boundary", () => {
    // Search for a raw score that rounds up across a category boundary.
    for (let km = 0; km <= 50; km += 0.05) {
      const r = grade(site({ grid: { 115: tier(km, km, 115) } }));
      assert.equal(r.category, categoryFor(Math.round(r.overallScoreRaw), POLICY));
    }
  });

  test("scores stay finite and in range over random inputs", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const pick = (xs) => xs[Math.floor(rand() * xs.length)];
    const weird = [Number.NaN, -1, Number.POSITIVE_INFINITY, 0, 3, 1e9];
    for (let i = 0; i < 300; i++) {
      const s = site({
        grid: { [pick([69, 115, 220])]: tier(pick(weird), pick(weird), pick([null, 50, 115, 230])) },
        resource: { ghi_annual_mean: ghi(pick(weird)) },
        sitingSimilarity: { solar_pv: ml(pick(weird)), onshore_wind: ml(pick([0, 0.5, 2])), gas_cc: ml(pick(weird)) },
        population: ok(pick(weird)),
        designations: pick([ok([]), absent("error"), ok([{ classification: pick(["Marginal", "Extreme", "?", null]) }])]),
        utility: pick([ok("X"), absent("confirmed_absent"), absent("error")]),
      });
      grade(s, project({ technology: pick(POLICY_TECHNOLOGIES), capacityMw: pick([1, 20, 50, 150, 2000]) }));
    }
  });
});

// --- input adapter: A's summary (via readSummary's SiteView) + E's site intel ---

const LOC = { lon: -119.47, lat: 35.4 };

function view(over = {}) {
  return {
    county: "Kern",
    utility: "PG&E",
    utilityTitle: "Pacific Gas & Electric (IOU)",
    balancingAuthority: "CAISO",
    balancingAuthorityTitle: "California Independent System Operator",
    inCalifornia: true,
    substations: [],
    hvSubstation: { id: "s1", name: "Midway", voltage_kv: 500, distance_km: 1.64, location: null, operator: "PG&E", osm_url: null },
    hvLine: { id: "l1", name: "PG&E 500kV", owner: "PG&E", voltage_kv: 500, distance_km: 0.51, point: null },
    anyLine: null,
    plants: [],
    plantsCount: 25,
    plantsTotalMw: 1328,
    plantsByFuel: [["gas", 1100], ["solar", 150], ["battery", 78]],
    population: 12_000,
    distanceMethod: null,
    ...over,
  };
}

function summary(extras = {}) {
  return {
    site: { id: "site", name: "Site in Kern County, CA", location: LOC },
    nearest_substations: [],
    nearby_plants: [],
    findings: [],
    provenance: [],
    extras: {
      plants_within_25km: { count: 25, total_mw: 1328, by_fuel_mw: { gas: 1100, solar: 150, battery: 78 } },
      utility: { name: "Pacific Gas & Electric", acronym: "PG&E" },
      balancing_authority: { short_name: "CAISO", name: "California Independent System Operator" },
      in_california: true,
      missing_data: [],
      queue_county: { county: "Kern", active_projects: 300, active_mw: 28_894.9, as_of: "2025-12-31" },
      ...extras,
    },
  };
}

/** extras.grid_tiers as backend/app/site_intel/grid_tiers.py returns it. */
function gridTiersExtras() {
  const sub = (kv, km, extra = {}) => ({ id: `s${kv}`, name: `Sub ${kv}`, voltage_kv: kv, distance_km: km, ...extra });
  const line = (kv, km) => ({ id: `l${kv}`, name: `Line ${kv}`, voltage_kv: kv, distance_km: km });
  return {
    available: true,
    thresholds_kv: [69, 115, 220],
    tiers: {
      69: { substation_state: "available", substation: sub(70, 0.8, { closer_untagged_km: 0.3 }), line_state: "available", line: line(70, 0.4) },
      115: { substation_state: "available", substation: sub(115, 1.2), line_state: "available", line: line(115, 0.22) },
      220: { substation_state: "available", substation: sub(500, 1.64), line_state: "confirmed_absent", line: null },
    },
  };
}

/** extras.ml as backend/app/site_intel/ml.py returns it. */
function mlExtras(over = {}) {
  return {
    available: true,
    site_artifact: { id: "sites-model-test", mode: "model", scenario: "mid", year: 2035, grid_spacing_km: 5, model_metrics: { solar_pv: { roc_auc: 0.937 }, gas_cc: { roc_auc: 0.924 } } },
    cell: { id: 1, lon: -119.48, lat: 35.41, distance_km: 1.4, county: "Kern" },
    site_cell: { suitability: { solar_pv: 0.31, onshore_wind: 0.09, battery: 0.44, gas_cc: 0.54 }, resource: { ghi_kwh_m2_day: 5.49, wind100_ms: 2.71 } },
    resource_basis: { source: "ERA5 reanalysis via the Open-Meteo archive", period: "2024", years: 1, grid_deg: 0.5, grid_km: 50, ghi_unit: "kWh/m2/day", wind_height_m: 100, wind_unit: "m/s" },
    queue_mw: 28894.9,
    ...over,
  };
}

function intel(extras = {}) {
  return {
    location: LOC,
    land_cover: {},
    air_quality: { aqi: 55, category: "Moderate", pollutant: "OZONE" },
    overlays: [],
    findings: [],
    provenance: [],
    extras: {
      nonattainment: [{ pollutant: "Ozone", naaqs: "2015 8-hour ozone", area: "San Joaquin Valley, CA", classification: "Extreme" }],
      nonattainment_available: true,
      ml: mlExtras(),
      grid_tiers: gridTiersExtras(),
      ...extras,
    },
  };
}

describe("feasibilityInput", () => {
  test("maps the voltage tiers, model signals and lookups Griddy already loads", () => {
    const s = feasibilityInput({ summary: summary(), view: view(), intel: intel() });
    assert.equal(s.grid[115].substation.value.distanceKm, 1.2);
    assert.equal(s.grid[69].substation.value.closerUntaggedKm, 0.3);
    assert.equal(s.grid[220].line.state, "confirmed_absent");
    assert.equal(s.sitingSimilarity.gas_cc.value, 0.54);
    assert.equal(s.sitingSimilarity.gas_cc.kind, "inferred");
    assert.equal(s.resource.ghi_annual_mean.value, 5.49);
    assert.equal(s.resource.wind_speed_hub.heightM, 100);
    assert.equal(s.resource.ghi_annual_mean.gridKm, 50);
    assert.equal(s.designations.value[0].classification, "Extreme");
    assert.equal(s.utility.value, "PG&E");
    assert.equal(s.queue.value.activeMw, 28_894.9);
    assert.equal(s.environmentalScreen.state, "unavailable");
    const r = grade(s, project({ technology: "natural_gas", capacityMw: 50 }));
    assert.equal(comp(r, "environment").score, 10); // Extreme ozone counts for gas
  });

  test("while site intel loads, the 220 kV tier comes from A's summary and the rest is loading", () => {
    const s = feasibilityInput({ summary: summary(), view: view(), intel: null, intelPending: true });
    assert.equal(s.grid[220].substation.value.distanceKm, 1.64);
    assert.equal(s.grid[115].substation.state, "loading");
    assert.equal(s.designations.state, "loading"); // never attainment while loading
    assert.equal(s.sitingSimilarity.solar_pv.state, "loading");
    assert.equal(grade(s, project({ capacityMw: 50 })).provisional, true);
    assert.equal(grade(s, project({ capacityMw: 500 })).components[0].status, "observed");
  });

  test("failed site intel is an error, not absence", () => {
    const s = feasibilityInput({ summary: summary(), view: view(), intel: null });
    assert.equal(s.designations.state, "error");
    assert.equal(s.grid[69].line.state, "error");
    assert.equal(grade(s, project({ technology: "natural_gas" })).components[2].score, 50);
  });

  test("outside California nothing reads as absence, attainment or zero people", () => {
    const s = feasibilityInput({
      summary: summary({ in_california: false, utility: null, balancing_authority: null }),
      view: view({ inCalifornia: false, utility: null, utilityTitle: null, balancingAuthority: null, balancingAuthorityTitle: null }),
      intel: intel({ nonattainment: [] }),
    });
    assert.equal(s.grid[220].substation.state, "outside_coverage");
    assert.equal(s.designations.state, "outside_coverage");
    assert.equal(s.population.state, "outside_coverage");
    assert.equal(s.sitingSimilarity.solar_pv.state, "outside_coverage");
    assert.equal(s.utility.state, "outside_coverage");
    const r = grade(s);
    assert.equal(comp(r, "grid").score, 50);
    assert.equal(comp(r, "administrative").score, 20); // definitive non-identification for this context metric
    assert.equal(r.constraints.assessment, "not_assessed");
  });

  test("layers that did not load are unresolved, not none found", () => {
    const s = feasibilityInput({ summary: summary({ missing_data: ["substations", "utilities", "population"] }), view: view({ population: null }), intel: intel({ grid_tiers: { available: false } }) });
    assert.equal(s.grid[220].substation.state, "unavailable");
    assert.equal(s.grid[115].substation.state, "unavailable");
    assert.equal(s.utility.state, "unavailable");
    assert.equal(s.population.state, "unavailable");
    assert.equal(feasibilityInput({ summary: summary(), view: view(), intel: intel({ nonattainment_available: false, nonattainment: [] }) }).designations.state, "unavailable");
  });

  test("an empty territory lookup inside California is a confirmed none", () => {
    const s = feasibilityInput({ summary: summary({ balancing_authority: null }), view: view({ balancingAuthority: null, balancingAuthorityTitle: null }), intel: intel() });
    assert.equal(s.balancingAuthority.state, "confirmed_absent");
    assert.equal(scoreAdministrative(s, POLICY).score, 60);
  });

  test("model signals from a far cell describe somewhere else", () => {
    const s = feasibilityInput({ summary: summary(), view: view(), intel: intel({ ml: mlExtras({ cell: { distance_km: 8 } }) }) });
    assert.equal(s.sitingSimilarity.solar_pv.state, "unavailable");
    assert.match(s.sitingSimilarity.solar_pv.reason, /8\.0 km/);
  });

  test("a late site-intel answer for an earlier click is ignored", () => {
    const old = intel();
    assert.equal(intelFor(old, LOC), old);
    assert.equal(intelFor(old, { lon: LOC.lon + 0.2, lat: LOC.lat }), null);
    assert.equal(intelFor(null, LOC), null);
    assert.equal(intelFor(old, null), null);
  });
});
