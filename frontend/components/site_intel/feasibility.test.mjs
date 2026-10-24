// Tests for the data center feasibility score (feasibility.ts) and its input adapter
// (feasibilityInput.ts).  OWNER: workstream E (Site Intelligence).
// Run from frontend/:  node --test components/site_intel/feasibility.test.mjs
// Node >= 22.18 runs the .ts modules directly (type stripping), so there is no test framework or
// build step to install. backend/tests/test_site_intel_feasibility.py runs this file inside pytest.
// Assertions check ranges, invariants and component behavior, not exact totals.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  COMPONENT_KEYS,
  DEFAULT_LOAD_MW,
  FORMULA,
  GENERATION_LOAD_MULTIPLE,
  GRID_ZERO_KM,
  MUST_HAVE_CAP,
  NEUTRAL_SCORE,
  QUEUE_HIGH_MW,
  QUEUE_ZERO_MW,
  WEIGHTS,
  calculateFeasibilityScore,
  categoryFor,
  cleanBuildScore,
  communityScore,
  completenessLabelFor,
  demandPressure,
  designationScore,
  distanceScore,
  queueScore,
  scoreAirPermitting,
  scoreCommunity,
  scoreGeneration,
  scoreGridProximity,
  scoreInfrastructure,
} from "./feasibility.ts";
import { feasibilityInput } from "./feasibilityInput.ts";

const identified = (name) => ({ status: "identified", name });
const NONE = { status: "none" };
const UNKNOWN = { status: "unknown" };
const kv230 = (distanceKm, name = "Asset") => ({ name, voltageKv: 230, distanceKm });

/** Model signals as feasibilityInput maps E's extras.ml (Bay Area-like queue and resources). */
function mlSignals(over = {}) {
  return {
    artifactId: "sites-model-test",
    rocAuc: { solar_pv: 0.94, onshore_wind: 0.96, battery: 0.96 },
    cellKm: 1.2,
    county: "Alameda",
    queueMw: 2400,
    cleanBuild: { solar_pv: 0.9, onshore_wind: 0.85, battery: 0.97 },
    demand: {
      forecastId: "forecast-test",
      scenario: "mid",
      year: 2035,
      baseYear: 2024,
      regionName: "PG&E area (CAISO)",
      basePeakP50Mw: 19584,
      peakP50Mw: 23437,
      mapeP50Pct: 8.7,
      coverage: 0.5,
    },
    ...over,
  };
}

/** A fully observed California site; override pieces per test. */
function site(over = {}) {
  return {
    substation: kv230(3, "Tesla"),
    line: kv230(3, "Tesla-Metcalf"),
    generation: { plantCount: 12, byFuelMw: { gas: 800, solar: 400, battery: 128 }, totalMw: 1328 },
    population: 1000,
    designations: [],
    aqi: { aqi: 42, category: "Good", pollutant: "PM2.5" },
    utility: identified("PG&E"),
    balancingAuthority: identified("CAISO"),
    outsideCoverage: false,
    reasons: {},
    ml: mlSignals(),
    ...over,
  };
}

const NOTHING = {
  substation: null,
  line: null,
  generation: null,
  population: null,
  designations: null,
  aqi: null,
  utility: UNKNOWN,
  balancingAuthority: UNKNOWN,
  outsideCoverage: false,
};

const comp = (r, key) => r.components.find((c) => c.key === key);
const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

/** Must hold for every result. */
function invariants(r) {
  assert.ok(Number.isFinite(r.overallScoreRaw), "finite score");
  assert.ok(r.overallScoreRaw >= 0 && r.overallScoreRaw <= 100, `score ${r.overallScoreRaw} in 0-100`);
  assert.equal(r.overallScore, Math.round(r.overallScoreRaw * 10) / 10); // displayed to the nearest tenth
  assert.equal(r.components.length, 5);
  const sum = r.components.reduce((a, c) => a + c.weightedContribution, 0);
  close(sum, r.pointsTotal); // contributions reconcile with the points total
  if (r.cap) {
    assert.equal(r.overallScoreRaw, r.cap.limit); // the cap only ever lowers the grade
    assert.ok(r.pointsTotal > r.cap.limit);
    assert.ok(r.seriousConstraints.some((t) => /capped/.test(t)));
  } else close(r.overallScoreRaw, r.pointsTotal);
  for (const c of r.components) {
    assert.ok(Number.isFinite(c.score) && c.score >= 0 && c.score <= 100, `${c.key} score ${c.score}`);
    close(c.weightedContribution, c.score * c.weight);
    if (c.status === "unavailable") assert.equal(c.score, NEUTRAL_SCORE);
    if (c.status !== "observed") assert.ok(c.missingFields.length > 0, `${c.key} lists what is missing`);
  }
  assert.ok(r.dataCompletenessPercent >= 0 && r.dataCompletenessPercent <= 100);
  assert.ok(r.considerations.some((c) => c.tone === "caveat" && /grid capacity has not been verified/i.test(c.text)));
}

describe("weights and labels", () => {
  test("component weights sum to 100%", () => {
    close(Object.values(WEIGHTS).reduce((a, w) => a + w, 0), 1);
    assert.deepEqual(COMPONENT_KEYS, ["grid", "generation", "community", "air", "infrastructure"]);
  });

  test("land is not a component; I was reduced and its share went to G and P", () => {
    assert.ok(!COMPONENT_KEYS.includes("land"));
    assert.deepEqual(WEIGHTS, { grid: 0.36, generation: 0.25, community: 0.17, air: 0.17, infrastructure: 0.05 });
    assert.equal(FORMULA, "0.36 G + 0.25 P + 0.17 C + 0.17 A + 0.05 I");
  });

  test("category bands use the displayed (rounded) score", () => {
    assert.equal(categoryFor(100), "Favorable preliminary screening");
    assert.equal(categoryFor(80), "Favorable preliminary screening");
    assert.equal(categoryFor(79.9), "Moderately favorable");
    assert.equal(categoryFor(79), "Moderately favorable");
    assert.equal(categoryFor(60), "Moderately favorable");
    assert.equal(categoryFor(59), "Mixed constraints");
    assert.equal(categoryFor(40), "Mixed constraints");
    assert.equal(categoryFor(39), "Challenging");
    assert.equal(categoryFor(20), "Challenging");
    assert.equal(categoryFor(19), "Highly constrained");
    assert.equal(categoryFor(0), "Highly constrained");
  });

  test("completeness labels", () => {
    assert.equal(completenessLabelFor(100), "High");
    assert.equal(completenessLabelFor(80), "High");
    assert.equal(completenessLabelFor(79), "Moderate");
    assert.equal(completenessLabelFor(50), "Moderate");
    assert.equal(completenessLabelFor(49), "Low");
    assert.equal(completenessLabelFor(0), "Low");
  });
});

