"use client";
// Keeps data centers inside Griddy's region (California, for now): the store's selectSite asks
// allowSitePlacement() before moving the site, and GriddyGradeCard shows why a click was
// refused.  OWNER: workstream E (Site Intelligence).
import { useSyncExternalStore } from "react";

import type { LngLat } from "@/lib/contract";

import outline from "./caOutline.json";
import { inRegion, type RegionOutline } from "./region";

const OUTLINE = outline as RegionOutline;

// The last refused point, in a tiny module store so the notice survives panels remounting.
let refused: LngLat | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

/** True when a data center may be placed here; otherwise records the point for the notice. */
export function allowSitePlacement(p: LngLat): boolean {
  const ok = inRegion(p, OUTLINE);
  const next = ok ? null : p;
  if (next !== refused) {
    refused = next;
    emit();
  }
  return ok;
}

export function dismissRegionNotice(): void {
  if (refused === null) return;
  refused = null;
  emit();
}

/** The point of the last refused placement, until the next accepted one or a dismiss. */
export function useRefusedPlacement(): LngLat | null {
  return useSyncExternalStore(subscribe, () => refused, () => null);
}
