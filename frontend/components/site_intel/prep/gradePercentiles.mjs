// Scores every reference cell with the live GriddyGrade code and writes the percentile cut-offs.
// OWNER: workstream E (Site Intelligence).
// Run by backend/app/site_intel/prep/grade_percentiles.py (it builds the input file):
//   node components/site_intel/prep/gradePercentiles.mjs <reference.jsonl.gz> <out.json> [meta JSON]
// Each input line is {cell, summary, intel}: A's site summary and E's site intel for one 5 km cell.
import { createReadStream, writeFileSync } from "node:fs";
import { register } from "node:module";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

register("./aliasHooks.mjs", import.meta.url);
const { readSummary } = await import("@/components/explore/useSiteSummary");
const { feasibilityInput } = await import("../feasibilityInput.ts");
const { calculateFeasibilityScore, HV_KV } = await import("../feasibility.ts");

// Average data center loads to tabulate; percentile.ts interpolates between them on a log scale.
const LOADS_MW = [25, 50, 100, 250, 500, 1000, 2000];
const PLAUSIBLE_LINE_KM = 50;
const REFERENCE = `5 km cells of California within ${PLAUSIBLE_LINE_KM} km of a ${HV_KV} kV+ line and inside a utility service territory`;

const [, , inPath, outPath, metaJson] = process.argv;
if (!inPath || !outPath) throw new Error("usage: gradePercentiles.mjs <reference.jsonl.gz> <out.json> [meta JSON]");
const meta = metaJson ? JSON.parse(metaJson) : {};

/** Plausible: where a data center could realistically go (the percentile ranks against these). */
function plausible(input) {
  const line = input.line;
  const hv = line && (line.voltageKv === null || line.voltageKv >= HV_KV);
  return Boolean(hv && typeof line.distanceKm === "number" && line.distanceKm <= PLAUSIBLE_LINE_KM && input.utility.status === "identified");
}

/** numpy-style linear quantiles, k = 0..100. */
function cutoffs(values) {
  const v = Float64Array.from(values).sort();
  const n = v.length;
  return Array.from({ length: 101 }, (_, k) => {
    const pos = (k / 100) * (n - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(n - 1, lo + 1);
    return Math.round((v[lo] + (pos - lo) * (v[hi] - v[lo])) * 1000) / 1000;
  });
}

const raw = LOADS_MW.map(() => []);
let cells = 0;
let withMl = 0;
let forecastId = null;
const capped = LOADS_MW.map(() => 0);
const lines = createInterface({ input: createReadStream(inPath).pipe(createGunzip()), crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  const { summary, intel } = JSON.parse(line);
  cells++;
  const input = feasibilityInput({ summary, view: readSummary(summary), intel });
  if (!plausible(input)) continue;
  if (input.ml) withMl++;
  forecastId ??= intel?.extras?.ml?.forecast?.artifact_id ?? null;
  LOADS_MW.forEach((load, i) => {
    const r = calculateFeasibilityScore(input, load);
    raw[i].push(r.overallScoreRaw);
    if (r.cap) capped[i]++;
  });
}

const count = raw[0].length;
if (count < 100) throw new Error(`only ${count} plausible cells: is the reference file complete?`);
const table = {
  generated: new Date().toISOString().slice(0, 10),
  reference: REFERENCE,
  count,
  cells_scored: cells,
  site_artifact: meta.site_artifact ?? null,
  forecast_artifact: forecastId,
  loads_mw: LOADS_MW,
  cutoffs: raw.map(cutoffs),
};
writeFileSync(outPath, JSON.stringify(table) + "\n");

const at100 = table.cutoffs[LOADS_MW.indexOf(100)];
console.log(`${count.toLocaleString("en-US")} plausible of ${cells.toLocaleString("en-US")} cells (${withMl.toLocaleString("en-US")} with model signals)`);
console.log(`raw grade at 100 MW: p10 ${at100[10]}, p25 ${at100[25]}, p50 ${at100[50]}, p75 ${at100[75]}, p90 ${at100[90]}, max ${at100[100]}`);
console.log(`capped at 100 MW: ${((100 * capped[LOADS_MW.indexOf(100)]) / count).toFixed(1)}% of plausible cells`);
console.log(`wrote ${outPath}`);
