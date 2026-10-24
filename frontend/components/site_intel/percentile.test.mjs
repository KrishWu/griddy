// Tests for the GriddyGrade percentile (percentile.ts, gradePercentiles.json) and Griddy's
// California-only placement region (region.ts, caOutline.json).  OWNER: workstream E.
// Run from frontend/:  node --test components/site_intel/percentile.test.mjs   (Node >= 22.18)
// backend/tests/test_site_intel_feasibility.py runs it inside pytest.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import outline from "./caOutline.json" with { type: "json" };
import { POLICY_TECHNOLOGIES, POWER_PLANT_POLICY } from "./feasibilityPolicy.ts";
import table from "./gradePercentiles.json" with { type: "json" };
import { cutoffsFor, displayPercentile, percentileAt, percentileFor } from "./percentile.ts";
import { inRegion } from "./region.ts";

const LINEAR = Array.from({ length: 101 }, (_, k) => k / 2); // 0, 0.5, ... 50
const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
const TIERS = POWER_PLANT_POLICY.grid.tiers.map((t) => t.minKv);

describe("percentileFor", () => {
  test("interpolates between cut-offs and clamps outside them", () => {
    close(percentileFor(25, LINEAR), 50);
    close(percentileFor(10.25, LINEAR), 20.5);
    assert.equal(percentileFor(-5, LINEAR), 0);
    assert.equal(percentileFor(80, LINEAR), 100);
  });

  test("a tied score gets the middle of its range, not the top or bottom", () => {
    // 30 reference sites tied at a neutral 50: cut-offs 20..49 all equal 50.
    const tied = LINEAR.map((v, k) => (k >= 20 && k <= 49 ? 50 : k < 20 ? v : 50 + (k - 49)));
    close(percentileFor(50, tied), (20 + 49) / 2);
    assert.ok(percentileFor(49.9, tied) < 20);
    assert.ok(percentileFor(50.1, tied) > 49);
  });

  test("never falls as the raw score rises", () => {
    for (const byTier of Object.values(table.technologies)) {
      for (const { cutoffs: cut } of Object.values(byTier)) {
        let prev = -Infinity;
        for (let raw = 0; raw <= 100; raw += 0.25) {
          const p = percentileFor(raw, cut);
          assert.ok(p >= 0 && p <= 100, `p ${p}`);
          assert.ok(p >= prev - 1e-9, `raw ${raw}: ${p} < ${prev}`);
          prev = p;
        }
      }
    }
  });

  test("non-finite input is not a percentile", () => {
    assert.ok(Number.isNaN(percentileFor(Number.NaN, LINEAR)));
    assert.ok(Number.isNaN(percentileFor(10, [1])));
  });
});

describe("percentileAt and display", () => {
  const t = { technologies: { solar_pv: { 115: { count: 10, cutoffs: LINEAR } } } };

  test("ranks within the technology and voltage tier", () => {
    close(percentileAt(25, "solar_pv", 115, t), 50);
  });

  test("an untabulated technology or tier has no percentile", () => {
    assert.ok(Number.isNaN(percentileAt(25, "solar_pv", 220, t)));
    assert.ok(Number.isNaN(percentileAt(25, "fusion", 115, t)));
    assert.equal(cutoffsFor("solar_pv", 69, t), null);
  });

  test("shows the percentile to the nearest tenth, from 0.1 to 99.9", () => {
    assert.equal(displayPercentile(0), 0.1);
    assert.equal(displayPercentile(100), 99.9);
    assert.equal(displayPercentile(86.64), 86.6);
    assert.equal(displayPercentile(86.66), 86.7);
    assert.equal(displayPercentile(52), 52);
  });
});

describe("the shipped cut-off table", () => {
  test("matches the scoring policy version", () => {
    assert.equal(table.policy_version, POWER_PLANT_POLICY.version);
  });

  test("101 ascending cut-offs for every technology and tier, from enough plausible sites", () => {
    for (const tech of POLICY_TECHNOLOGIES) {
      for (const kv of TIERS) {
        const c = cutoffsFor(tech, kv, table);
        assert.ok(c, `${tech} ${kv} kV`);
        assert.ok(c.count >= 1000 && c.count <= table.cells_scored, `count ${c.count}`);
        assert.equal(c.cutoffs.length, 101);
        c.cutoffs.forEach((v, k) => {
          assert.ok(v >= 0 && v <= 100);
          if (k) assert.ok(v >= c.cutoffs[k - 1]);
        });
      }
    }
    assert.match(table.reference, /utility service territory/);
    assert.match(table.reference, /voltage-search threshold/);
  });

  test("a technology without a supported resource method doesn't spread on R", () => {
    // Geothermal, hydro and nuclear have R = E = 50 everywhere, so they rank on G, C and I alone.
    for (const kv of TIERS) assert.deepEqual(cutoffsFor("geothermal", kv, table).cutoffs, cutoffsFor("nuclear", kv, table).cutoffs);
  });
});

describe("Griddy's region (California only, for now)", () => {
  const inside = {
    "Bakersfield (Kern demo site)": { lon: -119.02, lat: 35.43 },
    "San Francisco": { lon: -122.42, lat: 37.77 },
    "Los Angeles": { lon: -118.24, lat: 34.05 },
    "San Diego": { lon: -117.16, lat: 32.72 },
    "Crescent City": { lon: -124.2, lat: 41.76 },
    "Tahoe City": { lon: -120.14, lat: 39.17 },
    "Santa Monica beach (coastal margin)": { lon: -118.497, lat: 34.007 },
  };
  const outside = {
    "Las Vegas, NV": { lon: -115.14, lat: 36.17 },
    "Reno, NV": { lon: -119.81, lat: 39.53 },
    "Phoenix, AZ": { lon: -112.07, lat: 33.45 },
    "Tijuana, MX": { lon: -117.03, lat: 32.5 },
    "Stateline, NV (1.6 km over the line)": { lon: -119.9, lat: 38.95 },
    "Yuma, AZ (1.6 km over the Colorado River)": { lon: -114.6, lat: 32.72 },
    "0.7 km into Oregon": { lon: -123.0, lat: 42.01 },
    "Medford, OR": { lon: -122.87, lat: 42.33 },
    "50 km off Monterey": { lon: -122.5, lat: 36.6 },
    "Far Pacific": { lon: -130, lat: 35 },
  };

  for (const [name, p] of Object.entries(inside)) test(`allows ${name}`, () => assert.equal(inRegion(p, outline), true));
  for (const [name, p] of Object.entries(outside)) test(`refuses ${name}`, () => assert.equal(inRegion(p, outline), false));

  test("refuses non-finite coordinates", () => {
    assert.equal(inRegion({ lon: Number.NaN, lat: 36 }, outline), false);
    assert.equal(inRegion({ lon: -120, lat: Number.POSITIVE_INFINITY }, outline), false);
  });

  test("the outline is small: a few hundred vertices", () => {
    const n = outline.rings.reduce((a, r) => a + r.length, 0);
    assert.ok(n > 100 && n < 5000, `${n} vertices`);
    assert.equal(outline.buffer_km, 2);
  });
});
