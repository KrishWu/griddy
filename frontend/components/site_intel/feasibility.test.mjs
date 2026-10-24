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
  NEUTRAL_SCORE,
  WEIGHTS,
  calculateFeasibilityScore,
  categoryFor,
  communityScore,
  completenessLabelFor,
  designationScore,
  distanceScore,
  scoreAirPermitting,
  scoreCommunity,
  scoreGeneration,
  scoreGridProximity,
  scoreInfrastructure,
  scoreLand,
  slopeScore,
} from "./feasibility.ts";
import { feasibilityInput } from "./feasibilityInput.ts";

const identified = (name) => ({ status: "identified", name });
const NONE = { status: "none" };
const UNKNOWN = { status: "unknown" };
const kv230 = (distanceKm, name = "Asset") => ({ name, voltageKv: 230, distanceKm });

/** A fully observed California site; override pieces per test. */
function site(over = {}) {
  return {
    substation: kv230(3, "Tesla"),
    line: kv230(3, "Tesla-Metcalf"),
    generation: { plantCount: 12, byFuelMw: { gas: 800, solar: 400, battery: 128 }, totalMw: 1328 },
    population: 1000,
    designations: [],
    aqi: { aqi: 42, category: "Good", pollutant: "PM2.5" },
    meanSlopeDeg: 1.5,
    landFlags: [],
    utility: identified("PG&E"),
    balancingAuthority: identified("CAISO"),
    outsideCoverage: false,
    reasons: {},
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
  meanSlopeDeg: null,
  landFlags: [],
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
  assert.equal(r.overallScore, Math.round(r.overallScoreRaw));
  assert.equal(r.components.length, 6);
  const sum = r.components.reduce((a, c) => a + c.weightedContribution, 0);
  close(sum, r.overallScoreRaw); // contributions reconcile with the score
  assert.equal(Math.round(sum), r.overallScore);
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
    assert.deepEqual(COMPONENT_KEYS, ["grid", "generation", "community", "air", "land", "infrastructure"]);
  });

  test("category bands use the displayed (rounded) score", () => {
    assert.equal(categoryFor(100), "Favorable preliminary screening");
    assert.equal(categoryFor(80), "Favorable preliminary screening");
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
    const g = scoreGridProximity(kv230(3), kv230(2));
    close(g.score, 0.6 * distanceScore(3) + 0.4 * distanceScore(2));
    assert.ok(g.score > 90);
    assert.equal(g.status, "observed");
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
    assert.ok(g.missingFields.every((f) => f.includes("substation layer did not load")));
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
  test("3. substantial generation meets the load; batteries are not generation", () => {
    const p = scoreGeneration({ plantCount: 12, byFuelMw: { gas: 800, solar: 400, battery: 128 }, totalMw: 1328 }, 100);
    const [cap, mix] = p.metrics;
    assert.equal(cap.score, 100);
    assert.match(cap.value, /^1,200 MW/); // 1,328 MW nameplate minus 128 MW of batteries
    close(mix.score, (100 * 400) / 1200);
    close(p.score, 0.8 * 100 + 0.2 * ((100 * 400) / 1200));
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
    const at100 = calculateFeasibilityScore(site({ generation: gen }), 100);
    const at1000 = calculateFeasibilityScore(site({ generation: gen }), 1000);
    assert.equal(comp(at100, "generation").metrics[0].score, 100);
    close(comp(at1000, "generation").metrics[0].score, 50);
    close(comp(at1000, "generation").score, 0.8 * 50 + 0.2 * 100);
    for (const key of COMPONENT_KEYS.filter((k) => k !== "generation")) assert.equal(comp(at100, key).score, comp(at1000, key).score, key);
    assert.ok(at1000.overallScoreRaw < at100.overallScoreRaw);
    assert.equal(at1000.targetLoadMw, 1000);
    invariants(at100);
    invariants(at1000);
  });

  test("the load defaults to 100 MW and an invalid load falls back to it", () => {
    const gen = { plantCount: 1, byFuelMw: { gas: 50 }, totalMw: 50 };
    close(scoreGeneration(gen).metrics[0].score, 50);
    assert.equal(calculateFeasibilityScore(site()).targetLoadMw, DEFAULT_LOAD_MW);
    for (const bad of [0, -20, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = calculateFeasibilityScore(site({ generation: gen }), bad);
      assert.equal(r.targetLoadMw, DEFAULT_LOAD_MW, `load ${bad}`);
      assert.ok(r.explanatoryNotes.some((n) => /invalid/.test(n)));
      invariants(r);
    }
  });

  test("8. a missing fuel mix drops out and the component is partial", () => {
    const p = scoreGeneration({ plantCount: 4, byFuelMw: null, totalMw: 60 }, 100);
    close(p.score, 60); // capacity only, renormalized
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
    const p = scoreGeneration({ plantCount: 2, byFuelMw: { gas: -50, solar: 40 }, totalMw: 40 }, 100);
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
    close(comp(r, "air").weightedContribution, 10 * 0.15); // one component, not one per pollutant
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

describe("land suitability", () => {
  test("slope bands", () => {
    for (const [deg, score] of [[0, 100], [3, 100], [3.01, 80], [5, 80], [5.5, 50], [10, 50], [10.1, 20], [35, 20]]) {
      assert.equal(slopeScore(deg), score, `${deg} deg`);
      assert.equal(scoreLand(deg).score, score);
    }
  });

  test("8, 12. missing or negative slope is a neutral 50", () => {
    for (const bad of [null, -2]) {
      const l = scoreLand(bad);
      assert.equal(l.score, NEUTRAL_SCORE);
      assert.equal(l.status, "unavailable");
    }
  });

  test("screening flags are shown, not scored, and a fail is a serious constraint", () => {
    const flags = [{ severity: "fail", title: "Protected land" }];
    assert.equal(scoreLand(1, flags).score, scoreLand(1).score);
    const r = calculateFeasibilityScore(site({ landFlags: flags }));
    assert.ok(r.seriousConstraints.some((t) => /Protected land/.test(t)));
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

  test("10. all six components unavailable: neutral 50, 0% complete, qualified", () => {
    const r = calculateFeasibilityScore(NOTHING);
    invariants(r);
    assert.equal(r.overallScore, 50);
    assert.equal(r.dataCompletenessPercent, 0);
    assert.equal(r.partialPercent, 0);
    assert.equal(r.completenessLabel, "Low");
    assert.ok(COMPONENT_KEYS.every((k) => r.componentStatuses[k] === "unavailable"));
    assert.match(r.qualification, /Low data completeness \(0%\)/);
    assert.ok(r.missingFields.length >= 6);
  });

  test("8. missing slope, population, AQI and fuel mix lower completeness, not the scores", () => {
    const r = calculateFeasibilityScore(site({ meanSlopeDeg: null, population: null, aqi: null, generation: { plantCount: 4, byFuelMw: null, totalMw: 500 } }));
    invariants(r);
    assert.equal(r.componentStatuses.land, "unavailable");
    assert.equal(r.componentStatuses.community, "unavailable");
    assert.equal(r.componentStatuses.generation, "partial");
    assert.equal(r.componentStatuses.air, "observed"); // the AQI is context only
    close(r.dataCompletenessPercent, 55); // grid 30 + air 15 + infrastructure 10
    close(r.partialPercent, 20);
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
      site({ substation: kv230(0), line: kv230(0), population: 0, generation: { plantCount: 1, byFuelMw: { solar: 500 }, totalMw: 500 }, designations: [{ pollutant: "Ozone", naaqs: "2015 8-hour ozone", area: "San Joaquin Valley, CA", classification: "Extreme" }] }),
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
    const kms = [null, 0, 2.5, 49.9, 50, 300, -3];
    const pops = [null, 0, 12, 338_000, 9_000_000];
    const gens = [null, { plantCount: 0, byFuelMw: {}, totalMw: 0 }, { plantCount: 5, byFuelMw: { wind: 30, gas: 70 }, totalMw: 100 }];
    const desigs = [null, [], [{ pollutant: "Ozone", naaqs: "x", area: null, classification: "Severe 15" }]];
    for (const km of kms)
      for (const population of pops)
        for (const generation of gens)
          for (const designations of desigs)
            invariants(calculateFeasibilityScore(site({ substation: kv230(km), line: kv230(km), population, generation, designations }), 75));
  });
});

describe("example sites (qualitative)", () => {
  test("A. Mendocino-like: far from the grid, few people, no land data", () => {
    const r = calculateFeasibilityScore(
      site({ substation: kv230(74), line: kv230(72), generation: { plantCount: 0, byFuelMw: {}, totalMw: 0 }, population: 0, meanSlopeDeg: null, reasons: { land: "no land screening here" } }),
    );
    invariants(r);
    assert.ok(comp(r, "grid").score < 10);
    assert.ok(comp(r, "generation").score < 10);
    assert.ok(comp(r, "community").score > 90);
    assert.equal(comp(r, "land").score, NEUTRAL_SCORE);
    assert.equal(comp(r, "land").status, "unavailable");
    assert.ok(r.dataCompletenessPercent < 100);
    assert.ok(r.seriousConstraints.length >= 2); // both 220 kV+ assets 50 km or more away
  });

  test("B. Alameda-like: close to the grid, many people, nonattainment, no land data", () => {
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
        meanSlopeDeg: null,
      }),
    );
    invariants(r);
    assert.ok(comp(r, "grid").score > 90);
    assert.ok(comp(r, "generation").score > 80);
    assert.ok(comp(r, "community").score < 10);
    assert.ok(comp(r, "air").score < 100);
    assert.equal(comp(r, "land").status, "unavailable");
    assert.ok(r.considerations.some((c) => c.group === "data" && /Land suitability/.test(c.text)));
    assert.ok(r.considerations.some((c) => c.group === "community" && c.tone === "tradeoff" && /people/.test(c.text)));
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
    assert.equal(input.meanSlopeDeg, 2.1);
    assert.deepEqual(input.landFlags, [{ severity: "warn", title: "Protected land nearby" }]);
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
    for (const key of ["grid", "generation", "community", "air", "land"]) assert.equal(r.componentStatuses[key], "unavailable", key);
    assert.equal(r.dataCompletenessPercent, 10);
    assert.equal(r.completenessLabel, "Low");
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

  test("site intel that failed or is still loading leaves air and land missing", () => {
    const failed = feasibilityInput({ summary: summary(), view: view(), intel: null });
    assert.equal(failed.designations, null);
    assert.equal(failed.meanSlopeDeg, null);
    assert.equal(failed.reasons.land, "site screening unavailable");
    const pending = feasibilityInput({ summary: summary(), view: view(), intel: null, intelPending: true });
    assert.equal(pending.reasons.air, "site screening still loading");
  });

  test("no land screening outside the demo areas says why", () => {
    const input = feasibilityInput({ summary: summary(), view: view(), intel: intel({ mean_slope_deg: null }, { land_tier: "unavailable" }) });
    assert.match(input.reasons.land, /demo areas or Earth Engine/);
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

  test("without a site summary every summary-based input is unknown", () => {
    const input = feasibilityInput({ summary: null, view: null, intel: intel() });
    assert.equal(input.substation, null);
    assert.equal(input.generation, null);
    assert.deepEqual(input.utility, UNKNOWN);
    assert.equal(input.reasons.grid, "site summary not loaded");
    invariants(calculateFeasibilityScore(input));
  });
});
