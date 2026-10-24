"use client";
// Which scale the header shows: the project workspace (Industrial / Community, the map) or Griddy Home.
// Remembered in localStorage "griddy:scale"; every storage access is wrapped, so a private window or
// blocked storage just starts on the project workspace. Server render / hydration sees "project".
// OWNER: household (frontend).
import { useSyncExternalStore } from "react";

export type Scale = "project" | "home";
export const SCALE_KEY = "griddy:scale";

let current: Scale | null = null;
const listeners = new Set<() => void>();

function read(): Scale {
  try {
    return localStorage.getItem(SCALE_KEY) === "home" ? "home" : "project";
  } catch {
    return "project";
  }
}

const snapshot = (): Scale => (current ??= read());

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function setScale(s: Scale): void {
  if (snapshot() === s) return;
  current = s;
  try {
    localStorage.setItem(SCALE_KEY, s);
  } catch {
    /* still switches for this page view */
  }
  for (const l of listeners) l();
}

export function useScale(): Scale {
  return useSyncExternalStore(subscribe, snapshot, () => "project");
}
