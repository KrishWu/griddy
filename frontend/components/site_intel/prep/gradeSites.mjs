// Grades a list of sites, each for its own technology and capacity, with the live GriddyGrade code.
// OWNER: workstream E (Site Intelligence).
// Run by backend/app/site_intel/prep/check_recommended.py (it builds the input file):
//   node components/site_intel/prep/gradeSites.mjs <sites.jsonl>
// Each input line is {id, technology, capacityMw, summary, intel}; prints one JSON array to stdout.
import { readFileSync } from "node:fs";
import { register } from "node:module";

register("./aliasHooks.mjs", import.meta.url);
const { readSummary } = await import("@/components/explore/useSiteSummary");
const { feasibilityInput } = await import("../feasibilityInput.ts");
const { calculatePowerPlantFeasibility } = await import("../feasibility.ts");
const { POWER_PLANT_POLICY: policy } = await import("../feasibilityPolicy.ts");
const { displayPercentile, percentileAt } = await import("../percentile.ts");
const table = JSON.parse(readFileSync(new URL("../gradePercentiles.json", import.meta.url), "utf-8"));

const [, , inPath] = process.argv;
if (!inPath) throw new Error("usage: gradeSites.mjs <sites.jsonl>");

const out = [];
for (const line of readFileSync(inPath, "utf-8").split("\n")) {
  if (!line.trim()) continue;
  const { id, technology, capacityMw, summary, intel } = JSON.parse(line);
  const site = feasibilityInput({ summary, view: readSummary(summary), intel });
  const r = calculatePowerPlantFeasibility(site, { technology, capacityMw }, policy);
  if (!r.valid) {
    out.push({ id, technology, capacityMw, valid: false, errors: r.errors });
    continue;
  }
  const p = percentileAt(r.overallScoreRaw, technology, r.voltageTier.minKv, table);
  out.push({
    id,
    technology,
    capacityMw,
    valid: true,
    score: r.overallScore,
    raw: r.overallScoreRaw,
    percentile: Number.isFinite(p) ? displayPercentile(p) : null,
    category: r.category,
    headline: r.headline,
    tierKv: r.voltageTier.minKv,
    completeness: r.dataCompletenessPercent,
    completenessLabel: r.completenessLabel,
    constraints: r.constraints.assessment,
    components: Object.fromEntries(r.components.map((c) => [c.key, { score: Math.round(c.score * 10) / 10, status: c.status }])),
  });
}
process.stdout.write(JSON.stringify(out) + "\n");
