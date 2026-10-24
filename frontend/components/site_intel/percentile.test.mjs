// Tests for the GriddyGrade percentile (percentile.ts, gradePercentiles.json) and Griddy's
// California-only placement region (region.ts, caOutline.json).  OWNER: workstream E.
// Run from frontend/:  node --test components/site_intel/percentile.test.mjs   (Node >= 22.18)
// backend/tests/test_site_intel_feasibility.py runs it inside pytest.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import outline from "./caOutline.json" with { type: "json" };
import table from "./gradePercentiles.json" with { type: "json" };
import { displayPercentile, percentileAt, percentileFor } from "./percentile.ts";
import { inRegion } from "./region.ts";

const LINEAR = Array.from({ length: 101 }, (_, k) => k / 2); // 0, 0.5, ... 50
const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

describe("percentileFor", () => {
  test("interpolates between cut-offs and clamps outside them", () => {
    close(percentileFor(25, LINEAR), 50);
    close(percentileFor(10.25, LINEAR), 20.5);
    assert.equal(percentileFor(-5, LINEAR), 0);
    assert.equal(percentileFor(80, LINEAR), 100);
  });

  test("a tied score gets the middle of its range, not the top or bottom", () => {
    // 30 reference sites capped at 35: cut-offs 20..49 all equal 35.
    const tied = LINEAR.map((v, k) => (k >= 20 && k <= 49 ? 35 : k < 20 ? v : 35 + (k - 49)));
    close(percentileFor(35, tied), (20 + 49) / 2);
    assert.ok(percentileFor(34.9, tied) < 20);
    assert.ok(percentileFor(35.1, tied) > 49);
  });

  test("never falls as the raw grade rises", () => {
    for (const cut of table.cutoffs) {
      let prev = -Infinity;
      for (let raw = 0; raw <= 100; raw += 0.25) {
        const p = percentileFor(raw, cut);
        assert.ok(p >= 0 && p <= 100, `p ${p}`);
        assert.ok(p >= prev - 1e-9, `raw ${raw}: ${p} < ${prev}`);
        prev = p;
      }
    }
  });

  test("non-finite input is not a percentile", () => {
    assert.ok(Number.isNaN(percentileFor(Number.NaN, LINEAR)));
    assert.ok(Number.isNaN(percentileFor(10, [1])));
  });
});

describe("percentileAt and display", () => {
  const t = { loads_mw: [50, 200], cutoffs: [LINEAR, LINEAR.map((v) => v / 2)] };

  test("uses the tabulated load exactly and clamps outside the range", () => {
    close(percentileAt(25, 50, t), 50);
    close(percentileAt(25, 200, t), 100);
    close(percentileAt(25, 10, t), 50);
    close(percentileAt(25, 5000, t), 100);
  });

  test("interpolates between loads on a log scale", () => {
    close(percentileAt(20, 100, t), 40 + 0.5 * (80 - 40)); // 100 MW is halfway from 50 to 200 in log terms
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
  test("101 ascending cut-offs per ascending load, from enough plausible sites", () => {
    assert.ok(table.count >= 1000, `count ${table.count}`);
    assert.ok(table.count <= table.cells_scored);
    assert.ok(table.loads_mw.includes(100));
    assert.equal(table.cutoffs.length, table.loads_mw.length);
    table.loads_mw.forEach((l, i) => i && assert.ok(l > table.loads_mw[i - 1]));
    for (const cut of table.cutoffs) {
      assert.equal(cut.length, 101);
      cut.forEach((v, k) => {
        assert.ok(v >= 0 && v <= 100);
        if (k) assert.ok(v >= cut[k - 1]);
      });
    }
    assert.match(table.reference, /220 kV\+ line/);
    assert.match(table.reference, /utility service territory/);
  });

  test("a larger load never makes the same raw grade rank lower", () => {
    // The capacity term needs 5 x the load, so at a bigger load the reference grades fall.
    for (const raw of [30, 45, 60, 75]) {
      let prev = -Infinity;
      for (const load of table.loads_mw) {
        const p = percentileAt(raw, load, table);
        assert.ok(p >= prev - 1e-9, `raw ${raw} at ${load} MW`);
        prev = p;
      }
    }
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