describe("grid connection proximity", () => {
  test("1. nearby 230 kV substation and line score high", () => {
    const g = scoreGridProximity(kv230(1), kv230(0.5));
    close(g.score, 0.6 * distanceScore(1) + 0.4 * distanceScore(0.5)); // no queue signal: the 60/40 split
    assert.ok(g.score > 90);
    assert.equal(g.status, "observed");
  });

  test("the distance scale reaches 0 at 20 km", () => {
    assert.equal(GRID_ZERO_KM, 20);
    assert.equal(distanceScore(0), 100);
    close(distanceScore(10), 50);
    assert.equal(distanceScore(20), 0);
  });

  test("2. both assets far away score 0, never negative", () => {
    const g = scoreGridProximity(kv230(74), kv230(72));
    assert.equal(g.score, 0);
    assert.equal(g.status, "observed");
    assert.equal(distanceScore(50), 0);
    assert.equal(distanceScore(500), 0);
  });

  test("12. zero distance scores 100", () => {
    assert.equal(scoreGridProximity(kv230(0), kv230(0)).score, 100);
  });

  test("one missing distance: the other carries the full weight (renormalized)", () => {
    const g = scoreGridProximity(kv230(10), null);
    close(g.score, distanceScore(10));
    assert.equal(g.status, "partial");
    assert.equal(g.metrics.find((m) => m.id === "substation").effectiveWeight, 1);
    assert.ok(g.missingFields.some((f) => /line/.test(f)));
  });

  test("12. missing distances are not 0 km: both missing is a neutral 50, not 100", () => {
    const g = scoreGridProximity(null, null, "substation layer did not load");
    assert.equal(g.score, NEUTRAL_SCORE);
    assert.equal(g.status, "unavailable");
    assert.ok(g.missingFields.filter((f) => /Distance/.test(f)).every((f) => f.includes("substation layer did not load")));
    const nullKm = scoreGridProximity(kv230(null), kv230(undefined));
    assert.equal(nullKm.score, NEUTRAL_SCORE);
  });

  test("12. negative or non-finite distances are invalid, not 0 km", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "3"]) {
      const g = scoreGridProximity(kv230(bad), kv230(bad));
      assert.equal(g.status, "unavailable", `distance ${bad}`);
      assert.equal(g.score, NEUTRAL_SCORE);
    }
  });

  test("a lower-voltage asset is never substituted for a 220 kV+ one", () => {
    const g = scoreGridProximity({ name: "Local", voltageKv: 115, distanceKm: 1 }, kv230(40));
    assert.equal(g.status, "partial");
    close(g.score, distanceScore(40));
    assert.ok(g.missingFields.some((f) => /115 kV/.test(f)));
  });

  test("notes say distances are straight-line and capacity is unverified", () => {
    const notes = scoreGridProximity(kv230(3), kv230(3)).notes.join(" ");
    assert.match(notes, /straight-line/i);
    assert.match(notes, /does not establish spare capacity/i);
  });
});

