// The GriddyGrade as a percentile: where the site's raw grade falls among plausible California
// sites scored with the same code.  OWNER: workstream E (Site Intelligence).
//
// gradePercentiles.json holds 101 cut-offs (the 0th..100th percentile of the raw grade) per
// tabulated load, made offline by backend/app/site_intel/prep/grade_percentiles.py, which runs
// feasibilityInput.ts + feasibility.ts in Node on every reference cell, so the percentile can't
// drift from the live grade. Pure, with no value imports, so Node runs it as-is in the tests.

export interface PercentileTable {
  /** Average data center loads the cut-offs were computed for, ascending. */
  loads_mw: number[];
  /** cutoffs[i] = 101 ascending raw grades (0th..100th percentile) at loads_mw[i]. */
  cutoffs: number[][];
  /** Number of reference sites. */
  count: number;
  /** What the sites are ranked against, in words. */
  reference: string;
  generated: string;
  site_artifact: string | null;
  forecast_artifact: string | null;
}

const EPS = 1e-6;

/**
 * Percentile (0-100) of a raw grade within 101 ascending cut-offs. Between two cut-offs it
 * interpolates; on a value many cut-offs share (the cap and saturated scores tie), it returns the
 * middle of that range, so a tie never reads as the best or the worst of the group.
 */
export function percentileFor(raw: number, cutoffs: number[]): number {
  const n = cutoffs.length;
  if (n < 2 || !Number.isFinite(raw)) return Number.NaN;
  const last = n - 1;
  const scale = 100 / last;
  let lo = 0;
  while (lo < n && cutoffs[lo] < raw - EPS) lo++; // first cut-off >= raw
  let hi = last;
  while (hi >= 0 && cutoffs[hi] > raw + EPS) hi--; // last cut-off <= raw
  if (lo <= hi) return ((lo + hi) / 2) * scale; // raw equals one or more cut-offs
  if (lo === 0) return 0; // below every reference site
  if (hi === last) return 100; // above every reference site
  const a = cutoffs[hi];
  const b = cutoffs[lo];
  return (hi + (raw - a) / (b - a)) * scale;
}

/** Percentile at any load: the two nearest tabulated loads, interpolated on a log scale (clamped at the ends). */
export function percentileAt(raw: number, loadMw: number, table: PercentileTable): number {
  const loads = table.loads_mw;
  if (!loads.length || loads.length !== table.cutoffs.length) return Number.NaN;
  const at = (i: number) => percentileFor(raw, table.cutoffs[i]);
  if (!(loadMw > loads[0])) return at(0);
  if (loadMw >= loads[loads.length - 1]) return at(loads.length - 1);
  const j = loads.findIndex((l) => l >= loadMw);
  const t = (Math.log(loadMw) - Math.log(loads[j - 1])) / (Math.log(loads[j]) - Math.log(loads[j - 1]));
  return at(j - 1) + t * (at(j) - at(j - 1));
}

/** The displayed percentile, to the nearest tenth from 0.1 to 99.9 (no site is "0th" or "100th" of a sample). */
export function displayPercentile(p: number): number {
  return Math.min(99.9, Math.max(0.1, Math.round(p * 10) / 10));
}
