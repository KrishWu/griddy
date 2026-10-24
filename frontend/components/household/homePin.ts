"use client";
// Griddy Home's shared bits that live outside React context, so the map (MapView) and the shell
// (AppShell) can read them without prop drilling:
// - the house pin (where the viewer clicked, searched or located themselves on the map), remembered
//   in localStorage "griddy:home-pin";
// - which tab each sidebar shows in Home mode, remembered in "griddy:home-tabs".
// Every storage access is wrapped: a private window or blocked storage just starts without them.
// OWNER: household (frontend).
import { useSyncExternalStore } from "react";

export interface HomePin {
  lat: number;
  lon: number;
}

const PIN_KEY = "griddy:home-pin";
const TABS_KEY = "griddy:home-tabs";

const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

let pin: HomePin | null | undefined;
function readPin(): HomePin | null {
  if (pin !== undefined) return pin;
  pin = null;
  try {
    const raw = JSON.parse(localStorage.getItem(PIN_KEY) ?? "null") as Partial<HomePin> | null;
    if (raw && finite(raw.lat) && finite(raw.lon) && Math.abs(raw.lat) <= 90 && Math.abs(raw.lon) <= 180) pin = { lat: raw.lat, lon: raw.lon };
  } catch {
    /* no remembered pin */
  }
  return pin;
}

/** Place (or clear, with null) the house pin. Rounded to ~10 m: enough for a house, stable cache keys. */
export function setHomePin(p: HomePin | null): void {
  const next = p && finite(p.lat) && finite(p.lon) ? { lat: Math.round(p.lat * 1e4) / 1e4, lon: Math.round(p.lon * 1e4) / 1e4 } : null;
  const cur = readPin();
  if (cur?.lat === next?.lat && cur?.lon === next?.lon) return;
  pin = next;
  try {
    if (next) localStorage.setItem(PIN_KEY, JSON.stringify(next));
    else localStorage.removeItem(PIN_KEY);
  } catch {
    /* still placed for this page view */
  }
  emit();
}

export function useHomePin(): HomePin | null {
  return useSyncExternalStore(subscribe, readPin, () => null);
}

export type HomeSide = "left" | "right";
const TAB_DEFAULTS: Record<HomeSide, string> = { left: "home", right: "usage" };
let tabs: Record<HomeSide, string> | null = null;
function readTabs(): Record<HomeSide, string> {
  if (tabs) return tabs;
  tabs = { ...TAB_DEFAULTS };
  try {
    const raw = JSON.parse(localStorage.getItem(TABS_KEY) ?? "null") as Partial<Record<HomeSide, unknown>> | null;
    for (const s of ["left", "right"] as const) if (typeof raw?.[s] === "string") tabs[s] = raw[s] as string;
  } catch {
    /* defaults */
  }
  return tabs;
}

export function selectHomeTab(side: HomeSide, id: string): void {
  const cur = readTabs();
  if (cur[side] === id) return;
  tabs = { ...cur, [side]: id };
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(tabs));
  } catch {
    /* still switches for this page view */
  }
  emit();
}

export function useHomeTab(side: HomeSide): string {
  return useSyncExternalStore(subscribe, () => readTabs()[side], () => TAB_DEFAULTS[side]);
}