describe("nearby generation", () => {
  test("3. substantial generation meets 5 x the load; batteries are not generation", () => {
    const p = scoreGeneration({ plantCount: 12, byFuelMw: { gas: 800, solar: 400, battery: 128 }, totalMw: 1328 }, 100);
    const [cap, mix] = p.metrics;
    assert.equal(cap.score, 100);
    assert.match(cap.value, /^1,200 MW/); // 1,328 MW nameplate minus 128 MW of batteries
    close(mix.score, (100 * 400) / 1200);
    close(p.score, 0.8 * 100 + 0.2 * ((100 * 400) / 1200)); // no similarity signal: the 80/20 split
    assert.equal(p.status, "observed");
    assert.ok(p.context.some((f) => /Battery/.test(f.label)));
    assert.match(p.notes.join(" "), /does not establish deliverable capacity/);
  });

  test("4. no operating plants within 25 km scores 0 and omits the mix", () => {
    const p = scoreGeneration({ plantCount: 0, byFuelMw: {}, totalMw: 0 });
    assert.equal(p.score, 0);
    assert.equal(p.status, "observed");
    assert.equal(p.metrics[1].state, "not_applicable");
  });

  test("storage-only capacity counts as no generation", () => {
    const p = scoreGeneration({ plantCount: 1, byFuelMw: { battery: 250 }, totalMw: 250 });
    assert.equal(p.score, 0);
  });

  test("unknown and other fuels count as not lower-carbon", () => {
    const p = scoreGeneration({ plantCount: 2, byFuelMw: { other: 100, solar: 100 }, totalMw: 200 }, 100);
    close(p.metrics[1].score, 50);
  });

  test("11. a configurable load changes only the load-dependent capacity term", () => {
    const gen = { plantCount: 3, byFuelMw: { solar: 500 }, totalMw: 500 };
    const at100 = calculateFeasibilityScore(site({ generation: gen, ml: null }), 100);
    const at1000 = calculateFeasibilityScore(site({ generation: gen, ml: null }), 1000);
    assert.equal(GENERATION_LOAD_MULTIPLE, 5);
    assert.equal(comp(at100, "generation").metrics[0].score, 100); // 500 MW = 5 x 100 MW
    close(comp(at1000, "generation").metrics[0].score, 10); // 500 of 5,000 MW
    close(comp(at1000, "generation").score, 0.8 * 10 + 0.2 * 100);
    for (const key of COMPONENT_KEYS.filter((k) => k !== "generation")) assert.equal(comp(at100, key).score, comp(at1000, key).score, key);
    assert.ok(at1000.overallScoreRaw < at100.overallScoreRaw);
    assert.equal(at1000.targetLoadMw, 1000);
    invariants(at100);
    invariants(at1000);
  });

  test("the load defaults to 100 MW and an invalid load falls back to it", () => {
    const gen = { plantCount: 1, byFuelMw: { gas: 250 }, totalMw: 250 };
    close(scoreGeneration(gen).metrics[0].score, 50); // 250 of 5 x 100 MW
    assert.equal(calculateFeasibilityScore(site()).targetLoadMw, DEFAULT_LOAD_MW);
    for (const bad of [0, -20, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = calculateFeasibilityScore(site({ generation: gen }), bad);
      assert.equal(r.targetLoadMw, DEFAULT_LOAD_MW, `load ${bad}`);
      assert.ok(r.explanatoryNotes.some((n) => /invalid/.test(n)));
      invariants(r);
    }
  });

  test("8. a missing fuel mix drops out and the component is partial", () => {
    const p = scoreGeneration({ plantCount: 4, byFuelMw: null, totalMw: 300 }, 100);
    close(p.score, 60); // capacity only (300 of 500 MW), renormalized
    assert.equal(p.status, "partial");
    assert.equal(p.metrics[1].state, "missing");
  });

  test("12. missing generation data is a neutral 50, not 0 MW", () => {
    const p = scoreGeneration(null, 100, "plant layer did not load");
    assert.equal(p.score, NEUTRAL_SCORE);
    assert.equal(p.status, "unavailable");
    assert.ok(p.missingFields[0].includes("plant layer did not load"));
  });

  test("totals from a capped plant list are partial", () => {
    assert.equal(scoreGeneration({ plantCount: 30, byFuelMw: null, totalMw: 900, incomplete: true }).status, "partial");
  });

  test("invalid fuel capacities are skipped, not counted", () => {
    const p = scoreGeneration({ plantCount: 2, byFuelMw: { gas: -50, solar: 200 }, totalMw: 200 }, 100);
    close(p.metrics[0].score, 40);
    assert.equal(p.status, "partial");
  });
});

describe("community impact", () => {
  test("5. a large nearby population scores low but stays in range", () => {
    const c = scoreCommunity(338_000);
    assert.ok(c.score > 0 && c.score < 10, `score ${c.score}`);
    assert.equal(communityScore(500_000), 0);
    assert.equal(communityScore(5_000_000), 0);
  });

  test("12. zero population scores 100 and more people always score lower", () => {
    assert.equal(scoreCommunity(0).score, 100);
    let prev = Infinity;
    for (const n of [0, 10, 1_000, 50_000, 200_000, 400_000]) {
      const s = communityScore(n);
      assert.ok(s < prev || (s === 0 && prev === 0));
      prev = s;
    }
  });

  test("8, 12. missing or negative population is a neutral 50, not zero people", () => {
    for (const bad of [null, -5, Number.NaN]) {
      const c = scoreCommunity(bad);
      assert.equal(c.score, NEUTRAL_SCORE, `population ${bad}`);
      assert.equal(c.status, "unavailable");
    }
  });

  test("labels it an exposure proxy and states what it does not measure", () => {
    const c = scoreCommunity(1000);
    assert.match(c.metrics[0].label, /exposure proxy/i);
    assert.match(c.notes.join(" "), /consent.*environmental justice/);
  });
});

describe("air quality and permitting", () => {
  const d = (classification, naaqs = "2015 8-hour ozone", pollutant = "Ozone") => ({ pollutant, naaqs, area: "Somewhere, CA", classification });

  test("no listed nonattainment scores 100", () => {
    const a = scoreAirPermitting([], null);
    assert.equal(a.score, 100);
    assert.equal(a.status, "observed");
  });

  test("6. one designation scores by its classification", () => {
    assert.equal(scoreAirPermitting([d("Marginal")], null).score, 70);
    assert.equal(designationScore("Marginal (Rural Transport)"), 70);
    assert.equal(designationScore("Moderate"), 50);
    assert.equal(designationScore("Serious"), 30);
    assert.equal(designationScore("Severe 15"), 10);
    assert.equal(designationScore("Extreme"), 10);
    assert.equal(designationScore("toString"), null);
  });

  test("7. multiple designations count once, at the lowest score", () => {
    const sjv = [d("Extreme", "2015 8-hour ozone"), d("Serious", "2012 annual PM2.5", "PM2.5"), d("Extreme", "2008 8-hour ozone")];
    const a = scoreAirPermitting(sjv, null);
    assert.equal(a.score, 10);
    assert.equal(scoreAirPermitting([d("Moderate", "2006 24-hour PM2.5", "PM2.5"), d("Marginal")], null).score, 50);
    const r = calculateFeasibilityScore(site({ designations: sjv }));
    close(comp(r, "air").weightedContribution, 10 * WEIGHTS.air); // one component, not one per pollutant
    invariants(r);
  });

  test("an unrecognized classification is neutral 50 and marks the component partial", () => {
    const a = scoreAirPermitting([d(null), d("Marginal")], null);
    assert.equal(a.score, 50);
    assert.equal(a.status, "partial");
  });

  test("the current AQI is context only and never changes the score", () => {
    const clean = scoreAirPermitting([d("Serious")], { aqi: 20, category: "Good", pollutant: "O3" });
    const smoky = scoreAirPermitting([d("Serious")], { aqi: 180, category: "Unhealthy", pollutant: "PM2.5" });
    const none = scoreAirPermitting([d("Serious")], null);
    assert.equal(clean.score, smoky.score);
    assert.equal(clean.score, none.score);
    assert.equal(none.status, "observed"); // a missing AQI does not reduce completeness
    assert.ok(smoky.context.some((f) => /AQI/.test(f.label) && /180/.test(f.value)));
  });

  test("missing designation data is a neutral 50, not attainment", () => {
    const a = scoreAirPermitting(null, { aqi: 30, category: "Good", pollutant: "O3" }, "EPA designation data did not load");
    assert.equal(a.score, NEUTRAL_SCORE);
    assert.equal(a.status, "unavailable");
    assert.match(a.notes.join(" "), /does not by itself prohibit/);
    assert.match(a.notes.join(" "), /Not legal or regulatory advice/);
  });
});

describe("local infrastructure support", () => {
  test("both identified 100, one 60, neither 20", () => {
    assert.equal(scoreInfrastructure(identified("PG&E"), identified("CAISO"), false).score, 100);
    assert.equal(scoreInfrastructure(identified("PG&E"), NONE, false).score, 60);
    assert.equal(scoreInfrastructure(NONE, identified("BANC"), false).score, 60);
    const neither = scoreInfrastructure(NONE, NONE, false);
    assert.equal(neither.score, 20);
    assert.equal(neither.status, "observed");
  });

  test("9. confirmed outside coverage scores 20 as observed data", () => {
    const i = scoreInfrastructure(NONE, NONE, true);
    assert.equal(i.score, 20);
    assert.equal(i.status, "observed");
    assert.ok(i.metrics.every((m) => /outside California/.test(m.value)));
  });

  test("territories that could not be determined are a neutral 50, not 20", () => {
    const i = scoreInfrastructure(UNKNOWN, UNKNOWN, false, "territory layer did not load");
    assert.equal(i.score, NEUTRAL_SCORE);
    assert.equal(i.status, "unavailable");
    const half = scoreInfrastructure(identified("PG&E"), UNKNOWN, false);
    assert.equal(half.status, "partial");
    assert.equal(half.score, 100); // the known lookup carries the weight
  });
});

describe("overall score", () => {
  test("a fully observed site has full completeness and no qualification", () => {
    const r = calculateFeasibilityScore(site());
    invariants(r);
    assert.equal(r.dataCompletenessPercent, 100);
    assert.equal(r.completenessLabel, "High");
    assert.equal(r.qualification, null);
    assert.ok(COMPONENT_KEYS.every((k) => r.componentStatuses[k] === "observed"));
    assert.deepEqual(r.missingFields, []);
  });

  test("10. every component unavailable: neutral 50, 0% complete, qualified", () => {
    const r = calculateFeasibilityScore(NOTHING);
    invariants(r);
    assert.equal(r.overallScore, 50);
    assert.equal(r.dataCompletenessPercent, 0);
    assert.equal(r.partialPercent, 0);
    assert.equal(r.completenessLabel, "Low");
    assert.ok(COMPONENT_KEYS.every((k) => r.componentStatuses[k] === "unavailable"));
    assert.match(r.qualification, /Low data completeness \(0%\)/);
    assert.ok(r.missingFields.length >= COMPONENT_KEYS.length);
  });

  test("8. missing population, AQI and fuel mix lower completeness, not the scores", () => {
    const r = calculateFeasibilityScore(site({ population: null, aqi: null, generation: { plantCount: 4, byFuelMw: null, totalMw: 500 } }));
    invariants(r);
    assert.equal(r.componentStatuses.community, "unavailable");
    assert.equal(r.componentStatuses.generation, "partial");
    assert.equal(r.componentStatuses.air, "observed"); // the AQI is context only
    close(r.dataCompletenessPercent, 58); // grid 36 + air 17 + infrastructure 5
    close(r.partialPercent, 25);
    assert.equal(r.completenessLabel, "Moderate");
    assert.ok(r.qualification);
  });

  test("a favorable score resting on little data is visibly qualified", () => {
    const r = calculateFeasibilityScore({ ...NOTHING, substation: kv230(0), line: kv230(0) });
    assert.ok(r.overallScore >= 60);
    assert.equal(r.completenessLabel, "Low");
    assert.match(r.qualification, /not reliable/);
  });

  test("12. missing values never act as 0 km, 0 people or 0 MW", () => {
    const missing = calculateFeasibilityScore(NOTHING);
    const zeros = calculateFeasibilityScore({ ...NOTHING, substation: kv230(0), line: kv230(0), population: 0, generation: { plantCount: 0, byFuelMw: {}, totalMw: 0 } });
    assert.equal(comp(missing, "grid").score, 50);
    assert.equal(comp(zeros, "grid").score, 100);
    assert.equal(comp(missing, "community").score, 50);
    assert.equal(comp(zeros, "community").score, 100);
    assert.equal(comp(missing, "generation").score, 50);
    assert.equal(comp(zeros, "generation").score, 0);
  });

  test("a serious constraint stays visible under a favorable overall score", () => {
    const r = calculateFeasibilityScore(
      site({
        substation: kv230(0),
        line: kv230(0),
        population: 0,
        generation: { plantCount: 1, byFuelMw: { solar: 500 }, totalMw: 500 },
        designations: [{ pollutant: "Ozone", naaqs: "2015 8-hour ozone", area: "San Joaquin Valley, CA", classification: "Extreme" }],
        ml: mlSignals({ queueMw: 50 }),
      }),
    );
    invariants(r);
    assert.ok(r.overallScore >= 80, `score ${r.overallScore}`);
    assert.ok(r.seriousConstraints.some((t) => /Extreme/.test(t)));
  });

  test("results are deterministic and the input is not mutated", () => {
    const input = site({ designations: [{ pollutant: "PM2.5", naaqs: "2006 24-hour PM2.5", area: "X", classification: "Moderate" }] });
    const before = structuredClone(input);
    assert.deepEqual(calculateFeasibilityScore(input, 250), calculateFeasibilityScore(input, 250));
    assert.deepEqual(input, before);
  });

  test("scores stay in range across many input combinations", () => {
    const kms = [null, 0, 2.5, 19.9, 20, 49.9, 300, -3];
    const pops = [null, 0, 12, 338_000, 9_000_000];
    const gens = [null, { plantCount: 0, byFuelMw: {}, totalMw: 0 }, { plantCount: 5, byFuelMw: { wind: 30, gas: 70 }, totalMw: 100 }];
    const desigs = [null, [], [{ pollutant: "Ozone", naaqs: "x", area: null, classification: "Severe 15" }]];
    const mls = [
      null,
      mlSignals(),
      mlSignals({ queueMw: 0, cleanBuild: { solar_pv: 1, onshore_wind: 1, battery: 1 } }),
      mlSignals({ queueMw: 50_000, cleanBuild: { solar_pv: 0, onshore_wind: 0, battery: 0 } }),
      mlSignals({ queueMw: -5, cleanBuild: { solar_pv: Number.NaN, onshore_wind: null, battery: 2 }, demand: null }),
    ];
    for (const km of kms)
      for (const population of pops)
        for (const generation of gens)
          for (const designations of desigs)
            for (const ml of mls) invariants(calculateFeasibilityScore(site({ substation: kv230(km), line: kv230(km), population, generation, designations, ml }), 75));
  });
});

describe("example sites (qualitative)", () => {
  test("A. Mendocino-like: far from the grid, few people", () => {
    const r = calculateFeasibilityScore(
      site({
        substation: kv230(74),
        line: kv230(72),
        generation: { plantCount: 0, byFuelMw: {}, totalMw: 0 },
        population: 0,
        ml: mlSignals({ county: "Mendocino", queueMw: 0, cleanBuild: { solar_pv: 0.01, onshore_wind: 0.02, battery: 0.01 } }),
      }),
    );
    invariants(r);
    assert.ok(comp(r, "grid").score < 30); // an empty queue can't make up for 70 km to the grid
    assert.ok(comp(r, "generation").score < 10);
    assert.ok(comp(r, "community").score > 90);
    assert.equal(r.overallScore, MUST_HAVE_CAP); // capped: high community and air scores don't offset it
    assert.ok(r.seriousConstraints.length >= 3); // both 220 kV+ assets 20 km or more away, and the cap
  });

  test("B. Alameda-like: close to the grid, many people, nonattainment", () => {
    const r = calculateFeasibilityScore(
      site({
        substation: kv230(3),
        line: kv230(3),
        generation: { plantCount: 25, byFuelMw: { gas: 1100, solar: 150, battery: 78 }, totalMw: 1328 },
        population: 338_000,
        designations: [
          { pollutant: "Ozone", naaqs: "2015 8-hour ozone", area: "San Francisco Bay Area, CA", classification: "Marginal" },
          { pollutant: "Ozone", naaqs: "2008 8-hour ozone", area: "San Francisco Bay Area, CA", classification: "Marginal" },
          { pollutant: "PM2.5", naaqs: "2006 24-hour PM2.5", area: "San Francisco Bay Area, CA", classification: "Moderate" },
        ],
      }),
    );
    invariants(r);
    assert.ok(comp(r, "grid").score > 60 && comp(r, "grid").score < 90, `grid ${comp(r, "grid").score}`); // close, but a 2.4 GW county queue
    assert.ok(comp(r, "generation").score > 80);
    assert.ok(comp(r, "community").score < 10);
    assert.ok(comp(r, "air").score < 100);
    assert.ok(r.considerations.some((c) => c.group === "community" && c.tone === "tradeoff" && /people/.test(c.text)));
    assert.ok(r.considerations.some((c) => c.group === "community" && /nonattainment/.test(c.text)));
  });
});

describe("model signals (queue, clean-build similarity, demand pressure)", () => {
  const scores = (r) => ({ raw: r.overallScoreRaw, components: r.componentScores, statuses: r.componentStatuses, completeness: r.dataCompletenessPercent });

  test("the grade is unchanged when ml is null, absent or from a cell over 5 km away", () => {
    const noKey = site();
    delete noKey.ml;
    const none = scores(calculateFeasibilityScore(site({ ml: null })));
    assert.deepEqual(scores(calculateFeasibilityScore(noKey)), none);
    assert.deepEqual(scores(calculateFeasibilityScore(site({ ml: mlSignals({ cellKm: 6 }) }))), none);
    assert.deepEqual(scores(calculateFeasibilityScore(site({ ml: mlSignals(), outsideCoverage: true }))).components.grid, none.components.grid);
    // and without them the rules keep their original proportions
    const r = calculateFeasibilityScore(site({ ml: null }));
    close(comp(r, "grid").score, 0.6 * distanceScore(3) + 0.4 * distanceScore(3));
    assert.ok(r.considerations.some((c) => c.group === "data" && /Model signals.*not available/.test(c.text)));
  });

  test("missing model signals lower neither completeness nor the component status", () => {
    const r = calculateFeasibilityScore(site({ ml: null }));
    invariants(r);
    assert.equal(r.dataCompletenessPercent, 100);
    assert.equal(comp(r, "grid").status, "observed");
    assert.equal(comp(r, "generation").status, "observed");
    assert.equal(comp(r, "grid").metrics.find((m) => m.id === "queue").state, "missing");
  });

  test("model signals never stand in for a component's own missing data", () => {
    const r = calculateFeasibilityScore({ ...NOTHING, ml: mlSignals({ queueMw: 0, cleanBuild: { solar_pv: 1, onshore_wind: 1, battery: 1 } }) });
    invariants(r);
    assert.equal(comp(r, "grid").score, NEUTRAL_SCORE);
    assert.equal(comp(r, "grid").status, "unavailable");
    assert.equal(comp(r, "generation").score, NEUTRAL_SCORE);
    assert.equal(r.overallScore, 50);
  });

  test("Q falls from 100 at an empty queue to 0 at 30 GW, never rising", () => {
    assert.equal(queueScore(0), 100);
    assert.equal(queueScore(QUEUE_ZERO_MW), 0);
    assert.equal(queueScore(80_000), 0);
    let prev = Infinity;
    for (const q of [0, 10, 100, 458, 2_400, 10_000, 28_895, 40_000]) {
      const s = queueScore(q);
      assert.ok(s >= 0 && s <= 100 && s <= prev, `queue ${q} → ${s}`);
      prev = s;
    }
  });

  test("more queue congestion never raises the grade", () => {
    for (const km of [1, 8, 25]) {
      let prev = Infinity;
      for (const q of [0, 300, 2_000, 9_999, 10_000, 20_000, 29_000, 60_000]) {
        const r = calculateFeasibilityScore(site({ substation: kv230(km), line: kv230(km), ml: mlSignals({ queueMw: q }) }));
        invariants(r);
        assert.ok(r.overallScoreRaw <= prev + 1e-9, `${km} km, queue ${q}: ${r.overallScoreRaw} > ${prev}`);
        prev = r.overallScoreRaw;
      }
    }
  });

  test("the queue only penalizes: an empty one can't lift a far site, a full one takes at most 25%", () => {
    const g = (km, ml) => comp(calculateFeasibilityScore(site({ substation: kv230(km), line: kv230(km), ml })), "grid");
    assert.equal(g(40, mlSignals({ queueMw: 0 })).score, 0);
    assert.equal(g(5, mlSignals({ queueMw: 0 })).score, g(5, null).score); // empty queue: no penalty
    close(g(0, mlSignals({ queueMw: QUEUE_ZERO_MW })).score, 75);
    const full = g(0, mlSignals({ queueMw: QUEUE_ZERO_MW }));
    close(full.metrics.find((m) => m.id === "queue").effectiveWeight, 0.25); // what it took off
    assert.match(full.explanation, /takes 25% off/);
  });

  test("a congested queue is a tradeoff that asks for a utility study", () => {
    const r = calculateFeasibilityScore(site({ ml: mlSignals({ county: "Kern", queueMw: 28_895 }) }));
    assert.ok(28_895 >= QUEUE_HIGH_MW);
    assert.ok(r.considerations.some((c) => c.tone === "tradeoff" && /Congested interconnection queue/.test(c.text) && /utility interconnection study/.test(c.text)));
    const calm = calculateFeasibilityScore(site({ ml: mlSignals({ queueMw: 300 }) }));
    assert.ok(!calm.considerations.some((c) => /Congested/.test(c.text)));
  });

  test("clean-build similarity: better resources never lower P, and gas is not part of it", () => {
    assert.equal(cleanBuildScore({ solar_pv: 0, onshore_wind: 0, battery: 0 }), 0);
    assert.equal(cleanBuildScore({ solar_pv: 1, onshore_wind: 0, battery: 1 }), 100);
    close(cleanBuildScore({ solar_pv: 0.2, onshore_wind: 0.8, battery: 0.4 }), 100 * (0.75 * 0.8 + 0.25 * 0.4));
    assert.equal(cleanBuildScore({ solar_pv: null, onshore_wind: null, battery: null }), null);
    close(cleanBuildScore({ solar_pv: null, onshore_wind: 0.6, battery: null }), 60); // a missing part drops out
    let prev = -Infinity;
    for (const v of [0, 0.1, 0.5, 0.9, 1]) {
      const p = comp(calculateFeasibilityScore(site({ ml: mlSignals({ cleanBuild: { solar_pv: v, onshore_wind: v, battery: v } }) })), "generation").score;
      assert.ok(p >= prev, `similarity ${v}`);
      prev = p;
    }
  });

  test("model metrics are labeled with their source, artifact and accuracy", () => {
    const r = calculateFeasibilityScore(site());
    const clean = comp(r, "generation").metrics.find((m) => m.id === "clean_build");
    assert.equal(clean.source.tag, "inferred (ML)");
    assert.match(clean.source.detail, /sites-model-test/);
    assert.match(clean.source.detail, /ROC-AUC solar 0\.94/);
    assert.match(clean.source.detail, /similarity score/i);
    const queue = comp(r, "grid").metrics.find((m) => m.id === "queue");
    assert.equal(queue.source.kind, "observed"); // LBNL data, carried by the artifact
    assert.match(queue.source.detail, /LBNL/);
    assert.match(comp(r, "generation").notes.join(" "), /not a feasibility/);
  });

  test("regional demand pressure is context only, from P50, and follows the load", () => {
    const d = mlSignals().demand;
    close(demandPressure(d, 100), (d.peakP50Mw - d.basePeakP50Mw + 100) / d.basePeakP50Mw);
    assert.ok(demandPressure(d, 1000) > demandPressure(d, 100));
    assert.equal(demandPressure({ ...d, basePeakP50Mw: 0 }, 100), null);
    const low = calculateFeasibilityScore(site({ ml: mlSignals({ demand: { ...d, peakP50Mw: d.basePeakP50Mw } }) }));
    const high = calculateFeasibilityScore(site({ ml: mlSignals({ demand: { ...d, peakP50Mw: d.basePeakP50Mw * 2 } }) }));
    assert.equal(low.overallScoreRaw, high.overallScoreRaw);
    const fact = comp(high, "grid").context.find((f) => /demand pressure/.test(f.label));
    assert.match(fact.label, /inferred \(ML\), context only/);
    assert.match(fact.value, /P50/);
  });
});

describe("must-have cap", () => {
  test("both 220 kV+ assets 20 km or more away cap the grade, whatever C and A score", () => {
    const far = calculateFeasibilityScore(site({ substation: kv230(25), line: kv230(22), population: 0, ml: mlSignals({ queueMw: 0 }) }));
    invariants(far);
    assert.ok(far.cap);
    assert.equal(far.overallScore, MUST_HAVE_CAP);
    assert.ok(far.pointsTotal > MUST_HAVE_CAP);
  });

  test("one asset within reach, or an unknown distance, means no cap", () => {
    assert.equal(calculateFeasibilityScore(site({ substation: kv230(25), line: kv230(12) })).cap, null);
    assert.equal(calculateFeasibilityScore(site({ substation: kv230(25), line: null })).cap, null); // missing is not "far"
    assert.equal(calculateFeasibilityScore(site({ substation: { name: "Local", voltageKv: 115, distanceKm: 1 }, line: kv230(30) })).cap, null);
  });

  test("a grade already under the cap is left alone", () => {
    const r = calculateFeasibilityScore(
      site({ substation: kv230(60), line: kv230(60), population: 2_000_000, generation: { plantCount: 0, byFuelMw: {}, totalMw: 0 }, designations: [{ pollutant: "Ozone", naaqs: "x", area: null, classification: "Extreme" }], ml: mlSignals({ queueMw: 29_000, cleanBuild: { solar_pv: 0, onshore_wind: 0, battery: 0 } }) }),
    );
    invariants(r);
    assert.equal(r.cap, null);
    assert.ok(r.overallScoreRaw < MUST_HAVE_CAP);
  });
});

// --- input adapter: A's summary (via readSummary's SiteView) + E's site intel ---

const LOC = { lon: -121.9, lat: 37.6 };

function view(over = {}) {
  return {
    county: "Alameda",
    utility: "PG&E",
    utilityTitle: "Pacific Gas & Electric (IOU)",
    balancingAuthority: "CAISO",
    balancingAuthorityTitle: "California Independent System Operator",
    inCalifornia: true,
    substations: [],
    hvSubstation: { id: "s1", name: "Newark", voltage_kv: 230, distance_km: 3.2, location: null, operator: "PG&E", osm_url: null },
    hvLine: { id: "l1", name: "Newark-Ravenswood", owner: "PG&E", voltage_kv: 230, distance_km: 2.9, point: null },
    anyLine: null,
    plants: [],
    plantsCount: 25,
    plantsTotalMw: 1328,
    plantsByFuel: [["gas", 1100], ["solar", 150], ["battery", 78]],
    population: 338_000,
    distanceMethod: null,
    ...over,
  };
}

function summary(extras = {}) {
  return {
    site: { id: "site", name: "Site in Alameda County, CA", location: LOC },
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
      ...extras,
    },
  };
}

