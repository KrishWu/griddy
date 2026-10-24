"use client";
// Which tab each sidebar shows, as a tiny external store, so the map (a site click opens "Site") or
// any panel can switch tabs without prop drilling. Remembered per sidebar (and per Basic/Advanced
// for the right one, whose tabs differ) in localStorage "griddy:tabs".  OWNER: workstream D (shell).
import { useSyncExternalStore } from "react";

import { getSettings } from "@/lib/settings";

export type LeftTab = "plan" | "site" | "layers" | "build";
export type RightTab = "summary" | "simulate" | "costs" | "stress" | "report";
/** "right" = the Advanced right sidebar; Basic has a single Summary tab. */
type Slot = "left" | "right";

const KEY = "griddy:tabs";
// A first visit opens on Site, so the GriddyGrade is the first thing on screen; saved choices still win.
const DEFAULTS: Record<Slot, string> = { left: "site", right: "simulate" };

let tabs: Record<Slot, string> | null = null;
const listeners = new Set<() => void>();

function load(): Record<Slot, string> {
  if (tabs) return tabs;
  tabs = { ...DEFAULTS };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Record<Slot, unknown>> | null;
    for (const slot of ["left", "right"] as const) if (typeof raw?.[slot] === "string") tabs[slot] = raw[slot] as string;
  } catch {
    /* defaults */
  }
  return tabs;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function setTab(slot: Slot, tab: string): void {
  const cur = load();
  if (cur[slot] === tab) return;
  tabs = { ...cur, [slot]: tab };
  try {
    localStorage.setItem(KEY, JSON.stringify(tabs));
  } catch {
    /* still switches for this page view */
  }
  for (const l of listeners) l();
}

/** Switch the left sidebar (Plan / Site / Layers / Build). A collapsed sidebar stays collapsed. */
export const showLeftTab = (tab: LeftTab): void => setTab("left", tab);

/** Tailwind's lg breakpoint: from here the sidebars sit beside the map instead of above and below it. */
const SIDE_BY_SIDE = "(min-width: 64rem)";

/** Switch the left sidebar in answer to a click on the map (a picked site opens Site, a highlighted
 *  area Plan), unless that would move the map. Stacked below lg, an open left sidebar sits above the
 *  map, and Site is far taller than Plan (and grows again as its data loads), so the switch would
 *  scroll the map and the spot just tapped off-screen. There the tab stays as it was, one tap away
 *  at the top. A folded sidebar shows only its tab strip, so switching it moves nothing. */
export function showLeftTabFromMap(tab: LeftTab): void {
  let besideMap = true;
  try {
    besideMap = window.matchMedia(SIDE_BY_SIDE).matches;
  } catch {
    /* no matchMedia: assume a desktop layout */
  }
  if (besideMap || getSettings().leftCollapsed) setTab("left", tab);
}

/** Switch the Advanced right sidebar (Simulate / Costs / Stress / Report). */
export const showRightTab = (tab: Exclude<RightTab, "summary">): void => setTab("right", tab);

export function useSidebarTab(slot: Slot): string {
  return useSyncExternalStore(subscribe, () => load()[slot], () => DEFAULTS[slot]);
}

export function selectSidebarTab(slot: Slot, tab: string): void {
  setTab(slot, tab);
}
