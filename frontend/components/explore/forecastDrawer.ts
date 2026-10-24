"use client";
// Open/closed state of the map's "Forecast & sites" drawer, so the Site panel's "Open forecast" link
// (or any other module) can open it.  OWNER: workstream A.
import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (next === open) return;
  open = next;
  for (const l of listeners) l();
}

/** Subscribe to open/close changes; returns the unsubscribe function. */
export function subscribeForecastDrawer(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const isForecastDrawerOpen = (): boolean => open;
export const openForecastDrawer = (): void => set(true);
export const closeForecastDrawer = (): void => set(false);
export const toggleForecastDrawer = (): void => set(!open);

export function useForecastDrawer(): boolean {
  return useSyncExternalStore(subscribeForecastDrawer, isForecastDrawerOpen, () => false);
}