function intel(over = {}, extras = {}) {
  return {
    location: LOC,
    land_cover: {},
    mean_slope_deg: 2.1,
    air_quality: { aqi: 55, category: "Moderate", pollutant: "OZONE" },
    overlays: [],
    findings: [
      { id: "land_protected", module: "site", severity: "warn", title: "Protected land nearby", detail: "" },
      { id: "land_slope", module: "site", severity: "pass", title: "Flat terrain", detail: "" },
      { id: "air_nonattainment", module: "site", severity: "warn", title: "Federal nonattainment area", detail: "" },
    ],
    provenance: [],
    extras: {
      nonattainment: [{ pollutant: "Ozone", naaqs: "2015 8-hour ozone", area: "San Francisco Bay Area, CA", classification: "Marginal" }],
      nonattainment_available: true,
      land_tier: "offline_area",
      ...extras,
    },
    ...over,
  };
}

/** extras.ml as backend/app/site_intel/ml.py returns it (values from the Alameda cell). */
function mlExtras(over = {}) {
  return {
    available: true,
    site_artifact: {
      id: "sites-model-20261024-111437",
      mode: "model",
      scenario: "mid",
      year: 2035,
      grid_spacing_km: 5,
      model_metrics: { solar_pv: { roc_auc: 0.937, pr_auc: 0.682 }, onshore_wind: { roc_auc: 0.963, pr_auc: 0.817 }, battery: { roc_auc: 0.959, pr_auc: 0.752 } },
    },
    cell: { id: 9564, lon: -121.8878, lat: 37.5789, distance_km: 2.59, county: "Alameda", geoid: "06001", region: "PGAE" },
    queue_mw: 2389.6,
    clean_build: {
      radius_km: 25,
      solar_pv: { best: 0.896, distance_km: 22.7 },
      onshore_wind: { best: 0.847, distance_km: 23.8 },
      battery: { best: 0.971, distance_km: 19.1 },
    },
    forecast: {
      artifact_id: "forecast-2024-20261024-105524",
      mode: "ml",
      scenario: "mid",
      year: 2035,
      base_year: 2024,
      region: { id: "PGAE", name: "PG&E area (CAISO)", base_peak_mw_p50: 19584.4, peak_mw_p50: 23437.2, peak_mw_p90: 26351.3 },
      county: { geoid: "06001", name: "Alameda", peak_mw_p50: 2100 },
      metrics: { mape_p50_pct: 8.68, p10_p90_coverage: 0.5, split: "test" },
    },
    ...over,
  };
}

