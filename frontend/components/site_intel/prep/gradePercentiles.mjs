// Scores every reference cell with the live GriddyGrade code and writes the percentile cut-offs.
// OWNER: workstream E (Site Intelligence).
// Run by backend/app/site_intel/prep/grade_percentiles.py (it builds the input file):
//   node components/site_intel/prep/gradePercentiles.mjs <reference.jsonl.gz> <out.json> [meta JSON]
// Each input line is {cell, summary, intel}: A's site summary and E's site intel for one 5 km cell.
// Cut-offs are tabulated per technology and voltage-search tier: capacity only changes the score
// through the tier, so one representative capacity per tier stands for all of it.
import { createReadStream, writeFileSync } from "node:fs";
import { register } from "node:module";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

register("./aliasHooks.mjs", import.meta.url);
const { readSummary } = await import("@/components/explore/useSiteSummary");
const { feasibilityInput } = await import("../feasibilityInput.ts");
const { calculatePowerPlantFeasibility } = await import("../feasibility.ts");
const { POWER_PLANT_POLICY: policy, POLICY_TECHNOLOGIES } = await import("../feasibilityPolicy.ts");

const tiers = policy.grid.tiers.map((t, i) => {
  const lo = i > 0 ? policy.grid.tiers[i - 1].maxMw : 0;
  return { kv: t.minKv, capacityMw: Number.isFinite(t.maxMw) ? (lo + t.maxMw) / 2 : 2 * lo };
});
const PLAUSIBLE_LINE_KM = policy.grid.zeroKm;
const REFERENCE = `5 km cells of California inside a utility service territory and within ${PLAUSIBLE_LINE_KM} km of an operational AC line at the project's voltage-search threshold`;

const [, , inPath, outPath, metaJson] = process.argv;
if (!inPath || !outPath) throw new Error("usage: gradePercentiles.mjs <reference.jsonl.gz> <out.json> [meta JSON]");
const meta = metaJson ? JSON.parse(metaJson) : {};

/** Plausible: where a plant of this size could realistically connect (the percentile ranks against these). */
function plausible(site, kv) {
  const line = site.grid[kv]?.line;
  return site.utility.state === "available" && line?.state === "available" && typeof line.value?.distanceKm === "number" && line.value.distanceKm <= PLAUSIBLE_LINE_KM;
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

const raw = Object.fromEntries(POLICY_TECHNOLOGIES.map((t) => [t, Object.fromEntries(tiers.map(({ kv }) => [kv, []]))]));
let cells = 0;
let withMl = 0;
const lines = createInterface({ input: createReadStream(inPath).pipe(createGunzip()), crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  const { summary, intel } = JSON.parse(line);
  cells++;
  const site = feasibilityInput({ summary, view: readSummary(summary), intel });
  if (site.sitingSimilarity.solar_pv?.state === "available") withMl++;
  for (const { kv, capacityMw } of tiers) {
    if (!plausible(site, kv)) continue;
    for (const technology of POLICY_TECHNOLOGIES) {
      const r = calculatePowerPlantFeasibility(site, { technology, capacityMw }, policy);
      if (!r.valid) throw new Error(r.errors.join("; "));
      if (r.voltageTier.minKv !== kv) throw new Error(`capacity ${capacityMw} MW fell in the ${r.voltageTier.minKv} kV tier, not ${kv}`);
      raw[technology][kv].push(r.overallScoreRaw);
    }
  }
}

const counts = tiers.map(({ kv }) => raw.solar_pv[kv].length);
if (Math.min(...counts) < 100) throw new Error(`only ${Math.min(...counts)} plausible cells in a tier: is the reference file complete?`);
const table = {
  generated: new Date().toISOString().slice(0, 10),
  policy_version: policy.version,
  reference: REFERENCE,
  cells_scored: cells,
  site_artifact: meta.site_artifact ?? null,
  technologies: Object.fromEntries(
    POLICY_TECHNOLOGIES.map((t) => [t, Object.fromEntries(tiers.map(({ kv }) => [String(kv), { count: raw[t][kv].length, cutoffs: cutoffs(raw[t][kv]) }]))]),
  ),
};
writeFileSync(outPath, JSON.stringify(table) + "\n");

console.log(`${cells.toLocaleString("en-US")} cells (${withMl.toLocaleString("en-US")} with model signals); plausible per tier: ${tiers.map(({ kv }, i) => `${kv} kV ${counts[i].toLocaleString("en-US")}`).join(", ")}`);
for (const t of POLICY_TECHNOLOGIES) {
  const c = table.technologies[t]["220"].cutoffs;
  console.log(`${t.padEnd(14)} 220 kV raw score: p10 ${c[10]}, p50 ${c[50]}, p90 ${c[90]}, max ${c[100]}`);
}
console.log(`wrote ${outPath}`);
