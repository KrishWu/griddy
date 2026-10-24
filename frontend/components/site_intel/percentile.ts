// The GriddyGrade as a percentile: where the site's raw score falls among plausible California
// sites scored with the same code for the same technology and voltage-search tier.
// OWNER: workstream E (Site Intelligence).
//
// gradePercentiles.json holds 101 cut-offs (the 0th..100th percentile of the raw score) per
// technology and tier, made offline by backend/app/site_intel/prep/grade_percentiles.py, which runs
// feasibilityInput.ts + feasibility.ts in Node on every reference cell, so the percentile can't
// drift from the live score. Pure, with no value imports, so Node runs it as-is in the tests.

export interface PercentileCutoffs {
  /** Number of reference sites. */
  count: number;
  /** 101 ascending raw scores: the 0th..100th percentile. */
  cutoffs: number[];
}

export interface PercentileTable {
  generated: string;
  /** Scoring policy the cut-offs were computed with. */
  policy_version: string;
  /** What the sites are ranked against, in words. */
  reference: string;
  cells_scored: number;
  site_artifact: string | null;
  /** technology -> voltage-search tier (minimum kV, as a string) -> cut-offs. */
  technologies: Record<string, Record<string, PercentileCutoffs>>;
}

const EPS = 1e-6;

/**
 * Percentile (0-100) of a raw score within 101 ascending cut-offs. Between two cut-offs it
 * interpolates; on a value many cut-offs share (neutral and saturated scores tie), it returns the
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

/** The reference cut-offs for a technology and tier, or null when none were tabulated. */
export function cutoffsFor(technology: string, tierKv: number, table: PercentileTable): PercentileCutoffs | null {
  const c = table.technologies?.[technology]?.[String(tierKv)];
  return c && Array.isArray(c.cutoffs) && c.cutoffs.length >= 2 ? c : null;
}

/** Percentile among reference sites for the same technology and tier; NaN when there is no table for them. */
export function percentileAt(raw: number, technology: string, tierKv: number, table: PercentileTable): number {
  const c = cutoffsFor(technology, tierKv, table);
  return c ? percentileFor(raw, c.cutoffs) : Number.NaN;
}

/** The displayed percentile, to the nearest tenth from 0.1 to 99.9 (no site is "0th" or "100th" of a sample). */
export function displayPercentile(p: number): number {
  return Math.min(99.9, Math.max(0.1, Math.round(p * 10) / 10));
}