describe("feasibilityInput", () => {
  test("maps the summary and intel fields Griddy already loads", () => {
    const input = feasibilityInput({ summary: summary(), view: view(), intel: intel() });
    assert.deepEqual(input.substation, { name: "Newark", voltageKv: 230, distanceKm: 3.2 });
    assert.equal(input.line.distanceKm, 2.9);
    assert.deepEqual(input.generation.byFuelMw, { gas: 1100, solar: 150, battery: 78 });
    assert.equal(input.generation.incomplete, false);
    assert.equal(input.population, 338_000);
    assert.equal(input.designations[0].classification, "Marginal");
    assert.equal(input.aqi.aqi, 55);
    assert.deepEqual(input.utility, identified("PG&E"));
    assert.deepEqual(input.balancingAuthority, identified("CAISO"));
    assert.equal(input.outsideCoverage, false);
    const r = calculateFeasibilityScore(input);
    invariants(r);
    assert.equal(r.dataCompletenessPercent, 100);
  });

  test("9. outside California: out-of-coverage data is missing, territories score 20", () => {
    const outside = view({ inCalifornia: false, utility: null, utilityTitle: null, balancingAuthority: null, balancingAuthorityTitle: null, population: null, plantsCount: 0, plantsByFuel: [] });
    const input = feasibilityInput({
      summary: summary({ in_california: false, utility: null, balancing_authority: null }),
      view: outside,
      intel: intel({ mean_slope_deg: null, findings: [] }, { nonattainment: [], land_tier: "unavailable" }),
    });
    assert.equal(input.outsideCoverage, true);
    assert.equal(input.substation, null);
    assert.equal(input.generation, null);
    assert.equal(input.population, null);
    assert.equal(input.designations, null); // an empty Green Book list outside CA is not attainment
    assert.match(input.reasons.air, /outside California/);
    assert.deepEqual(input.utility, NONE);
    const r = calculateFeasibilityScore(input);
    invariants(r);
    assert.equal(comp(r, "infrastructure").score, 20);
    assert.equal(comp(r, "infrastructure").status, "observed");
    for (const key of ["grid", "generation", "community", "air"]) assert.equal(r.componentStatuses[key], "unavailable", key);
    assert.equal(r.dataCompletenessPercent, 5);
    assert.equal(r.completenessLabel, "Low");
    assert.equal(input.ml, null); // no model signals outside California
    assert.match(input.mlReason, /outside California/);
  });

  test("a dataset that failed to load is unknown, not 'none found'", () => {
    const input = feasibilityInput({ summary: summary({ missing_data: ["substations", "utilities", "plants", "population"] }), view: view({ population: null }), intel: intel() });
    assert.equal(input.substation, null);
    assert.match(input.reasons.grid, /substation layer did not load/);
    assert.equal(input.line.distanceKm, 2.9);
    assert.deepEqual(input.utility, UNKNOWN);
    assert.equal(input.generation, null);
    assert.match(input.reasons.community, /population layer did not load/);
  });

  test("missing EPA designation data is unavailable, not attainment", () => {
    assert.equal(feasibilityInput({ summary: summary(), view: view(), intel: intel({}, { nonattainment_available: false, nonattainment: [] }) }).designations, null);
    assert.equal(feasibilityInput({ summary: summary(), view: view(), intel: intel({}, { nonattainment: undefined }) }).designations, null);
  });

  test("site intel that failed or is still loading leaves air quality missing", () => {
    const failed = feasibilityInput({ summary: summary(), view: view(), intel: null });
    assert.equal(failed.designations, null);
    assert.equal(failed.reasons.air, "site screening unavailable");
    const pending = feasibilityInput({ summary: summary(), view: view(), intel: null, intelPending: true });
    assert.equal(pending.reasons.air, "site screening still loading");
  });

  test("land screening (slope, land cover, flags) never changes the GriddyGrade", () => {
    const flat = calculateFeasibilityScore(feasibilityInput({ summary: summary(), view: view(), intel: intel() }));
    const steep = feasibilityInput({
      summary: summary(),
      view: view(),
      intel: intel({ mean_slope_deg: 25, land_cover: { "Built-up": 0.9 }, findings: [{ id: "land_protected", module: "site", severity: "fail", title: "Protected land", detail: "" }] }),
    });
    assert.ok(!("meanSlopeDeg" in steep) && !("landFlags" in steep));
    assert.deepEqual(calculateFeasibilityScore(steep), flat);
  });

  test("an older summary without the 25 km aggregate is partial", () => {
    const input = feasibilityInput({
      summary: summary({ plants_within_25km: undefined }),
      view: view({ plants: [{ id: "p", name: "P", fuel: "gas", capacity_mw: 300, distance_km: 4 }], plantsCount: 1, plantsTotalMw: 300, plantsByFuel: [["gas", 300]] }),
      intel: intel(),
    });
    assert.equal(input.generation.byFuelMw, null);
    assert.equal(input.generation.incomplete, true);
    assert.equal(scoreGeneration(input.generation).status, "partial");
  });

  test("an unmapped balancing authority is 'none' (assumed CAISO does not count)", () => {
    const input = feasibilityInput({ summary: summary({ balancing_authority: null }), view: view({ balancingAuthority: null, balancingAuthorityTitle: null }), intel: intel() });
    assert.deepEqual(input.balancingAuthority, NONE);
    assert.equal(calculateFeasibilityScore(input).componentScores.infrastructure, 60);
  });

  test("maps E's extras.ml onto the model signals", () => {
    const input = feasibilityInput({ summary: summary(), view: view(), intel: intel({}, { ml: mlExtras() }) });
    assert.equal(input.ml.artifactId, "sites-model-20261024-111437");
    assert.equal(input.ml.queueMw, 2389.6);
    assert.equal(input.ml.county, "Alameda");
    assert.equal(input.ml.cleanBuild.onshore_wind, 0.847);
    assert.equal(input.ml.rocAuc.solar_pv, 0.937);
    assert.equal(input.ml.demand.basePeakP50Mw, 19584.4);
    assert.equal(input.ml.demand.coverage, 0.5);
    const r = calculateFeasibilityScore(input);
    invariants(r);
    assert.equal(comp(r, "grid").metrics.find((m) => m.id === "queue").state, "observed");
  });

  test("model signals are null when absent, unavailable, out of state, too far or not loaded", () => {
    const cases = [
      [intel(), /not in the site screening/],
      [intel({}, { ml: { available: false, reason: "site-location artifact not found" } }), /artifact not found/],
      [intel({}, { ml: mlExtras({ cell: { ...mlExtras().cell, distance_km: 6.2 } }) }), /6\.2 km away/],
      [intel({}, { ml: mlExtras({ site_artifact: null }) }), /incomplete/],
      [null, /site screening unavailable/],
    ];
    const rulesOnly = calculateFeasibilityScore(feasibilityInput({ summary: summary(), view: view(), intel: intel() })).overallScoreRaw;
    for (const [i, reason] of cases) {
      const input = feasibilityInput({ summary: summary(), view: view(), intel: i });
      assert.equal(input.ml, null);
      assert.match(input.mlReason, reason);
      if (i) assert.equal(calculateFeasibilityScore(input).overallScoreRaw, rulesOnly); // missing drops out: the rules alone
    }
    const outside = feasibilityInput({ summary: summary({ in_california: false }), view: view({ inCalifornia: false }), intel: intel({}, { ml: mlExtras() }) });
    assert.equal(outside.ml, null);
  });

  test("a forecast without P50 values leaves the demand context out", () => {
    const f = mlExtras().forecast;
    const input = feasibilityInput({ summary: summary(), view: view(), intel: intel({}, { ml: mlExtras({ forecast: { ...f, region: { ...f.region, base_peak_mw_p50: null } } }) }) });
    assert.equal(input.ml.demand, null);
    assert.ok(input.ml.queueMw !== null);
  });

  test("without a site summary every summary-based input is unknown", () => {
    const input = feasibilityInput({ summary: null, view: null, intel: intel() });
    assert.equal(input.substation, null);
    assert.equal(input.generation, null);
    assert.deepEqual(input.utility, UNKNOWN);
    assert.equal(input.reasons.grid, "site summary not loaded");
    invariants(calculateFeasibilityScore(input));
  });
});
