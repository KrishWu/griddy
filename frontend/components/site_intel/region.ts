// Griddy's service region: California plus a 2 km coastal margin.  OWNER: workstream E.
// Pure, with no value imports, so Node runs it as-is in the tests; regionGuard.ts pairs it with
// the outline (caOutline.json, made by backend/app/site_intel/prep/region.py).
import type { LngLat } from "@/lib/contract";

export interface RegionOutline {
  /** Outer rings of [lon, lat] pairs, closed. */
  rings: number[][][];
  buffer_km: number;
}

/** Even-odd ray casting: true when the point is inside the ring. */
function inRing(p: LngLat, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p.lat !== yj > p.lat && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside California (or within the coastal margin). Non-finite coordinates are outside. */
export function inRegion(p: LngLat, outline: RegionOutline): boolean {
  if (!Number.isFinite(p.lon) || !Number.isFinite(p.lat)) return false;
  return outline.rings.some((r) => inRing(p, r));
}
